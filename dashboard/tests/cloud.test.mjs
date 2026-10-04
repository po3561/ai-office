import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVault,plain,dpapi} from '../src/vault.mjs';
import {createCloud,cloudRouteAllowed} from '../src/lapis-cloud.mjs';
import {createCalendarStore,createGoogleCalendar,cleanEvent} from '../src/calendar.mjs';
import {listLocal,normalizePath,allowedUnder,reveal} from '../src/storage.mjs';
import {createDashboardServer} from '../src/server.mjs';

const tmp=()=>mkdtemp(join(tmpdir(),'lapis-test-'));
const reply=(status,data,type='application/json')=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'content-type':type}});

test('vault keeps secrets only in the sealed file and survives restart',async()=>{
  const dir=await tmp(),file=join(dir,'v.bin');
  const vault=createVault(file,plain);
  await vault.update({cloud:{accessToken:'tok-secret'}});
  assert.equal((await createVault(file,plain).read()).cloud.accessToken,'tok-secret');
  await vault.update({cloud:undefined});
  assert.equal((await createVault(file,plain).read()).cloud,undefined);
  await writeFile(file,'%%%not base64 json');
  await assert.rejects(()=>createVault(file,plain).read(),/연결 정보/);
});
test('Windows DPAPI round trip works on this machine',{skip:process.platform!=='win32'},async()=>{
  const sealed=await dpapi.protect(Buffer.from('비밀 값'));
  assert.notEqual(sealed.toString('utf8'),'비밀 값');
  assert.equal((await dpapi.unprotect(sealed)).toString('utf8'),'비밀 값');
});

function fakeWorker(){
  const log=[];let accessToken='access-1',refreshCount=0,complete='pending',connectDone=false;
  const handler=async(url,init={})=>{
    const route=new URL(url).pathname.replace('/api/v1','');const method=init.method||'GET';
    const body=init.body?JSON.parse(init.body):undefined;const auth=init.headers?.Authorization;
    log.push({method,route,auth,body});
    if(route==='/auth/google/start')return reply(201,{attempt_id:'a1',poll_token:'p1',authorization_url:'https://accounts.google.com/o/oauth2/auth?x=1',expires_at:new Date(Date.now()+600000).toISOString()});
    if(route==='/auth/google/complete'){
      if(body.poll_token!=='p1')return reply(400,{error:'bad poll'});
      return complete==='pending'?reply(200,{status:'pending'}):reply(200,{status:'completed',access_token:accessToken,refresh_token:'refresh-1',user:{id:'u1',email:'me@example.com',display_name:'나'}});
    }
    if(route==='/auth/refresh'){refreshCount++;if(body.refresh_token!=='refresh-1')return reply(401,{error:'revoked'});accessToken='access-2';return reply(200,{access_token:'access-2',refresh_token:'refresh-1'});}
    if(route==='/auth/logout')return reply(200,{ok:true});
    if(route==='/integrations/google-drive/authorize')return reply(200,{attempt_id:'c1',poll_token:'cp1',authorization_url:'https://accounts.google.com/o/oauth2/auth?y=1',expires_at:new Date(Date.now()+600000).toISOString()});
    if(route==='/integrations/google-drive/authorize/complete')return reply(200,{status:connectDone?'completed':'pending'});
    if(auth!=='Bearer '+accessToken)return reply(401,{error:'unauthorized'});
    if(route==='/memories'&&method==='GET')return reply(200,{ok:true,memories:[{id:'m1',content:'커피는 아메리카노',claim:'아메리카노',confidence:0.9,status:'CONFIRMED'}]});
    if(route==='/integrations/google-drive/browse')return reply(200,{ok:true,folderId:null,entries:[]});
    return reply(404,{error:'unknown '+route});
  };
  return {handler,log,setComplete:()=>{complete='done';},setConnected:()=>{connectDone=true;},get refreshCount(){return refreshCount;},expireAccess:()=>{accessToken='access-new-server-side';}};
}

