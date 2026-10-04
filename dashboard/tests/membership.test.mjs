import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVault,plain} from '../src/vault.mjs';
import {createCloud,sniffImage} from '../src/lapis-cloud.mjs';
import {createAccounts} from '../src/accounts.mjs';
import {createTaskStore} from '../src/tasks.mjs';
import {createCalendarStore} from '../src/calendar.mjs';
import {createDashboardServer} from '../src/server.mjs';

const tmp=()=>mkdtemp(join(tmpdir(),'lapis-member-'));
const reply=(status,data,headers={})=>new Response(typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(32,1)]);
const UID1='11111111-1111-4111-8111-111111111111',UID2='22222222-2222-4222-8222-222222222222';

// 가짜 라피스 서버: 가입·로그인·프로필·사진·동기화
function fakeWorker(){
  const users=new Map();           // email -> {id,username,email,name,password}
  const calls=[];
  let profile={name:'',phone:null,revision:0},avatar=null,sync=null,syncRev=0;
  const handler=async(url,init={})=>{
    const path=new URL(url).pathname.replace('/api/v1','');const method=init.method||'GET';
    const body=typeof init.body==='string'&&init.body?JSON.parse(init.body):init.body;
    calls.push({path,method,body,auth:init.headers?.Authorization});
    const session=u=>({ok:true,access_token:'access-'+u.id,refresh_token:'refresh-'+u.id,user:{id:u.id,username:u.username,email:u.email,name:u.name}});
    if(path==='/legal/consents/current')return reply(200,{documents:[{consent_type:'terms',version:'1',title:'이용약관',body_markdown:'본문',document_hash:'h1',required:true}]});
    if(path==='/auth/register'){
      if(users.has(body.email))return reply(409,{error:'Email or username is already registered'});
      const u={id:users.size?UID2:UID1,username:body.username,email:body.email,name:body.display_name,password:body.password};users.set(u.email,u);return reply(201,session(u));
    }
    if(path==='/auth/login'){
      const u=[...users.values()].find(x=>x.email===body.identifier||x.username===body.identifier);
      return u&&u.password===body.password?reply(200,session(u)):reply(401,{error:'Identifier or password is incorrect'});
    }
    if(!String(init.headers?.Authorization||'').startsWith('Bearer access-'))return reply(401,{error:'Unauthorized'});
    if(path==='/auth/me'){const u=[...users.values()].find(x=>'access-'+x.id===init.headers.Authorization.slice(7));return reply(200,{ok:true,user:{id:u.id,username:u.username,email:u.email,name:u.name,created_at:'2026-10-04'}});}
    if(path==='/me/identity-profile'&&method==='GET')return reply(200,{ok:true,profile:{name:profile.name,phone:profile.phone},revision:profile.revision});
    if(path==='/me/identity-profile'&&method==='PUT'){
      if(body.expected_revision!==profile.revision)return reply(409,{error:'changed'});
      profile={name:body.name,phone:body.phone,revision:profile.revision+1};return reply(200,{ok:true,profile:{name:profile.name,phone:profile.phone},revision:profile.revision});
    }
    if(path==='/me/avatar'&&method==='GET')return avatar?new Response(avatar,{status:200,headers:{'content-type':'image/png'}}):reply(404,'');
    if(path==='/me/avatar'&&method==='PUT'){avatar=Buffer.from(init.body);return reply(200,{ok:true});}
    if(path==='/me/avatar'&&method==='DELETE'){avatar=null;return reply(200,{ok:true});}
    if(path==='/dashboard-sync'&&method==='GET')return reply(200,{ok:true,revision:syncRev,updatedAt:sync?'2026-10-04T00:00:00Z':null,snapshot:sync});
    if(path==='/dashboard-sync'&&method==='PUT'){sync=body.snapshot;syncRev+=1;return reply(200,{ok:true,revision:syncRev,updatedAt:'2026-10-04T00:00:01Z'});}
    return reply(404,{error:'no'});
  };
  return {handler,calls,get avatar(){return avatar;}};
}
const makeCloud=async()=>{const dir=await tmp(),worker=fakeWorker(),vault=createVault(join(dir,'v.bin'),plain);return {dir,worker,vault,cloud:createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:worker.handler})};};
const REG={username:'kim.lapis',email:'kim@example.com',displayName:'라피',phone:'010-1234-5678',password:'correct horse battery',consents:[{consentType:'terms',version:'1',documentHash:'h1',granted:true}]};

