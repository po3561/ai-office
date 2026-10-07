// 파일 서버 호스트: 이 PC 에서 클라우드 중계(WSS)로 나가는 연결 하나만 연다(받는 포트는 열지 않는다).
// 중계가 보낸 요청마다 클라우드에 권한을 다시 묻고, 허용된 공유 폴더의 파일만 64KiB 조각으로 보낸다.
// 연결이 끊기면 state:'disconnected'(retry:true)로 알리고, 다시 붙이는 일은 manager 가 맡는다.
import {open,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {listFiles,openDownload,resolveEntry,relativeParts,FileServerError} from './files.mjs';
import {ensurePrivateDirectory} from './private-directory.mjs';

export function hostSocketAddress(baseUrl,serverId,credential){
  const base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password||!/^[-a-f0-9]{36}$/.test(serverId)||!/^[a-f0-9]{64}$/.test(credential))throw new FileServerError(400,'서버의 보안 연결 설정이 올바르지 않습니다.');
  base.pathname=base.pathname.replace(/\/$/,'')+'/file-servers/'+serverId+'/host/connect';base.search='';base.hash='';base.protocol='wss:';
  return {url:base.href,protocols:['lapis-host','credential.'+credential]};
}
export function fileRange(range,size){
  if(!range)return {start:0,end:size-1,status:200};const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)throw new FileServerError(416,'이어받기 범위를 확인해 주세요.');
  const start=Number(match[1]),end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start||end>=size)throw new FileServerError(416,'이어받기 범위를 확인해 주세요.');return {start,end,status:206};
}
const emptyStats=()=>({connectedAt:null,lastHeartbeatAt:null,activeTransfers:0,completed:0,interrupted:0,listed:0,bytesSent:0,lastTransferAt:null});
export function createFileHost({baseUrl,dataDir,fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket,heartbeatMs=25000,staleMs=45000}){
  let socket=null,config=null,heartbeat=null,stopping=false,lastHeartbeat=0;const active=new Map();let onState=()=>{};
  let stats=emptyStats();
  const send=data=>{if(socket?.readyState===1)socket.send(JSON.stringify(data));};
  async function api(path,body){const response=await fetchImpl(baseUrl+'/file-servers/'+config.serverId+'/host/'+path,{method:'POST',headers:{authorization:'Bearer '+config.hostToken,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new FileServerError(response.status,'서버 권한을 확인하지 못했습니다.');return response.json();}
  async function audit(p,action,reasonCode='complete'){
    const event={actorUserId:p.request.userId,shareId:p.request.shareId,action,outcome:action.endsWith('interrupted')?'denied':'allowed',relativePath:p.request.path,transferId:p.id,bytesSent:p.bytes||0,expectedBytes:p.expected||0,reasonCode};
    await ensurePrivateDirectory(dataDir);const file=await open(join(dataDir,'audit-'+new Date().toISOString().slice(0,10)+'.jsonl'),'a',0o600);
    try{await file.write(JSON.stringify({eventId:randomUUID(),at:new Date().toISOString(),...event})+'\n');await file.sync();}finally{await file.close();}
    // 중앙 기록도 남아야 성공으로 본다. 클라우드 기록이 빠진 전송이 정상처럼 보이지 않게 한다.
    await api('audit',event);
  }
  async function cancel(id,reason='cancelled'){
    const p=active.get(id);if(!p)return;active.delete(id);stats.activeTransfers=active.size;p.abort.abort();p.stream?.destroy();
    if(p.started){stats.interrupted++;await audit(p,'download_interrupted',reason).catch(()=>onState({state:'error',error:'일부 전송 기록을 중앙에 저장하지 못했습니다. PC 기록을 확인해 주세요.'}));}
  }
  async function prepare(request){
    if(stopping||active.size>=8||active.has(request.id)||!/^[-a-f0-9]{36}$/.test(request.id)||!['list','download'].includes(request.operation))throw Error('invalid request');
    relativeParts(request.path);const share=config.shares.find(s=>s.id===request.shareId);if(!share)throw new FileServerError(403,'공유 폴더 권한이 없습니다.');
    const p={id:request.id,request,abort:new AbortController(),bytes:0,expected:0,credits:0,pumping:false,started:false};active.set(p.id,p);stats.activeTransfers=active.size;
    const stillActive=()=>{if(p.abort.signal.aborted||active.get(p.id)!==p)throw new FileServerError(499,'전송이 취소되었습니다.');};
    try{
      await api('check-access',{userId:request.userId,shareId:request.shareId,action:request.operation});stillActive();
      let status=200,contentRange;
      if(request.operation==='list'){
        const bytes=Buffer.from(JSON.stringify(await listFiles(share,request.path)));stillActive();p.expected=bytes.length;p.stream=Readable.from([bytes]);await audit(p,'list');stillActive();stats.listed++;
      }else{
        const entry=await resolveEntry(share,request.path);stillActive();const size=Number(entry.stat.size);const range=fileRange(request.range,size);status=range.status;
        if(size>4*1024**3)throw new FileServerError(413,'한 번에 4GB 이하 파일을 내려받을 수 있습니다.');
        const opened=await openDownload(share,request.path,{...range,signal:p.abort.signal});p.stream=opened.stream;p.expected=opened.bytes;
        if(p.abort.signal.aborted){p.stream.destroy();stillActive();}
        if(status===206)contentRange=`bytes ${range.start}-${range.end}/${size}`;
        p.started=true;await audit(p,'download_started');stillActive();
      }
      p.iterator=chunks(p.stream)[Symbol.asyncIterator]();send({type:'head',id:p.id,status,length:p.expected,contentRange});
      if(p.expected===0)await finish(p);
    }catch(error){await cancel(p.id,error.status===403?'forbidden':'io_error');throw error;}
  }
  async function* chunks(stream){for await(const raw of stream){const bytes=Buffer.from(raw);for(let offset=0;offset<bytes.length;offset+=65536)yield bytes.subarray(offset,offset+65536);}}
  async function finish(p){
    if(!active.has(p.id))return;
    // 모든 바이트를 중계로 보냈다는 뜻이다. 받는 쪽이 저장까지 마쳤다는 보증은 아니다.
    if(p.started){await audit(p,'download_completed');stats.completed++;}
    if(active.get(p.id)!==p)return;active.delete(p.id);stats.activeTransfers=active.size;stats.lastTransferAt=new Date().toISOString();send({type:'end',id:p.id});p.stream?.destroy();
  }
  async function pump(p){
    if(p.pumping)return;p.pumping=true;
    try{while(p.credits>0&&active.has(p.id)){
      const value=await p.iterator.next();if(active.get(p.id)!==p)break;if(value.done){await finish(p);break;}
      p.credits--;p.bytes+=value.value.length;if(p.started)stats.bytesSent+=value.value.length;send({type:'chunk',id:p.id,data:value.value.toString('base64')});if(p.bytes===p.expected){await finish(p);break;}
    }}catch{await cancel(p.id,'io_error');send({type:'error',id:p.id});}finally{p.pumping=false;}
  }
  async function message(raw){
    if(typeof raw!=='string'||raw.length>16384)throw Error();const data=JSON.parse(raw);
    if(data.type==='request'){try{await prepare(data);}catch{send({type:'error',id:data.id});}return;}
    if(data.type==='cancel'){await cancel(data.id);return;}
    if(data.type==='pull'){const p=active.get(data.id);if(!p)return;if(!Number.isInteger(data.count)||data.count<1||data.count>4||p.credits+data.count>4)throw Error();p.credits+=data.count;await pump(p);return;}
    if(data.type==='heartbeat'){
      // 다른 곳에서 서버를 중지(paused)했으면 다시 붙지 않고 멈춘다.
      if(data.status!=='active'){onState({state:'error',error:'클라우드에서 이 서버가 중지 상태로 바뀌어 공유를 멈췄습니다.',retry:false});void stop();return;}
      lastHeartbeat=Date.now();stats.lastHeartbeatAt=new Date(lastHeartbeat).toISOString();return;
    }
    if(data.type!=='ready')throw Error();
  }
  async function stop(){
    stopping=true;clearInterval(heartbeat);heartbeat=null;const old=socket;socket=null;
    // 연결을 먼저 끊고 모든 전송을 멈춘 뒤에 기록 저장을 기다린다.
    try{old?.close(1000,'server stopped');}catch{}
    await Promise.all([...active.keys()].map(id=>cancel(id,'disconnected')));
    stats.connectedAt=null;
  }
  // 연결이 예기치 않게 끊긴 경우: 공유를 멈추고 manager 에 다시 연결을 맡긴다.
  const lost=error=>{onState({state:'disconnected',error,retry:true});void stop();};
  return {
    stats:()=>({...stats,activeTransfers:active.size}),
    async start(next,changed=()=>{}){
      await stop();stopping=false;config=next;onState=changed;const address=hostSocketAddress(baseUrl,config.serverId,config.hostToken);
      await api('heartbeat',{uptimeSeconds:0,shareIds:config.shares.map(s=>s.id)});const began=Date.now();
      return new Promise((resolve,reject)=>{
        const ws=new WebSocketImpl(address.url,address.protocols);socket=ws;let ready=false;
        const timer=setTimeout(()=>{if(socket===ws)ws.close();reject(new FileServerError(socket===ws?503:499,'서버 연결 서비스에 접속하지 못했습니다.'));},15000);timer.unref?.();
        ws.addEventListener('message',event=>{
          if(socket!==ws){clearTimeout(timer);if(!ready)reject(new FileServerError(499,'이전 서버 연결이 종료되었습니다.'));return;}
          if(!ready&&event.data==='{"type":"ready"}'){ready=true;lastHeartbeat=Date.now();clearTimeout(timer);
            stats={...emptyStats(),bytesSent:stats.bytesSent,completed:stats.completed,interrupted:stats.interrupted,listed:stats.listed,connectedAt:new Date().toISOString(),lastHeartbeatAt:new Date().toISOString()};
            onState({state:'connected',error:null});resolve();
            heartbeat=setInterval(()=>{
              if(socket!==ws)return;
              if(Date.now()-lastHeartbeat>staleMs){lost('서버 연결 응답이 끊겼습니다. 자동으로 다시 연결합니다.');return;}
              send({type:'heartbeat',uptimeSeconds:Math.floor((Date.now()-began)/1000),shareIds:config.shares.map(s=>s.id)});
            },heartbeatMs);heartbeat.unref?.();return;}
          void message(event.data).catch(()=>{if(socket!==ws)return;lost('서버 연결 응답이 올바르지 않아 다시 연결합니다.');});
        });
        ws.addEventListener('error',()=>{clearTimeout(timer);if(socket!==ws){if(!ready)reject(new FileServerError(499,'이전 서버 연결이 종료되었습니다.'));return;}if(!ready)reject(new FileServerError(503,'서버 연결 서비스를 확인해 주세요.'));else lost('서버 연결에 오류가 생겼습니다. 자동으로 다시 연결합니다.');});
        ws.addEventListener('close',()=>{clearTimeout(timer);if(socket!==ws){if(!ready)reject(new FileServerError(499,'이전 서버 연결이 종료되었습니다.'));return;}if(!ready)reject(new FileServerError(503,'서버 연결이 거절되었습니다.'));else if(!stopping)lost('연결이 끊겼습니다. 자동으로 다시 연결합니다.');});
      });
    },stop,
  };
}