test('Google login stores tokens in the vault, refreshes once on 401, and logs out cleanly',async()=>{
  const dir=await tmp(),worker=fakeWorker(),vault=createVault(join(dir,'v.bin'),plain);
  const cloud=createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:worker.handler});
  assert.deepEqual(await cloud.state(),{signedIn:false});
  await assert.rejects(()=>cloud.call('GET','/memories'),/로그인/);
  const start=await cloud.startGoogleLogin();
  assert.equal(start.attemptId,'a1');assert.ok(start.url.startsWith('https://accounts.google.com/'));
  assert.deepEqual(await cloud.pollGoogleLogin('a1'),{status:'pending'});
  assert.equal((await cloud.state()).signedIn,false);
  worker.setComplete();
  const done=await cloud.pollGoogleLogin('a1');
  assert.equal(done.status,'completed');assert.equal(done.user.email,'me@example.com');
  assert.equal(JSON.stringify(await cloud.state()).includes('refresh'),false,'tokens must not leave the server');
  worker.expireAccess();
  const memories=await cloud.call('GET','/memories');
  assert.equal(memories.status,200);assert.equal(worker.refreshCount,1);
  assert.equal((await vault.read()).cloud.accessToken,'access-2');
  await cloud.logout();
  assert.deepEqual(await cloud.state(),{signedIn:false});
});
test('a revoked session logs the user out but a network failure keeps the login',async()=>{
  const dir=await tmp(),worker=fakeWorker(),vault=createVault(join(dir,'v.bin'),plain);
  await vault.update({cloud:{accessToken:'old',refreshToken:'revoked',user:{id:'u1',email:'a@b.c',name:'a'}}});
  const cloud=createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:worker.handler});
  await assert.rejects(()=>cloud.call('GET','/memories'),/만료/);
  assert.equal((await cloud.state()).signedIn,false);
  await vault.update({cloud:{accessToken:'old',refreshToken:'refresh-1',user:{id:'u1',email:'a@b.c',name:'a'}}});
  const offline=createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:async()=>{throw new Error('offline');}});
  await assert.rejects(()=>offline.call('GET','/memories'),/연결할 수 없습니다/);
  assert.equal((await offline.state()).signedIn,true);
});
test('only allow-listed cloud routes can be called and Google connect validates its input',async()=>{
  assert.ok(cloudRouteAllowed('GET','/memories'));assert.ok(cloudRouteAllowed('POST','/integrations/google-drive/tools/read'));
  for(const [m,p] of [['GET','/admin/users'],['POST','/integrations/telegram/connect'],['DELETE','/memories'],['GET','/memories/../admin/users'],['POST','/auth/logout-all']])assert.equal(cloudRouteAllowed(m,p),false,m+' '+p);
  const dir=await tmp(),worker=fakeWorker(),vault=createVault(join(dir,'v.bin'),plain);
  await vault.update({cloud:{accessToken:'access-1',refreshToken:'refresh-1',user:{id:'u1',email:'a@b.c',name:'a'}}});
  const cloud=createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:worker.handler});
  await assert.rejects(()=>cloud.call('GET','/admin/users'),/연결되지 않은/);
  await assert.rejects(()=>cloud.startGoogleConnect(['drive','root-access']),/서비스/);
  await assert.rejects(()=>cloud.startGoogleConnect(['drive'],'god'),/단계/);
  const attempt=await cloud.startGoogleConnect(['drive','calendar'],'standard');
  assert.deepEqual(await cloud.pollGoogleConnect(attempt.attemptId),{status:'pending'});
  worker.setConnected();
  assert.deepEqual(await cloud.pollGoogleConnect(attempt.attemptId),{status:'completed'});
  const sent=worker.log.find(r=>r.route==='/integrations/google-drive/authorize').body;
  assert.deepEqual(sent.services,['drive','calendar']);
});