test('회원가입 → 로그인 상태가 되고 토큰은 보관소에만 남는다',async()=>{
  const {cloud,vault,worker}=await makeCloud();
  const docs=await cloud.consents();
  assert.equal(docs[0].required,true);
  const r=await cloud.register(REG);
  assert.equal(r.signedIn,true);assert.equal(r.user.name,'라피');
  assert.equal(JSON.stringify(r).includes('access-'),false,'화면으로 나가는 값에 토큰이 없어야 한다');
  assert.equal((await vault.read()).cloud.accessToken,'access-'+UID1);
  const sent=worker.calls.find(c=>c.path==='/auth/register').body;
  assert.equal(sent.display_name,'라피');assert.equal(sent.consents[0].consent_type,'terms');
  await assert.rejects(()=>cloud.register(REG),e=>e.status===409&&/이미 가입/.test(e.message));
});

test('가입 입력은 서버에 보내기 전에 검사한다',async()=>{
  const {cloud,worker}=await makeCloud();
  for(const bad of [{username:'ab'},{email:'not-mail'},{displayName:''},{password:'short'}])
    await assert.rejects(()=>cloud.register({...REG,...bad}),e=>e.status===400);
  assert.equal(worker.calls.some(c=>c.path==='/auth/register'),false);
});

test('로그인: 틀리면 거절, 8번 틀리면 이 PC 에서도 잠시 멈춘다, 맞으면 이어서 쓸 수 있다',async()=>{
  const {cloud,worker}=await makeCloud();
  await cloud.register(REG);await cloud.logout();
  assert.equal((await cloud.state()).signedIn,false);
  await assert.rejects(()=>cloud.login({identifier:'kim.lapis',password:'wrong password!!'}),e=>e.status===401);
  const ok=await cloud.login({identifier:'kim@example.com',password:REG.password});
  assert.equal(ok.user.email,'kim@example.com');
  await cloud.logout();
  for(let i=0;i<8;i++)await cloud.login({identifier:'zed',password:'nope nope nope'}).catch(()=>{});
  const before=worker.calls.length;
  await assert.rejects(()=>cloud.login({identifier:'zed',password:'nope nope nope'}),e=>e.status===429);
  assert.equal(worker.calls.length,before,'잠긴 뒤에는 서버에 요청도 보내지 않는다');
});

test('프로필 저장·사진 올리기/받기/지우기, 사진은 그림 파일만',async()=>{
  const {cloud,worker}=await makeCloud();
  await cloud.register(REG);
  let p=await cloud.profile();
  assert.equal(p.user.username,'kim.lapis');assert.equal(p.revision,0);
  const saved=await cloud.saveProfile({name:'새 닉네임',phone:'010-9999-8888',revision:p.revision});
  assert.equal(saved.revision,1);
  assert.equal((await cloud.state()).user.name,'새 닉네임','로그인 정보의 표시 이름도 바뀐다');
  await assert.rejects(()=>cloud.saveProfile({name:'x',phone:'',revision:0}),e=>e.status===409);
  await assert.rejects(()=>cloud.saveProfile({name:'',phone:''}),e=>e.status===400);
  await assert.rejects(()=>cloud.saveProfile({name:'x',phone:'abc'}),e=>e.status===400);
  assert.equal(await cloud.getAvatar(),null);
  await cloud.putAvatar(PNG);
  assert.equal(worker.avatar.equals(PNG),true);
  assert.equal((await cloud.getAvatar()).type,'image/png');
  await assert.rejects(()=>cloud.putAvatar(Buffer.from('<svg onload=alert(1)>'.padEnd(40,' '))),e=>e.status===415);
  await assert.rejects(()=>cloud.putAvatar(Buffer.concat([PNG,Buffer.alloc(5*1024*1024)])),e=>e.status===413);
  await cloud.deleteAvatar();assert.equal(await cloud.getAvatar(),null);
  assert.equal(sniffImage(Buffer.from('GIF89a'.padEnd(20,'x'))),null);
});

test('동기화: 올리고 받는다',async()=>{
  const {cloud}=await makeCloud();
  await cloud.register(REG);
  assert.equal((await cloud.syncGet()).snapshot,null);
  const put=await cloud.syncPut({version:1,prefs:{accent:'blue'}},0);
  assert.equal(put.revision,1);
  const got=await cloud.syncGet();
  assert.equal(got.snapshot.prefs.accent,'blue');assert.equal(got.revision,1);
});

