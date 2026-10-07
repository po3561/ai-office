import {lstat,realpath,readdir,open} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve,parse,relative,join,sep,basename,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';

const rules=JSON.parse(readFileSync(new URL('./rules.json',import.meta.url),'utf8'));
export class FileServerError extends Error{constructor(status,message){super(message);this.status=status;}}
const deny=()=>new FileServerError(403,'공유가 허용되지 않은 위치 또는 파일입니다.');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export function unsafeName(name){
  return ['NFC','NFD','NFKC'].some(form=>{
    const n=name.normalize(form).toLowerCase();
    return !n||n.startsWith('.')||/[. ]$|[\x00-\x1f\x7f<>:"|?*\\/]|%[0-9a-f]{2}|~\d/u.test(n)
      ||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(n)
      ||rules.sensitiveKeywords.some(k=>n.includes(k))||rules.denyExt.includes(extname(n).slice(1))
      ||rules.protectedFolders.includes(n);
  });
}
export function relativeParts(raw=''){
  if(typeof raw!=='string'||raw.length>1500||raw.includes('\\')||raw.startsWith('/')||raw.endsWith('/')||raw.includes('//'))throw deny();
  const parts=raw?raw.split('/'):[];if(parts.some(unsafeName))throw deny();return parts;
}
async function noLinks(path){
  const absolute=resolve(path),parsed=parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)){
    cursor=join(cursor,part);const s=await lstat(cursor,{bigint:true});if(s.isSymbolicLink())throw deny();
  }
  const canonical=await realpath(absolute);if(!same(absolute,canonical))throw deny();return canonical;
}
async function rootIdentity(path){
  if(typeof path!=='string'||path.length>1500||!parse(path).root||path.startsWith('\\\\'))throw deny();
  const root=resolve(path);if(same(root,parse(root).root))throw new FileServerError(400,'드라이브 전체 대신 공유할 하위 폴더를 선택해 주세요.');
  // Parent temp/home folders are acceptable; system and hidden credential roots are not.
  const segments=root.slice(parse(root).root.length).split(sep);
  if(segments.some(x=>x.startsWith('.')||rules.protectedFolders.includes(x.normalize('NFKC').toLowerCase())||rules.sensitiveKeywords.some(k=>x.normalize('NFKC').toLowerCase().includes(k))))throw deny();
  await noLinks(root);const s=await lstat(root,{bigint:true});if(!s.isDirectory())throw new FileServerError(400,'파일 대신 폴더를 선택해 주세요.');
  return {path:root,dev:String(s.dev),ino:String(s.ino)};
}
async function checkRoot(share){const current=await rootIdentity(share.path);if(current.dev!==share.dev||current.ino!==share.ino)throw new FileServerError(409,'공유 폴더 또는 드라이브가 바뀌었습니다. 다시 선택해 주세요.');return current;}
export async function scanFolder(path,{maxEntries=20000,maxMs=15000}={}){
  const root=await rootIdentity(path),started=Date.now(),queue=[root.path],findings=[];let count=0,blockedCount=0,complete=true;
  while(queue.length){
    if(count>=maxEntries||Date.now()-started>maxMs){complete=false;break;}
    const dir=queue.shift();await noLinks(dir);let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{complete=false;break;}
    for(const entry of entries){
      if(++count>maxEntries||Date.now()-started>maxMs){complete=false;break;}
      const p=join(dir,entry.name);let s;try{s=await lstat(p);}catch{complete=false;continue;}
      const blocked=unsafeName(entry.name)||s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())||s.isFile()&&s.nlink>1;
      if(blocked){blockedCount++;if(findings.length<200)findings.push({path:relative(root.path,p).split(sep).join('/'),reason:'공유 제외 이름·형식 또는 연결된 파일'});continue;}
      if(s.isDirectory())queue.push(p);
    }
    if(!complete)break;
  }
  await checkRoot(root);return {root,name:basename(root.path),checkedCount:count,blockedCount,findings,complete};
}
export async function resolveEntry(share,raw=''){
  await checkRoot(share);const parts=relativeParts(raw);let target=share.path;
  for(const part of parts){target=join(target,part);const s=await lstat(target,{bigint:true});if(s.isSymbolicLink()||s.isFile()&&s.nlink>1n)throw deny();}
  await noLinks(target);const r=relative(share.path,target);if(r.startsWith('..')||parse(r).root)throw deny();
  return {path:target,stat:await lstat(target,{bigint:true})};
}
export async function listFiles(share,path=''){
  const entry=await resolveEntry(share,path);if(!entry.stat.isDirectory())throw new FileServerError(400,'폴더를 선택해 주세요.');
  const items=await readdir(entry.path,{withFileTypes:true}),entries=[];
  for(const item of items){
    if(unsafeName(item.name)||item.isSymbolicLink())continue;
    const child=path?path+'/'+item.name:item.name;
    try{const e=await resolveEntry(share,child);if(!e.stat.isFile()&&!e.stat.isDirectory())continue;entries.push({name:item.name,path:child,folder:e.stat.isDirectory(),size:e.stat.isFile()?Number(e.stat.size):null,modifiedAt:new Date(Number(e.stat.mtimeMs)).toISOString()});}catch{continue;}
    if(entries.length===500)break;
  }
  entries.sort((a,b)=>Number(b.folder)-Number(a.folder)||a.name.localeCompare(b.name,'ko'));
  return {shareId:share.id,path,entries,truncated:items.length>500};
}
function windowsStream(share,target,start,end,signal){
  const helper=fileURLToPath(new URL('./read-file.ps1',import.meta.url));
  return new Promise((resolvePromise,reject)=>{
    if(signal?.aborted){reject(new FileServerError(499,'전송이 취소되었습니다.'));return;}
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const output=new PassThrough({highWaterMark:64*1024});let header=Buffer.alloc(0),ready=false;
    // Errors may arrive before the consumer receives the stream. Keep them on
    // the stream for async iteration without an unhandled EventEmitter error.
    output.on('error',()=>{});
    const timer=setTimeout(()=>{child.kill();reject(new FileServerError(504,'파일을 여는 시간이 초과되었습니다.'));},15000);timer.unref();
    const abort=()=>{const error=new FileServerError(499,'전송이 취소되었습니다.');child.kill();clearTimeout(timer);if(!ready)reject(error);output.destroy(error);};
    signal?.addEventListener('abort',abort,{once:true});
    output.on('close',()=>{if(child.exitCode===null)child.kill();});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(new FileServerError(503,'안전한 파일 읽기를 시작하지 못했습니다.'));});
    child.on('exit',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(code!==0){const e=deny();if(ready)output.destroy(e);else reject(e);}});
    function first(chunk){
      header=Buffer.concat([header,chunk]);const index=header.indexOf(10);
      if(index<0){if(header.length>4096){child.kill();reject(deny());}return;}
      let metadata;try{metadata=JSON.parse(header.subarray(0,index).toString('utf8'));}catch{child.kill();reject(deny());return;}
      clearTimeout(timer);ready=true;child.stdout.off('data',first);child.stdout.pause();
      output.write(header.subarray(index+1));child.stdout.pipe(output);resolvePromise({stream:output,...metadata});
    }
    child.stdin.on('error',()=>{});
    child.stdout.on('data',first);child.stdin.end(JSON.stringify({root:share.path,rootIno:share.ino,path:target,start,end}));
  });
}
export async function openDownload(share,path,{start=0,end,signal}={}){
  const target=await resolveEntry(share,path);if(!target.stat.isFile())throw deny();
  const size=Number(target.stat.size);end??=size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start&&size!==0||start>=size&&size!==0||end>=size)throw new FileServerError(416,'이어받기 범위가 올바르지 않습니다.');
  if(process.platform==='win32')return windowsStream(share,target.path,start,end,signal);
  const file=await open(target.path,'r');const s=await file.stat({bigint:true});
  try{await resolveEntry(share,path);if(s.dev!==target.stat.dev||s.ino!==target.stat.ino||s.nlink>1n)throw deny();}catch(e){await file.close();throw e;}
  return {size,bytes:size===0?0:end-start+1,stream:file.createReadStream(size?{start,end,signal}:{signal})};
}
