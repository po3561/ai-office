// 저장소: 이 PC 에서 사무실에 맡긴 드라이브(드라이브 접근)의 폴더를 읽기 전용으로 보여 준다.
// 맡기지 않은 위치는 볼 수 없다. 파일은 열거나 바꾸지 않고, 탐색기에서 위치만 보여 준다.
import {readdir,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';

export class StorageError extends Error{constructor(status,message){super(message);this.status=status;}}
const HIDDEN=/(^|\/)\.(telegram|ai-office|claude|git)(\/|$)/i;
const MAX_ENTRIES=500;

export function normalizePath(raw){
  let p=String(raw??'').trim().replace(/^["']|["']$/g,'').replace(/\\/g,'/');
  if(!/^[A-Za-z]:(\/|$)/.test(p))throw new StorageError(400,'드라이브 경로(예: D:/자료)를 입력해 주세요.');
  p=(p[0].toUpperCase()+p.slice(1)).replace(/\/+/g,'/');
  if(/(^|\/)\.\.(\/|$)/.test(p)||/[*?"<>|\0]/.test(p))throw new StorageError(400,'경로에 쓸 수 없는 글자가 있습니다.');
  p=p.replace(/\/$/,'');
  return p.length===2?p+'/':p;
}
export function allowedUnder(path,grants){
  const low=path.toLowerCase();
  return grants.some(g=>{const root=normalizePath(g).toLowerCase().replace(/\/$/,'');return low===root||low===root+'/'||low.startsWith(root+'/');});
}
export async function listLocal(path,grants){
  const dir=normalizePath(path);
  if(!allowedUnder(dir,grants))throw new StorageError(403,'사무실에 맡기지 않은 위치입니다. 「드라이브」에서 먼저 맡겨 주세요.');
  if(HIDDEN.test(dir))throw new StorageError(403,'봇의 토큰·설정 폴더는 볼 수 없습니다.');
  let names;
  try{names=await readdir(dir.length===3?dir:dir+'/',{withFileTypes:true});}
  catch{throw new StorageError(404,'폴더를 열 수 없습니다. 위치가 있는지, 드라이브가 연결되어 있는지 확인해 주세요.');}
  const entries=[];
  for(const item of names){
    if(HIDDEN.test('/'+item.name+'/'))continue;
    const folder=item.isDirectory();
    if(!folder&&!item.isFile())continue;
    let info=null;
    try{info=await stat(join(dir.length===3?dir:dir+'/',item.name));}catch{}
    entries.push({name:item.name,folder,size:folder||!info?null:info.size,modifiedAt:info?info.mtime.toISOString():null});
    if(entries.length>=MAX_ENTRIES)break;
  }
  entries.sort((a,b)=>Number(b.folder)-Number(a.folder)||a.name.localeCompare(b.name,'ko'));
  const parts=dir.split('/').filter(Boolean);
  const crumbs=parts.map((name,i)=>({name:i===0?name+'/':name,path:i===0?parts[0]+'/':parts.slice(0,i+1).join('/')})).filter(c=>allowedUnder(normalizePath(c.path),grants));
  return {path:dir,breadcrumbs:crumbs,entries,truncated:names.length>MAX_ENTRIES};
}
// 파일을 실행하지 않고 탐색기에서 선택된 상태로 보여 주기만 한다.
export async function reveal(path,grants,spawnImpl=spawn){
  const target=normalizePath(path);
  if(!allowedUnder(target,grants)||HIDDEN.test(target))throw new StorageError(403,'맡긴 위치 안에서만 열 수 있습니다.');
  try{await stat(target);}catch{throw new StorageError(404,'파일이나 폴더를 찾을 수 없습니다.');}
  spawnImpl('explorer.exe',['/select,"'+target.replace(/\//g,'\\')+'"'],{detached:true,stdio:'ignore',windowsVerbatimArguments:true}).unref?.();
  return {ok:true};
}