test('calendar events are validated, queried by range, edited, deleted and exported',async()=>{
  const store=createCalendarStore(join(await tmp(),'cal.json'));
  assert.throws(()=>cleanEvent({title:'',start:'2026-10-05',end:'2026-10-05',allDay:true}),/제목/);
  assert.throws(()=>cleanEvent({title:'x',allDay:true,start:'2026-10-06',end:'2026-10-05'}),/빠릅니다/);
  assert.throws(()=>cleanEvent({title:'x',allDay:true,start:'2026-02-31',end:'2026-02-31'}),/날짜/);
  const a=await store.create({title:'가을 축제 회의',allDay:false,start:'2026-10-05T10:00:00.000Z',end:'2026-10-05T11:00:00.000Z',location:'회의실, 2층'});
  const b=await store.create({title:'연휴',allDay:true,start:'2026-10-09',end:'2026-10-11'});
  const week=await store.list('2026-10-05','2026-10-12');
  assert.deepEqual(week.map(e=>e.title).sort(),['가을 축제 회의','연휴']);
  assert.equal((await store.list('2026-10-12','2026-10-20')).length,0);
  assert.equal((await store.list('2026-10-11','2026-10-12')).length,1,'multi-day all-day event covers its last day');
  const moved=await store.update(a.id,{title:'회의(변경)'});assert.equal(moved.title,'회의(변경)');
  const ics=await store.ics();
  assert.ok(ics.includes('BEGIN:VCALENDAR')&&ics.includes('SUMMARY:회의(변경)')&&ics.includes('DTSTART;VALUE=DATE:20261009')&&ics.includes('DTEND;VALUE=DATE:20261012'));
  assert.ok(ics.includes('LOCATION:회의실\\, 2층'));
  await store.remove(b.id);await assert.rejects(()=>store.update(b.id,{title:'x'}),/찾을 수 없습니다/);
  assert.equal((await createCalendarStore(join(await tmp(),'none.json')).all()).length,0);
});
test('a corrupted calendar file is never overwritten',async()=>{
  const file=join(await tmp(),'cal.json');await writeFile(file,'{broken');
  const store=createCalendarStore(file);
  await assert.rejects(()=>store.create({title:'x',allDay:true,start:'2026-10-05',end:'2026-10-05'}),/읽지 못했습니다/);
  assert.equal(await readFile(file,'utf8'),'{broken');
});

