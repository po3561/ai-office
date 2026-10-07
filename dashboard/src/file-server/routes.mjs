// 대시보드의 파일 서버 경로(/api/file-server/*).
// 로그인 토큰은 이 대시보드 서버만 갖고 있고 화면에는 내보내지 않는다. 화면 출처·로그인 검사는 server.mjs 가 먼저 한다.
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {FileServerError} from './files.mjs';

const ID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SERVER=new RegExp(`^/servers/(${ID})(?:/(members|audit|invitations|files|download)(?:/(${ID}))?)?$`,'i');
const SHARE=/^[A-Za-z0-9_-]{1,64}$/;
const statusOf=e=>Number.isInteger(e?.status)&&e.status>=400&&e.status<600?e.status:500;

export async function readLocalAudit(dir,limit=200){
  let names;try{names=(await readdir(dir)).filter(n=>/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse();}catch{return [];}
  const events=[];
  for(const name of names){
    const lines=(await readFile(join(dir,name),'utf8').catch(()=>'')).split('\n').filter(Boolean).reverse();
    for(const line of lines){try{events.push(JSON.parse(line));}catch{}if(events.length>=limit)return events;}
  }
  return events;
}

export function createFileServerRoutes({manager,cloud,auditDir}){
  async function currentUser(){
    const state=await cloud.state();
    if(!state.signedIn||!state.user?.id)throw new FileServerError(401,'라피스 계정에 로그인해 주세요.');
    return state.user;
  }
  const api=(method,path,body)=>cloud.fileServers(method,path,body);
  return async function handle(req,res,url,{json,readJson}){
    if(!url.pathname.startsWith('/api/file-server/'))return false;
    const route=url.pathname.slice('/api/file-server'.length),method=req.method;
    try{
      const user=await currentUser();
      // ── 이 PC 서버(소유자) ──
      if(route==='/state'&&method==='GET')return json(res,200,await manager.state(user)),true;
      if(route==='/pick'&&method==='POST')return json(res,200,await manager.pick(user)),true;
      if(route==='/scan'&&method==='POST'){const b=await readJson(req);return json(res,200,await manager.scan(user,String(b.pickId||''))),true;}
      if(route==='/configure'&&method==='POST')return json(res,200,await manager.configure(user,await readJson(req),api)),true;
      if(route==='/settings'&&method==='PUT')return json(res,200,await manager.settings(user,await readJson(req))),true;
      if(route==='/start'&&method==='POST')return json(res,200,await manager.start(user,api)),true;
      if(route==='/stop'&&method==='POST')return json(res,200,await manager.stop(user,api)),true;
      if(route==='/local-audit'&&method==='GET'){
        await manager.state(user);   // 서버 주인만 PC 기록을 본다
        const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit'))||200));
        return json(res,200,{events:await readLocalAudit(auditDir,limit)}),true;
      }
      // ── 클라우드(참여·초대·멤버·기록·파일) ──
      if(route==='/servers'&&method==='GET')return json(res,200,await api('GET','/file-servers')),true;
      if(route==='/redeem'&&method==='POST'){
        const b=await readJson(req);const code=String(b.code||'').replace(/[\s-]/g,'');
        if(!/^\d{12}$/.test(code))throw new FileServerError(400,'초대 코드는 숫자 12자리입니다.');
        return json(res,200,await api('POST','/file-server-invitations/redeem',{code})),true;
      }
      const match=SERVER.exec(route);
      if(!match)throw new FileServerError(404,'지원하지 않는 파일 서버 요청입니다.');
      const [,serverId,section='',memberId]=match,base='/file-servers/'+serverId.toLowerCase();
      if(!section&&!memberId&&method==='GET')return json(res,200,await api('GET',base)),true;
      if(section==='members'&&!memberId&&method==='GET')return json(res,200,await api('GET',base+'/members')),true;
      if(section==='members'&&memberId&&method==='PATCH'){
        const b=await readJson(req);if(!['active','revoked'].includes(b.status))throw new FileServerError(400,'멤버 상태가 올바르지 않습니다.');
        return json(res,200,await api('PATCH',base+'/members/'+memberId.toLowerCase(),{status:b.status})),true;
      }
      if(section==='invitations'&&!memberId&&method==='POST'){
        const b=await readJson(req);const ids=Array.isArray(b.shareIds)?b.shareIds.filter(id=>typeof id==='string'&&SHARE.test(id)).slice(0,32):undefined;
        return json(res,201,await api('POST',base+'/invitations',ids?{shareIds:ids}:{})),true;
      }
      if(section==='audit'&&!memberId&&method==='GET'){
        const q=new URLSearchParams();const limit=Number(url.searchParams.get('limit'))||50,cursor=url.searchParams.get('cursor');
        q.set('limit',String(Math.min(100,Math.max(1,limit))));if(cursor&&/^\d{1,12}$/.test(cursor))q.set('cursor',cursor);
        return json(res,200,await api('GET',base+'/audit?'+q)),true;
      }
      if((section==='files'||section==='download')&&!memberId&&method==='GET'){
        const shareId=url.searchParams.get('shareId')||'',path=url.searchParams.get('path')||'';
        if(!SHARE.test(shareId)||path.length>512)throw new FileServerError(400,'파일 경로가 올바르지 않습니다.');
        const query='?'+new URLSearchParams({shareId,path});
        if(section==='files')return json(res,200,await api('GET',base+'/files'+query)),true;
        return await download(req,res,json,base+'/download'+query),true;
      }
      throw new FileServerError(405,'허용되지 않는 요청입니다.');
    }catch(e){
      if(!res.headersSent)json(res,statusOf(e),{error:e?.status?e.message:'파일 서버 요청을 처리하지 못했습니다.'});
      else res.destroy();
      return true;
    }
  };
  async function download(req,res,json,path){
    const controller=new AbortController();
    const range=typeof req.headers.range==='string'&&/^bytes=\d+-\d*$/.test(req.headers.range)?req.headers.range:undefined;
    const response=await cloud.fileServerStream(path,{range,signal:controller.signal});
    if(!response.ok){
      let message='파일을 내려받지 못했습니다.';try{const d=await response.json();if(typeof d.error==='string')message=d.error;}catch{}
      return json(res,response.status,{error:message});
    }
    const headers={'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'};
    for(const name of ['content-length','content-disposition','content-range','accept-ranges']){const v=response.headers.get(name);if(v)headers[name]=v;}
    res.writeHead(response.status,headers);
    res.on('close',()=>{if(!res.writableFinished)controller.abort();});
    try{await pipeline(Readable.fromWeb(response.body),res);}catch{controller.abort();res.destroy();}
  }
}

// 「PC를 켜면 자동 시작」을 켠 서버: 대시보드가 켜진 뒤 로그인·인터넷이 준비되면 다시 시작한다.
export function startAutoResume({manager,cloud,intervalMs=60000,maxAttempts=30,log=()=>{}}){
  let attempts=0,timer=null,stopped=false;
  const api=(method,path,body)=>cloud.fileServers(method,path,body);
  async function tick(){
    if(stopped)return;attempts++;
    try{
      const state=await cloud.state();
      if(state.signedIn&&state.user?.id){
        const result=await manager.resume(state.user,api);
        if(result.resumed)log('파일 서버를 자동으로 다시 시작했습니다.');
        return;   // 켤 대상이 아니거나 켰다: 더 시도하지 않는다
      }
    }catch(e){
      // 계정·설정 문제(4xx)는 반복해도 풀리지 않는다. 네트워크 문제만 다시 시도한다.
      if(e?.status>=400&&e.status<500&&e.status!==408&&e.status!==429){log('파일 서버 자동 시작 실패: '+e.message);return;}
    }
    if(attempts<maxAttempts){timer=setTimeout(tick,intervalMs);timer.unref?.();}
  }
  timer=setTimeout(tick,3000);timer.unref?.();
  return {stop(){stopped=true;clearTimeout(timer);}};
}