test('계정마다 할 일·일정이 따로 보관되고, 옛 자료는 처음 로그인한 계정이 한 번만 이어받는다',async()=>{
  const dir=await tmp();
  const pc=createVault(join(dir,'v.bin'),plain);
  // 이 기능 이전의 자료
  await writeFile(join(dir,'tasks.json'),JSON.stringify({version:1,tasks:[{id:'a0000000-0000-4000-8000-000000000000',title:'옛 할 일',due:null,owner:'me',notes:'',priority:false,done:false,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',doneAt:null}]}));
  await pc.update({gcal:{mode:'own'}});
  let current={signedIn:true,user:{id:UID1}};
  const accounts=createAccounts({dataDir:dir,cloud:{state:async()=>current},pcVault:pc,createVault:file=>createVault(file,plain),createTaskStore,createCalendarStore});
  assert.equal((await accounts.tasks.list()).length,1,'첫 계정이 옛 자료를 이어받는다');
  assert.equal((await accounts.vault.read()).gcal.mode,'own');
  assert.equal((await pc.read()).gcal,undefined,'PC 공용 보관소에서는 Google 설정이 옮겨졌다');
  await accounts.tasks.create({title:'계정1 할 일'});
  current={signedIn:true,user:{id:UID2}};
  assert.equal((await accounts.tasks.list()).length,0,'다른 계정에는 보이지 않는다');
  await accounts.tasks.create({title:'계정2 할 일'});
  current={signedIn:true,user:{id:UID1}};
  assert.deepEqual((await accounts.tasks.list()).map(t=>t.title).sort(),['계정1 할 일','옛 할 일']);
  current={signedIn:false};
  await assert.rejects(()=>accounts.tasks.list(),e=>e.status===401);
  current={signedIn:true,user:{id:'../escape'}};
  await assert.rejects(()=>accounts.tasks.list(),e=>e.status===400,'경로를 벗어나는 계정 ID 는 거절');
  assert.deepEqual((await readdir(join(dir,'accounts'))).sort(),[UID1,UID2]);
});

test('할 일·일정 가져오기는 잘못된 항목을 건너뛰고 구글 일정은 건드리지 않는다',async()=>{
  const dir=await tmp();
  const tasks=createTaskStore(join(dir,'t.json')),cal=createCalendarStore(join(dir,'c.json'));
  const r=await tasks.replaceAll([{title:'정상'},{title:''},{title:'마감',due:'bad'}]);
  assert.equal(r.count,1);
  const e=await cal.importLocal([{title:'회의',start:'2026-10-05T01:00:00Z',end:'2026-10-05T02:00:00Z'},{title:'',start:'x',end:'y'}]);
  assert.equal(e.count,1);
  assert.equal((await cal.exportLocal()).length,1);
});

// ── 서버: 게이트 ──
async function gated(t,{loggedIn=false}={}){
  const dir=await tmp(),worker=fakeWorker(),vault=createVault(join(dir,'v.bin'),plain);
  if(loggedIn)await vault.update({cloud:{accessToken:'access-'+UID1,refreshToken:'refresh-'+UID1,user:{id:UID1,email:'kim@example.com',name:'라피',username:'kim.lapis'}}});
  const cloud=createCloud({baseUrl:'https://cloud.test/api/v1',vault,fetchImpl:worker.handler});
  const server=createDashboardServer({dataDir:dir,vault,vaultCrypto:plain,cloud,telegramSnapshot:async()=>({bots:[],messages:[]}),officeUrl:'http://127.0.0.1:9',rentalUrl:'http://127.0.0.1:9'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return {base:'http://127.0.0.1:'+server.address().port,dir,worker};
}
const H={'content-type':'application/json','x-lapis-request':'1'};

test('로그인 전에는 화면 파일과 로그인 기능만 열려 있다',async t=>{
  const {base}=await gated(t);
  assert.equal((await fetch(base+'/')).status,200);
  assert.equal((await fetch(base+'/api/cloud/state')).status,200);
  for(const path of ['/api/tasks','/api/overview','/api/calendar/events?from=2026-10-01&to=2026-10-02','/api/storage/local','/api/cloud/profile','/api/cloud/avatar','/api/cloud/sync','/api/account/export','/office/api/overview','/api/drives','/api/hermes/health'])
    assert.equal((await fetch(base+path)).status,401,path);
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers:H,body:'{"title":"x"}'})).status,401);
});

test('가입하면 곧바로 쓸 수 있고, 로그아웃하면 다시 닫힌다',async t=>{
  const {base,dir}=await gated(t);
  const docs=await (await fetch(base+'/api/cloud/consents')).json();
  assert.equal(docs.documents[0].consentType,'terms');
  const reg=await fetch(base+'/api/cloud/register',{method:'POST',headers:H,body:JSON.stringify(REG)});
  assert.equal(reg.status,201);
  const regText=await reg.text();assert.equal(regText.includes('access-'),false);
  assert.equal((await fetch(base+'/api/tasks')).status,200);
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers:H,body:'{"title":"내 일"}'})).status,201);
  await access(join(dir,'accounts',UID1,'tasks.json'));
  assert.equal((await fetch(base+'/api/cloud/logout',{method:'POST',headers:H,body:'{}'})).status,200);
  assert.equal((await fetch(base+'/api/tasks')).status,401);
});

