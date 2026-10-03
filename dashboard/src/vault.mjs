// 로그인 토큰·Google 키 같은 비밀을 이 PC 의 현재 Windows 사용자만 풀 수 있게(DPAPI) 암호화해 파일에 보관한다.
// 화면(브라우저)에는 비밀을 절대 내보내지 않는다. 테스트에서는 암호화 함수를 바꿔 끼울 수 있다.
import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {execFile} from 'node:child_process';

const PS_SCRIPT=mode=>`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;`
  +`$in=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($in);`
  +`$o=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);`
  +`[Console]::Out.Write([Convert]::ToBase64String($o))`;

function runPowerShell(mode,input){
  return new Promise((resolve,reject)=>{
    const script=Buffer.from(PS_SCRIPT(mode),'utf16le').toString('base64');
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',script],{windowsHide:true,timeout:20000,maxBuffer:4*1024*1024},(error,stdout)=>{
      if(error)reject(new Error('이 PC의 보안 저장소(DPAPI)를 사용하지 못했습니다.'));else resolve(Buffer.from(stdout.trim(),'base64'));
    });
    child.stdin.end(Buffer.from(input).toString('base64'));
  });
}
export const dpapi={
  protect:buffer=>runPowerShell('Protect',buffer),
  unprotect:buffer=>runPowerShell('Unprotect',buffer),
};
// 암호화를 하지 않는 저장소(자동 시험 전용). 실제 서버는 항상 dpapi 를 쓴다.
export const plain={protect:async b=>Buffer.from(b),unprotect:async b=>Buffer.from(b)};

export function createVault(file,crypto=dpapi){
  let cache;
  return {
    async read(){
      if(cache!==undefined)return structuredClone(cache);
      try{cache=JSON.parse((await crypto.unprotect(Buffer.from(await readFile(file,'utf8'),'base64'))).toString('utf8'));}
      catch(error){
        if(error?.code==='ENOENT')cache={};
        else throw new Error('보관된 연결 정보를 읽지 못했습니다. 다시 연결해 주세요.');
      }
      return structuredClone(cache);
    },
    async update(patch){
      const next={...(await this.read()),...patch};
      for(const key of Object.keys(next))if(next[key]===undefined)delete next[key];
      await mkdir(dirname(file),{recursive:true});
      const sealed=(await crypto.protect(Buffer.from(JSON.stringify(next),'utf8'))).toString('base64');
      const temp=file+'.'+process.pid+'.tmp';
      await writeFile(temp,sealed,{mode:0o600});await rename(temp,file);
      cache=next;return structuredClone(next);
    },
    async clear(){cache={};await rm(file,{force:true});},
  };
}