function fakeGoogle(){
  const remote=new Map(),log=[];let seq=0,tokenCalls=0;
  const handler=async(url,init={})=>{
    const u=new URL(url),method=init.method||'GET';log.push(method+' '+u.pathname);
    if(u.href.startsWith('https://oauth2.googleapis.com/token')){
      tokenCalls++;const p=new URLSearchParams(init.body);
      if(p.get('grant_type')==='authorization_code'){
        if(p.get('code')!=='good-code'||!p.get('code_verifier'))return reply(400,{error:'invalid_grant'});
        return reply(200,{access_token:'ga-1',refresh_token:'gr-1',expires_in:3600});
      }
      return reply(200,{access_token:'ga-'+(++tokenCalls),expires_in:3600});
    }
    if(u.href.startsWith('https://oauth2.googleapis.com/revoke'))return reply(200,{});
    if(!u.pathname.startsWith('/calendar/v3/calendars/primary/events'))return reply(404,{});
    if(!init.headers?.authorization?.startsWith('Bearer ga-'))return reply(401,{error:{message:'no token'}});
    const id=u.pathname.split('/')[6];
    if(method==='GET'&&!id)return reply(200,{items:[...remote.values()]});
    const body=init.body?JSON.parse(init.body):{};
    if(method==='POST'){const e={id:'g'+(++seq),status:'confirmed',updated:new Date().toISOString(),...body};remote.set(e.id,e);return reply(200,e);}
    if(method==='PATCH'){const e=remote.get(id);if(!e)return reply(404,{error:{message:'gone'}});Object.assign(e,body,{updated:new Date(Date.now()+1000).toISOString()});return reply(200,e);}
    if(method==='DELETE'){if(!remote.delete(id))return reply(404,{});return new Response(null,{status:204});}
    return reply(400,{});
  };
  return {handler,remote,log,get tokenCalls(){return tokenCalls;}};
}
test('Google Calendar connects with PKCE and syncs both ways without duplicating events',async()=>{
  const dir=await tmp(),google=fakeGoogle();
  const vault=createVault(join(dir,'v.bin'),plain),store=createCalendarStore(join(dir,'cal.json'));
  const gcal=createGoogleCalendar({vault,store,fetchImpl:google.handler});
  const initial=await gcal.status();
  assert.deepEqual([initial.mode,initial.configured,initial.connected,initial.signedIn],['lapis',false,false,false],'without an own client the LAPIS account is the default');
  await assert.rejects(()=>gcal.saveConfig({clientId:'bad',clientSecret:'GOCSPX-secretvalue'}),/클라이언트 ID/);
  await gcal.saveConfig({clientId:'123-abc.apps.googleusercontent.com',clientSecret:'GOCSPX-secretvalue'});
  const {url}=await gcal.beginAuth('http://127.0.0.1:4310/oauth/google/callback');
  const params=new URL(url).searchParams;
  assert.equal(params.get('code_challenge_method'),'S256');assert.equal(params.get('access_type'),'offline');
  assert.ok(params.get('scope').endsWith('/auth/calendar.events'));
  await assert.rejects(()=>gcal.completeAuth({state:'forged',code:'good-code'}),/만료되었거나/);
  await gcal.beginAuth('http://127.0.0.1:4310/oauth/google/callback');
  const second=new URL((await gcal.beginAuth('http://127.0.0.1:4310/oauth/google/callback')).url).searchParams.get('state');
  const connected=await gcal.completeAuth({state:second,code:'good-code'});
  assert.deepEqual([connected.mode,connected.connected],['own',true]);
  await assert.rejects(()=>gcal.completeAuth({state:second,code:'good-code'}),/만료되었거나/,'state is single use');
  assert.equal(JSON.stringify(await gcal.status()).includes('secret'),false);

  const local=await store.create({title:'로컬에서 만든 일정',allDay:true,start:'2026-10-20',end:'2026-10-21'});
  google.remote.set('r1',{id:'r1',status:'confirmed',summary:'구글에서 만든 회의',start:{dateTime:'2026-10-07T01:00:00Z'},end:{dateTime:'2026-10-07T02:00:00Z'},updated:'2026-10-01T00:00:00Z'});
  google.remote.set('r2',{id:'r2',status:'confirmed',summary:'종일 행사',start:{date:'2026-10-09'},end:{date:'2026-10-11'},updated:'2026-10-01T00:00:00Z'});
  const first=await gcal.sync();
  assert.deepEqual({pulled:first.pulled,pushed:first.pushed,errors:first.errors},{pulled:2,pushed:1,errors:[]});
  const events=await store.all();
  assert.equal(events.length,3);
  const allDay=events.find(e=>e.title==='종일 행사');assert.deepEqual([allDay.start,allDay.end],['2026-10-09','2026-10-10'],'Google exclusive end date becomes an inclusive end');
  assert.equal(events.find(e=>e.id===local.id).googleId!==null,true);
  const second2=await gcal.sync();
  assert.deepEqual({pulled:second2.pulled,pushed:second2.pushed},{pulled:0,pushed:0},'a second sync changes nothing');
  assert.equal((await store.all()).length,3);

  await store.update(local.id,{title:'로컬에서 이름 변경'});
  google.remote.get('r1').summary='구글에서 이름 변경';google.remote.get('r1').updated=new Date(Date.now()+60000).toISOString();
  const third=await gcal.sync();
  assert.equal(third.pushed,1);assert.equal(third.updated,1);
  assert.ok(google.remote.get((await store.all()).find(e=>e.id===local.id).googleId).summary==='로컬에서 이름 변경');
  assert.ok((await store.all()).some(e=>e.title==='구글에서 이름 변경'));

  await store.remove(local.id);google.remote.get('r2').status='cancelled';
  const fourth=await gcal.sync();
  assert.equal(fourth.errors.length,0);
  assert.equal((await store.all()).some(e=>e.title==='종일 행사'),false,'a cancelled Google event is removed locally');
  assert.equal([...google.remote.values()].some(e=>e.summary==='로컬에서 이름 변경'),false,'a local deletion is removed from Google');
  assert.equal((await gcal.disconnect()).connected,false);
});

