import {mkdir,lstat,chmod} from 'node:fs/promises';
import {resolve,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {FileServerError} from './files.mjs';
const secured=new Map();
export function ensurePrivateDirectory(directory){
  const path=resolve(directory);
  if(path===parse(path).root)throw new FileServerError(500,'서버 저장 위치가 올바르지 않습니다.');
  if(secured.has(path))return secured.get(path);
  const pending=(async()=>{
    await mkdir(path,{recursive:true});if((await lstat(path)).isSymbolicLink())throw new FileServerError(500,'서버 저장 위치에 연결된 폴더를 사용할 수 없습니다.');
    if(process.platform!=='win32'){await chmod(path,0o700);return;}
    await new Promise((done,reject)=>{
      const helper=fileURLToPath(new URL('./protect-directory.ps1',import.meta.url));
      const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,timeout:15000,maxBuffer:4096},error=>error?reject(new FileServerError(503,'서버 설정 폴더의 접근 권한을 보호하지 못했습니다.')):done());
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({path}));
    });
  })();secured.set(path,pending);pending.catch(()=>secured.delete(path));return pending;
}
