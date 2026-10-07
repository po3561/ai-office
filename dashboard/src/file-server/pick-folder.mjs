// 이 PC 화면에 Windows 폴더 선택 창을 띄워 사용자가 고른 경로를 돌려준다. 취소하면 null.
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FileServerError} from './files.mjs';

export function pickFolderNative({timeoutMs=5*60*1000}={}){
  if(process.platform!=='win32')return Promise.reject(new FileServerError(501,'폴더 선택 창은 Windows에서만 지원합니다.'));
  const helper=fileURLToPath(new URL('./pick-folder.ps1',import.meta.url));
  return new Promise((resolve,reject)=>{
    execFile('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,timeout:timeoutMs,maxBuffer:65536},(error,stdout)=>{
      if(error)return reject(new FileServerError(error.killed?408:503,error.killed?'폴더 선택 시간이 지났습니다. 다시 눌러 주세요.':'폴더 선택 창을 열지 못했습니다.'));
      const text=String(stdout).trim();
      resolve(text?Buffer.from(text,'base64').toString('utf8'):null);
    });
  });
}