function fakeLapisCalendar(){
  const cals={primary:new Map(),'youth@example.com':new Map()},log=[];let seq=0;
  const status={ok:true,connected:true,readable:true,writable:true,calendars:true,reauthRequired:false,account:'me@example.com'};
  return {cals,log,status,
    state:async()=>({signedIn:true,user:{id:'u1',email:'me@example.com',name:'나'}}),
    startGoogleCalendarConnect:async()=>({attemptId:'a1',url:'https://accounts.google.com/o/oauth2/v2/auth?x=1'}),
    pollGoogleConnect:async id=>({status:id==='a1'?'completed':'pending'}),
    async calendarApi(method,path,{body}={}){
      log.push(method+' '+path);
      if(path==='/status')return {...status};
      if(path==='/users/me/calendarList')return {items:[{id:'me@example.com',summary:'나',primary:true,accessRole:'owner',selected:true},{id:'youth@example.com',summary:'청년회',accessRole:'reader',selected:true},{id:'off@example.com',summary:'꺼 둔 캘린더',accessRole:'owner',selected:false}]};
      const m=path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/),events=cals[decodeURIComponent(m[1])],id=m[2]&&decodeURIComponent(m[2]);
      if(method==='GET')return {items:[...events.values()]};
      if(method==='POST'){const e={id:'n'+(++seq),status:'confirmed',updated:new Date().toISOString(),...body};events.set(e.id,e);return e;}
      if(method==='PATCH'){Object.assign(events.get(id),body,{updated:new Date(Date.now()+1000).toISOString()});return events.get(id);}
      if(method==='DELETE'){if(!events.delete(id))throw Object.assign(new Error('gone'),{status:404});return {ok:true};}
    }};
}
test('Google Calendar syncs through the LAPIS account across calendars and keeps read-only calendars read-only',async()=>{
  const dir=await tmp(),cloud=fakeLapisCalendar();
  const vault=createVault(join(dir,'v.bin'),plain),store=createCalendarStore(join(dir,'cal.json'));
  const gcal=createGoogleCalendar({vault,store,cloud,fetchImpl:async()=>{throw Error('no direct Google calls in LAPIS mode');}});
  const before=await gcal.status();
  assert.deepEqual([before.mode,before.signedIn,before.linked,before.connected],['lapis',true,true,false],'linked on the account but not yet synced on this PC');
  await assert.rejects(()=>gcal.sync(),/연결되어 있지 않습니다/);
  assert.equal((await gcal.beginLapis()).attemptId,'a1');
  assert.deepEqual(await gcal.pollLapis('a1'),{status:'completed'});
  assert.equal((await gcal.status()).connected,true);

  cloud.cals.primary.set('p1',{id:'p1',status:'confirmed',summary:'내 회의',start:{dateTime:'2026-10-07T01:00:00Z'},end:{dateTime:'2026-10-07T02:00:00Z'},updated:'2026-10-01T00:00:00Z'});
  cloud.cals['youth@example.com'].set('y1',{id:'y1',status:'confirmed',summary:'청년회 모임',start:{date:'2026-10-11'},end:{date:'2026-10-12'},updated:'2026-10-01T00:00:00Z'});
  const local=await store.create({title:'라피스에서 만든 일정',allDay:true,start:'2026-10-20',end:'2026-10-20'});
  const first=await gcal.sync();
  assert.deepEqual({pulled:first.pulled,pushed:first.pushed,errors:first.errors},{pulled:2,pushed:1,errors:[]});
  assert.equal(cloud.log.some(l=>l.includes('off%40example.com')),false,'calendars hidden in Google are not synced');
  const all=await store.all(),youth=all.find(e=>e.title==='청년회 모임'),mine=all.find(e=>e.title==='내 회의');
  assert.deepEqual([youth.readOnly,youth.calendarName,youth.googleCalendarId],[true,'청년회','youth@example.com']);
  assert.equal(mine.readOnly,false);assert.notEqual(youth.color,mine.color);
  assert.ok([...cloud.cals.primary.values()].some(e=>e.summary==='라피스에서 만든 일정'),'new local events go to the primary calendar');
  await assert.rejects(()=>store.update(youth.id,{title:'바꾸기'}),/읽기 전용/);
  await assert.rejects(()=>store.remove(youth.id),/읽기 전용/);
  const second=await gcal.sync();
  assert.deepEqual({pulled:second.pulled,pushed:second.pushed},{pulled:0,pushed:0},'a second sync changes nothing');

  await store.update(mine.id,{title:'내 회의(변경)'});await store.remove(local.id);
  const third=await gcal.sync();
  assert.equal(third.errors.length,0);
  assert.equal(cloud.cals.primary.get('p1').summary,'내 회의(변경)');
  assert.equal([...cloud.cals.primary.values()].some(e=>e.summary==='라피스에서 만든 일정'),false,'a local deletion reaches Google');

  cloud.status.writable=false;
  await store.create({title:'쓰기 권한 없을 때',allDay:true,start:'2026-10-21',end:'2026-10-21'});
  const posts=cloud.log.filter(l=>l.startsWith('POST')).length;
  const fourth=await gcal.sync();
  assert.ok(fourth.errors.some(e=>e.includes('쓰기 권한')));
  assert.equal(cloud.log.filter(l=>l.startsWith('POST')).length,posts,'nothing is written without the write scope');
  assert.equal((await store.all()).find(e=>e.title==='내 회의(변경)').readOnly,true,'every Google event becomes read-only without the write scope');

  const off=await gcal.disconnect();
  assert.deepEqual([off.connected,off.linked],[false,true],'turning sync off keeps the account-level Google connection');
});

