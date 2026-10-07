// 파일 서버 관리: 공유 폴더 선택(PC 화면의 폴더 선택 창으로만)·검사·설정 저장·시작/중지와 연결 유지.
// 설정은 원자적으로 저장하고 직전 설정을 .previous 로 남긴다. 호스트 키는 DPAPI 보관함에만 둔다.
import {readFile,writeFile,mkdir,rename,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {scanFolder,resolveEntry,FileServerError} from './files.mjs';
import {ensurePrivateDirectory} from './private-directory.mjs';

// 연결이 끊긴 뒤 다시 붙는 간격(초). 마지막 값으로 계속 시도한다.
export const RECONNECT_DELAYS=[5,15,30,60,120,300];
const samePath=(a,b)=>a.replace(/[\\/]+$/,'').toLowerCase()===b.replace(/[\\/]+$/,'').toLowerCase();

export function createFileServerManager({dataDir,vault,pickFolder=async()=>null,onStart=async()=>{},onStop=async()=>{},hostStats=()=>null,now=()=>Date.now(),reconnectDelays=RECONNECT_DELAYS}){
  const file=join(dataDir,'file-server.json'),scans=new Map(),picks=new Map();let pending=Promise.resolve(),running=false,relay={state:'stopped',error:null};
  let reconnect={attempt:0,timer:null,nextAt:null};let picking=false;
  const serial=fn=>{const next=pending.then(fn);pending=next.catch(()=>{});return next;};
  async function read(){await ensurePrivateDirectory(dataDir);try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw new FileServerError(503,'서버 설정을 읽지 못했습니다. 백업을 확인해 주세요.');}}
  async function write(value){await mkdir(dataDir,{recursive:true});try{await copyFile(file,file+'.previous');}catch(e){if(e.code!=='ENOENT')throw e;}const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await rename(temp,file);}
  const userId=user=>{if(!user?.id||typeof user.id!=='string')throw new FileServerError(401,'라피스 계정에 로그인해 주세요.');return user.id;};
  function own(config,user){const id=userId(user);if(config&&config.ownerUserId!==id)throw new FileServerError(403,'이 PC 서버를 만든 라피스 계정으로 로그인해 주세요.');}
  function publicState(config){
    const ops={...(hostStats()||{}),reconnectAttempt:reconnect.attempt,nextRetryAt:reconnect.nextAt?new Date(reconnect.nextAt).toISOString():null};
    return config?{configured:true,serverId:config.serverId,name:config.name,ownerUserId:config.ownerUserId,shares:config.shares.map(({id,name,path})=>({id,name,path})),autoStart:config.autoStart===true,desiredRunning:running,relay,ops,updatedAt:config.updatedAt,capabilities:{upload:false}}
      :{configured:false,shares:[],autoStart:false,desiredRunning:false,relay,ops,capabilities:{upload:false}};
  }
  function clearReconnect(){clearTimeout(reconnect.timer);reconnect={attempt:0,timer:null,nextAt:null};}
  // 호스트가 알리는 연결 상태. 예기치 않은 끊김은 자동으로 다시 붙인다(서버를 켜 둔 동안만).
  function changed(value){
    if(value.state==='disconnected'&&value.retry&&running){scheduleReconnect(value.error);return;}
    if(value.state==='error'&&value.retry===false){running=false;clearReconnect();relay={state:'error',error:value.error};return;}
    if(value.state==='connected')clearReconnect();
    relay={state:value.state,error:value.error??null};
  }
  function scheduleReconnect(reason){
    clearTimeout(reconnect.timer);
    const delay=reconnectDelays[Math.min(reconnect.attempt,reconnectDelays.length-1)]*1000;
    reconnect.attempt++;reconnect.nextAt=now()+delay;
    relay={state:'reconnecting',error:reason||'연결이 끊겨 다시 연결하는 중입니다.'};
    reconnect.timer=setTimeout(()=>{void serial(reconnectNow);},delay);reconnect.timer.unref?.();
  }
  async function reconnectNow(){
    if(!running)return;reconnect.nextAt=null;
    const config=await read().catch(()=>null);const host=(await vault.read().catch(()=>({}))).fileHost;
    if(!config||host?.serverId!==config.serverId||!host.hostToken){running=false;clearReconnect();relay={state:'error',error:'서버 설정 또는 보안 연결 정보를 찾지 못해 공유를 멈췄습니다.'};return;}
    relay={state:'connecting',error:null};
    try{await onStart({...config,hostToken:host.hostToken},changed);if(running)clearReconnect();}
    catch(error){
      // 키가 거절되거나 클라우드에서 중지된 서버는 계속 두드리지 않는다.
      if([401,403,404].includes(error?.status)){running=false;clearReconnect();relay={state:'error',error:'클라우드가 이 PC의 서버 연결을 거절했습니다. 서버를 다시 시작하거나 다시 만들어 주세요.'};return;}
      if(running)scheduleReconnect('다시 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
  }
  const manager={
    async state(user){const config=await read();own(config,user);return publicState(config);},
    // 공유할 폴더는 이 PC 화면에 뜨는 폴더 선택 창으로만 고른다(같은 PC 의 다른 프로그램이 경로를 몰래 넣지 못하게).
    async pick(user){
      userId(user);const config=await read();own(config,user);
      if(picking)throw new FileServerError(409,'폴더 선택 창이 이미 열려 있어요. 작업 표시줄에서 확인해 주세요.');
      picking=true;let path;try{path=await pickFolder();}finally{picking=false;}
      if(!path)return {path:null};
      for(const [id,p] of picks)if(p.expiresAt<now())picks.delete(id);
      const pickId=randomUUID();picks.set(pickId,{path,userId:user.id,expiresAt:now()+10*60*1000});return {pickId,path};
    },
    async scan(user,pickId){userId(user);const config=await read();own(config,user);
      const picked=picks.get(pickId);if(!picked||picked.userId!==user.id||picked.expiresAt<now())throw new FileServerError(409,'폴더를 다시 선택해 주세요.');
      const result=await scanFolder(picked.path);picks.delete(pickId);
      for(const [id,s] of scans)if(s.expiresAt<now())scans.delete(id);if(scans.size>=20)throw new FileServerError(429,'검사 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
      const scanId=randomUUID(),expiresAt=now()+10*60*1000;scans.set(scanId,{...result,userId:user.id,expiresAt});return {scanId,path:result.root.path,name:result.name,checkedCount:result.checkedCount,blockedCount:result.blockedCount,findings:result.findings,complete:result.complete,expiresAt:new Date(expiresAt).toISOString()};
    },
    configure(user,input,api){return serial(async()=>{
      const current=await read();own(current,user);if(running)throw new FileServerError(409,'공유 폴더를 바꾸려면 먼저 서버를 중지해 주세요.');
      const name=typeof input?.name==='string'?input.name.trim():'';
      if(!name||name.length>80||/[\x00-\x1f]/.test(name))throw new FileServerError(400,'서버 이름을 1~80자로 입력해 주세요.');
      if(!Array.isArray(input.scanIds)||input.scanIds.length<1||input.scanIds.length>10||new Set(input.scanIds).size!==input.scanIds.length)throw new FileServerError(400,'검사한 공유 폴더를 1~10개 선택해 주세요.');
      const shares=[];
      for(const id of input.scanIds){
        const scan=scans.get(id);if(!scan||scan.userId!==user.id||scan.expiresAt<now()||!scan.complete)throw new FileServerError(409,'폴더 검사를 다시 완료해 주세요.');await resolveEntry(scan.root,'');
        // 같은 폴더를 다시 고르면 예전 공유 ID 를 그대로 써서, 이미 초대한 멤버의 폴더 권한이 이어지게 한다.
        const previous=current?.shares.find(s=>samePath(s.path,scan.root.path)&&s.dev===scan.root.dev&&s.ino===scan.root.ino);
        shares.push({...scan.root,id:previous?.id||randomUUID(),name:scan.name});
      }
      if(new Set(shares.map(s=>s.path.toLowerCase())).size!==shares.length)throw new FileServerError(400,'같은 폴더를 중복 선택할 수 없습니다.');
      const body={name,shares:shares.map(({id,name})=>({id,name}))};let serverId=current?.serverId;
      if(current){await api('PATCH','/file-servers/'+serverId,{...body,status:'paused'});}
      else{
        const created=await api('POST','/file-servers',body);serverId=created.server?.id;if(!serverId||!created.hostToken)throw new FileServerError(502,'서버 등록 결과가 올바르지 않습니다.');
        try{await vault.update({fileHost:{serverId,hostToken:created.hostToken}});await api('PATCH','/file-servers/'+serverId,{status:'paused'});}catch(e){await api('PATCH','/file-servers/'+serverId,{status:'paused'}).catch(()=>{});throw e;}
      }
      const config={version:1,serverId,ownerUserId:user.id,name,shares,autoStart:current?.autoStart===true,updatedAt:new Date(now()).toISOString()};
      await write(config);for(const id of input.scanIds)scans.delete(id);return publicState(config);
    });},
    settings(user,input){return serial(async()=>{
      const config=await read();own(config,user);if(!config)throw new FileServerError(409,'먼저 서버를 만들어 주세요.');
      if(typeof input?.autoStart!=='boolean')throw new FileServerError(400,'설정 값이 올바르지 않습니다.');
      const next={...config,autoStart:input.autoStart,updatedAt:new Date(now()).toISOString()};await write(next);return publicState(next);
    });},
    start(user,api){return serial(async()=>{const config=await read();own(config,user);if(!config)throw new FileServerError(409,'먼저 서버를 만들어 주세요.');if(running)return publicState(config);
      for(const share of config.shares)await resolveEntry(share,'');const host=(await vault.read()).fileHost;
      if(host?.serverId!==config.serverId||!host.hostToken)throw new FileServerError(409,'서버의 보안 연결 정보를 복구해야 합니다.');
      await api('PATCH','/file-servers/'+config.serverId,{status:'active'});
      clearReconnect();
      try{relay={state:'connecting',error:null};running=true;await onStart({...config,hostToken:host.hostToken},changed);}
      catch(error){running=false;relay={state:'error',error:'서버 연결을 시작하지 못했습니다.'};await api('PATCH','/file-servers/'+config.serverId,{status:'paused'}).catch(()=>{});throw error;}
      return publicState(config);
    });},
    stop(user,api){return serial(async()=>{const config=await read();own(config,user);if(!config)throw new FileServerError(409,'설정된 서버가 없습니다.');
      running=false;clearReconnect();await onStop();relay={state:'stopped',error:null};
      try{await api('PATCH','/file-servers/'+config.serverId,{status:'paused'});}catch{relay={state:'stopped',error:'PC의 공유는 중지했습니다. 클라우드 상태 갱신은 다시 시도해 주세요.'};}
      return publicState(config);
    });},
    // 자동 시작을 켜 둔 서버만, 만든 계정으로 로그인돼 있을 때 다시 켠다.
    async resume(user,api){
      const config=await read().catch(()=>null);
      if(!config?.autoStart||running||!user?.id||config.ownerUserId!==user.id)return {resumed:false};
      await manager.start(user,api);return {resumed:true};
    },
    get running(){return running;},
    async close(){running=false;clearReconnect();await onStop();},
  };return manager;
}
