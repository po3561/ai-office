// 통합 서버의 추가 기능 경로: 라피스 계정·Google(클라우드), 자체 캘린더와 Google 캘린더 연동, 저장소(맡긴 드라이브 보기).
// 변경 요청이 대시보드 화면에서 온 것인지 등의 공통 검사는 server.mjs 가 먼저 한다.
import {CloudError} from './lapis-cloud.mjs';
import {CalendarError} from './calendar.mjs';
import {StorageError,listLocal as listLocalDefault,reveal as revealDefault} from './storage.mjs';
import {TaskError} from './tasks.mjs';

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=(title,body)=>`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:'Malgun Gothic',system-ui,sans-serif;max-width:460px;margin:15vh auto;padding:0 20px;line-height:1.7"><h2>${esc(title)}</h2><p>${esc(body)}</p><p><a href="/#calendar">대시보드로 돌아가기</a></p><script>setTimeout(()=>{try{window.close()}catch(e){}},2500)</script></body></html>`;

export function createExtraRoutes({cloud,calendar,gcal,tasks,getGrants,listLocal=listLocalDefault,reveal=revealDefault}){
  return async function handle(req,res,url,{json,readJson,port}){
    const path=url.pathname,method=req.method;
    const known=path.startsWith('/api/cloud/')||path.startsWith('/api/calendar/')||path.startsWith('/api/storage/')||path==='/api/tasks'||path.startsWith('/api/tasks/')||path==='/oauth/google/callback';
    if(!known)return false;
    try{
      // ── 할 일 ──
      if(path==='/api/tasks'&&method==='GET')return json(res,200,{tasks:await tasks.list()}),true;
      if(path==='/api/tasks'&&method==='POST')return json(res,201,{task:await tasks.create(await readJson(req))}),true;
      if(path==='/api/tasks/clear-done'&&method==='POST')return json(res,200,await tasks.clearDone()),true;
      const taskMatch=path.match(/^\/api\/tasks\/([0-9a-f-]{36})$/i);
      if(taskMatch&&method==='PATCH')return json(res,200,{task:await tasks.update(taskMatch[1],await readJson(req))}),true;
      if(taskMatch&&method==='DELETE')return json(res,200,await tasks.remove(taskMatch[1])),true;
      // ── 라피스 클라우드 ──
      if(path.startsWith('/api/cloud/')){
        const rest=path.slice('/api/cloud'.length);
        if(method==='GET'&&rest==='/state')return json(res,200,await cloud.state()),true;
        if(method==='POST'&&rest==='/login/start')return json(res,200,await cloud.startGoogleLogin()),true;
        if(method==='POST'&&rest==='/login/poll'){const b=await readJson(req);return json(res,200,await cloud.pollGoogleLogin(String(b.attemptId||''))),true;}
        if(method==='POST'&&rest==='/logout')return json(res,200,await cloud.logout()),true;
        if(method==='POST'&&rest==='/google/connect'){const b=await readJson(req);return json(res,200,await cloud.startGoogleConnect(b.services,b.tier)),true;}
        if(method==='POST'&&rest==='/google/connect/poll'){const b=await readJson(req);return json(res,200,await cloud.pollGoogleConnect(String(b.attemptId||''))),true;}
        const body=['GET','HEAD'].includes(method)?undefined:await readJson(req);
        const result=await cloud.call(method,rest,{query:url.search,body});
        res.writeHead(result.status,{'content-type':result.contentType,'cache-control':'no-store'});res.end(result.text);return true;
      }
      // ── 캘린더 ──
      if(path==='/oauth/google/callback'&&method==='GET'){
        try{
          await gcal.completeAuth({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error')});
          res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page('Google 캘린더가 연결되었습니다','이 창을 닫고 대시보드에서 「지금 동기화」를 눌러 주세요.'));
        }catch(error){
          res.writeHead(error.status||400,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page('연결하지 못했습니다',error.message));
        }
        return true;
      }
      if(path==='/api/calendar/events'&&method==='GET'){
        return json(res,200,{events:await calendar.list(url.searchParams.get('from')||'',url.searchParams.get('to')||'')}),true;
      }
      if(path==='/api/calendar/events'&&method==='POST')return json(res,201,{event:await calendar.create(await readJson(req))}),true;
      const eventMatch=path.match(/^\/api\/calendar\/events\/([0-9a-f-]{36})$/i);
      if(eventMatch&&method==='PATCH')return json(res,200,{event:await calendar.update(eventMatch[1],await readJson(req))}),true;
      if(eventMatch&&method==='DELETE')return json(res,200,await calendar.remove(eventMatch[1])),true;
      if(path==='/api/calendar/export.ics'&&method==='GET'){
        res.writeHead(200,{'content-type':'text/calendar; charset=utf-8','content-disposition':'attachment; filename="lapis-calendar.ics"','cache-control':'no-store'});res.end(await calendar.ics());return true;
      }
      if(path==='/api/calendar/google'&&method==='GET')return json(res,200,await gcal.status()),true;
      if(path==='/api/calendar/google/config'&&method==='POST')return json(res,200,await gcal.saveConfig(await readJson(req))),true;
      if(path==='/api/calendar/google/connect'&&method==='POST')return json(res,200,await gcal.beginAuth('http://127.0.0.1:'+port+'/oauth/google/callback')),true;
      if(path==='/api/calendar/google/sync'&&method==='POST')return json(res,200,await gcal.sync()),true;
      if(path==='/api/calendar/google/disconnect'&&method==='POST')return json(res,200,await gcal.disconnect()),true;
      // ── 저장소(맡긴 드라이브) ──
      if(path==='/api/storage/local'&&method==='GET')return json(res,200,{roots:await getGrants()}),true;
      if(path==='/api/storage/local/list'&&method==='GET')return json(res,200,await listLocal(url.searchParams.get('path')||'',await getGrants())),true;
      if(path==='/api/storage/local/reveal'&&method==='POST'){const b=await readJson(req);return json(res,200,await reveal(String(b.path||''),await getGrants())),true;}
    }catch(error){
      if(error instanceof CloudError||error instanceof CalendarError||error instanceof StorageError||error instanceof TaskError){json(res,error.status||500,{error:error.message});return true;}
      throw error;
    }
    json(res,405,{error:'허용되지 않는 요청입니다.'});return true;
  };
}