test('storage only lists drives the office was granted and never shows bot secrets',async()=>{
  const root=await tmp();const share=join(root,'공유').replace(/\\/g,'/');
  await mkdir(join(root,'공유','하위'),{recursive:true});await mkdir(join(root,'공유','.telegram'),{recursive:true});
  await writeFile(join(root,'공유','보고서.txt'),'hello');await mkdir(join(root,'비공개'),{recursive:true});
  const listing=await listLocal(share,[share]);
  assert.deepEqual(listing.entries.map(e=>e.name),['하위','보고서.txt']);
  assert.equal(listing.entries.find(e=>e.name==='보고서.txt').size,5);
  await assert.rejects(()=>listLocal(join(root,'비공개').replace(/\\/g,'/'),[share]),/맡기지 않은/);
  await assert.rejects(()=>listLocal(share+'/../비공개',[share]),/쓸 수 없는/);
  await assert.rejects(()=>listLocal(share+'/.telegram',[share]),/토큰/);
  await assert.rejects(()=>listLocal('/etc',[share]),/드라이브 경로/);
  assert.equal(allowedUnder(normalizePath('D:/공유자료/x'),['D:\\공유자료']),true);
  assert.equal(allowedUnder(normalizePath('D:/공유자료-다른'),['D:\\공유자료']),false);
  const calls=[];
  await reveal(share+'/보고서.txt',[share],(...args)=>{calls.push(args);return {unref(){}};});
  assert.equal(calls[0][0],'explorer.exe');assert.ok(calls[0][1][0].startsWith('/select,"'));
  await assert.rejects(()=>reveal(join(root,'비공개').replace(/\\/g,'/'),[share],()=>({})),/맡긴 위치/);
});