test('프로필·사진·동기화 경로와 사진 검사',async t=>{
  const {base}=await gated(t,{loggedIn:true});
  // 사용자가 직접 만든 계정이 서버에 있어야 /auth/me 가 통한다
  await fetch(base+'/api/cloud/logout',{method:'POST',headers:H,body:'{}'});
  await fetch(base+'/api/cloud/register',{method:'POST',headers:H,body:JSON.stringify(REG)});
  const prof=await (await fetch(base+'/api/cloud/profile')).json();
  assert.equal(prof.user.email,'kim@example.com');
  const save=await fetch(base+'/api/cloud/profile',{method:'PUT',headers:H,body:JSON.stringify({name:'바꾼 이름',phone:'010-1111-2222',revision:prof.revision})});
  assert.equal(save.status,200);
  assert.equal((await fetch(base+'/api/cloud/avatar')).status,404);
  const up=await fetch(base+'/api/cloud/avatar',{method:'PUT',headers:{'content-type':'application/octet-stream','x-lapis-request':'1'},body:PNG});
  assert.equal(up.status,200);
  const got=await fetch(base+'/api/cloud/avatar');
  assert.equal(got.status,200);assert.equal(got.headers.get('content-type'),'image/png');
  assert.equal(got.headers.get('x-content-type-options'),'nosniff');
  assert.match(got.headers.get('content-security-policy'),/sandbox/);
  const bad=await fetch(base+'/api/cloud/avatar',{method:'PUT',headers:{'content-type':'image/png','x-lapis-request':'1'},body:Buffer.from('<script>alert(1)</script>'.padEnd(40))});
  assert.equal(bad.status,415);
  assert.equal((await fetch(base+'/api/cloud/avatar',{method:'PUT',body:PNG})).status,403,'화면이 보낸 요청 표시가 없으면 거절');
  assert.equal((await fetch(base+'/api/cloud/sync',{method:'PUT',headers:H,body:JSON.stringify({snapshot:{version:1,x:1},expectedRevision:0})})).status,200);
  assert.equal((await (await fetch(base+'/api/cloud/sync')).json()).snapshot.x,1);
});

test('내보내기·가져오기로 다른 PC 에 할 일을 옮긴다',async t=>{
  const a=await gated(t,{loggedIn:true});
  await fetch(a.base+'/api/tasks',{method:'POST',headers:H,body:'{"title":"옮길 일"}'});
  const exported=await (await fetch(a.base+'/api/account/export')).json();
  assert.equal(exported.tasks.length,1);
  const b=await gated(t,{loggedIn:true});
  const imp=await fetch(b.base+'/api/account/import',{method:'POST',headers:H,body:JSON.stringify(exported)});
  assert.equal((await imp.json()).tasks,1);
  assert.equal((await (await fetch(b.base+'/api/tasks')).json()).tasks[0].title,'옮길 일');
});

test('첫 화면은 로그인 입구이고 초기 설정 마법사는 없다',async t=>{
  const {base}=await gated(t);
  const page=await (await fetch(base+'/')).text();
  assert.match(page,/<body class="gated">/);
  assert.match(page,/id="gate"/);
  assert.equal(page.includes('view-setup'),false);
  const lapis=await (await fetch(base+'/lapis.js')).text();
  assert.equal(lapis.includes('시작 마법사'),false);
  assert.equal(lapis.includes("needsSetup"),false);
  assert.equal((await fetch(base+'/setup.js')).status,404);
  assert.equal((await fetch(base+'/sync.js')).status,200);
});