async function serve(t,options){
  const dir=await tmp();
  const server=createDashboardServer({telegramSnapshot:async()=>({bots:[],messages:[]}),dataDir:dir,vault:createVault(join(dir,'v.bin'),plain),...options});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return 'http://127.0.0.1:'+server.address().port;
}
const guard={'content-type':'application/json','x-lapis-request':'1'};
test('server exposes calendar CRUD, guards mutations, and rejects cross-site except the OAuth return',async t=>{
  const worker=fakeGoogle();
  const base=await serve(t,{googleFetch:worker.handler,grants:async()=>[]});
  const body=JSON.stringify({title:'서버 일정',allDay:true,start:'2026-10-05',end:'2026-10-05'});
  assert.equal((await fetch(base+'/api/calendar/events',{method:'POST',headers:{'content-type':'application/json'},body})).status,403,'mutation needs the dashboard header');
  const made=await (await fetch(base+'/api/calendar/events',{method:'POST',headers:guard,body})).json();
  assert.equal(made.event.title,'서버 일정');
  const list=await (await fetch(base+'/api/calendar/events?from=2026-10-01&to=2026-11-01')).json();
  assert.equal(list.events.length,1);
  assert.equal((await fetch(base+'/api/calendar/events?from=bad&to=worse')).status,400);
  const patched=await fetch(base+'/api/calendar/events/'+made.event.id,{method:'PATCH',headers:guard,body:JSON.stringify({title:'변경'})});
  assert.equal((await patched.json()).event.title,'변경');
  assert.equal((await fetch(base+'/api/calendar/export.ics')).headers.get('content-type').startsWith('text/calendar'),true);
  assert.equal((await fetch(base+'/api/calendar/events/'+made.event.id,{method:'DELETE',headers:guard})).status,200);
  assert.equal((await fetch(base+'/api/calendar/events',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  const callback=await fetch(base+'/oauth/google/callback?state=zzz&code=1',{headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(callback.status,400,'the OAuth return page is reachable cross-site but rejects an unknown state');
  assert.ok((await callback.text()).includes('만료되었거나'));
});
test('server proxies only allow-listed cloud routes with the stored login and never returns tokens',async t=>{
  const worker=fakeWorker();
  const base=await serve(t,{cloudBase:'https://cloud.test/api/v1',cloudFetch:worker.handler,grants:async()=>[]});
  assert.deepEqual(await (await fetch(base+'/api/cloud/state')).json(),{signedIn:false});
  assert.equal((await fetch(base+'/api/cloud/memories')).status,401);
  assert.equal((await fetch(base+'/api/cloud/admin/users')).status,404);
  const start=await (await fetch(base+'/api/cloud/login/start',{method:'POST',headers:guard,body:'{}'})).json();
  worker.setComplete();
  const done=await (await fetch(base+'/api/cloud/login/poll',{method:'POST',headers:guard,body:JSON.stringify({attemptId:start.attemptId})})).json();
  assert.equal(done.status,'completed');
  const memories=await (await fetch(base+'/api/cloud/memories')).json();
  assert.equal(memories.memories[0].claim,'아메리카노');
  const browse=await fetch(base+'/api/cloud/integrations/google-drive/browse',{method:'POST',headers:guard,body:JSON.stringify({folderId:null})});
  assert.equal(browse.status,200);
  assert.equal(JSON.stringify(await (await fetch(base+'/api/cloud/state')).json()).includes('access-'),false);
  assert.equal((await fetch(base+'/api/cloud/memories',{method:'POST',body:'{}'})).status,403);
});
test('storage routes use the office grants and refuse everything else',async t=>{
  const root=await tmp();const share=join(root,'공유').replace(/\\/g,'/');await mkdir(share,{recursive:true});await writeFile(join(share,'a.txt'),'x');
  const base=await serve(t,{grants:async()=>[share]});
  assert.deepEqual((await (await fetch(base+'/api/storage/local')).json()).roots,[share]);
  const listed=await (await fetch(base+'/api/storage/local/list?path='+encodeURIComponent(share))).json();
  assert.equal(listed.entries[0].name,'a.txt');
  assert.equal((await fetch(base+'/api/storage/local/list?path='+encodeURIComponent(root.replace(/\\/g,'/')))).status,403);
});
test('the cloud calendar proxy only reaches calendar paths with the stored login',async()=>{
  const dir=await tmp(),vault=createVault(join(dir,'v.bin'),plain),calls=[];
  await vault.update({cloud:{accessToken:'access-1',refreshToken:'refresh-1',user:{id:'u1',email:'me@example.com',name:'나'}}});
  const cloud=createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:async(url,init)=>{calls.push({url,init});return reply(200,{items:[]});}});
  await cloud.calendarApi('GET','/calendars/'+encodeURIComponent('youth@example.com')+'/events',{query:{timeMin:'2026-10-01T00:00:00Z',pageToken:undefined}});
  assert.equal(calls[0].url,'https://cloud.test/api/v1/integrations/google-calendar/calendars/youth%40example.com/events?timeMin=2026-10-01T00%3A00%3A00Z');
  assert.equal(calls[0].init.headers.Authorization,'Bearer access-1');
  for(const path of ['/calendars/primary/acl','/../admin/users','/users/me/settings'])await assert.rejects(()=>cloud.calendarApi('GET',path),/연결되지 않은/);
  assert.equal(calls.length,1);
});
