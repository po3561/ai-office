import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {scanFolder,listFiles,resolveEntry,openDownload} from '../src/file-server/files.mjs';
import {createFileServerManager} from '../src/file-server/manager.mjs';
import {createFileHost,hostSocketAddress,fileRange} from '../src/file-server/host.mjs';
import {readLocalAudit} from '../src/file-server/routes.mjs';
import {createVault,plain} from '../src/vault.mjs';
import {createDashboardServer} from '../src/server.mjs';

// 공유 경계 검사는 숨김(.claude)·AppData 아래 폴더를 거부하므로, 시험 폴더는 홈 바로 아래에 만들고 끝나면 지운다.
const BASE=join(homedir(),'lapis-file-server-tests');
await mkdir(BASE,{recursive:true});
after(()=>rm(BASE,{recursive:true,force:true}));
const USER={id:'11111111-1111-4111-8111-111111111111',name:'주인'};
const SERVER_ID='22222222-2222-4222-8222-222222222222';
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(){
  const dir=await mkdtemp(join(BASE,'case-'));const share=join(dir,'공개');await mkdir(share);
  await writeFile(join(share,'안내.txt'),'hello');await writeFile(join(share,'연락처.csv'),'private');await writeFile(join(share,'run.exe'),'x');
  return {dir,share};
}
function fakeApi(){
  const calls=[];
  const api=async(method,path,body)=>{calls.push({method,path,body});
    if(method==='POST'&&path==='/file-servers')return {server:{id:SERVER_ID,name:body.name,shares:body.shares},hostToken:'a'.repeat(64)};
    return {server:{id:SERVER_ID,status:body?.status}};};
  return {calls,api};
}
function managerFor(dir,extra={}){
  const picks=[];
  const m=createFileServerManager({dataDir:join(dir,'data'),vault:createVault(join(dir,'host-vault'),plain),pickFolder:async()=>picks.shift()??null,...extra});
  return {m,picks};
}
async function scanned(m,picks,path){picks.push(path);const {pickId}=await m.pick(USER);return m.scan(USER,pickId);}

test('scan excludes sensitive names and executables, lists only safe files and denies escapes',async()=>{
  const {share}=await fixture();
  const scan=await scanFolder(share);assert.equal(scan.complete,true);assert.equal(scan.blockedCount,2);
  const s={...scan.root,id:'sample',name:'자료'};
  assert.deepEqual((await listFiles(s,'')).entries.map(e=>e.name),['안내.txt']);
  for(const path of ['../outside','연락처.csv','run.exe','a:secret','%2e%2e/x','CON.txt'])await assert.rejects(()=>resolveEntry(s,path));
  const opened=await openDownload(s,'안내.txt');let text='';for await(const chunk of opened.stream)text+=chunk;assert.equal(text,'hello');
  await assert.rejects(()=>scanFolder(process.platform==='win32'?'C:/':'/'));
});
test('junctions inside a share are blocked and a replaced root is refused',async()=>{
  const {dir}=await fixture();const root=join(dir,'공유'),outside=join(dir,'외부');await mkdir(root);await mkdir(outside);await writeFile(join(outside,'비공개.txt'),'private');
  await symlink(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir');
  const scan=await scanFolder(root);assert.equal(scan.blockedCount,1);const s={...scan.root,id:'s',name:'자료'};
  await assert.rejects(()=>resolveEntry(s,'escape/비공개.txt'));
  await assert.rejects(()=>listFiles({...s,ino:'wrong'},''));
});

test('folders can only be shared through the on-screen picker, and the host key stays out of settings',async()=>{
  const {dir,share}=await fixture();const {m,picks}=managerFor(dir);const {api,calls}=fakeApi();
  await assert.rejects(()=>m.scan(USER,'made-up-pick'),e=>e.status===409);
  assert.deepEqual(await m.pick(USER),{path:null});   // 취소
  const scan=await scanned(m,picks,share);
  await assert.rejects(()=>m.scan(USER,scan.scanId),e=>e.status===409);   // 검사 ID 를 고른 폴더 ID 로 재사용할 수 없다
  const state=await m.configure(USER,{name:'자료',scanIds:[scan.scanId]},api);
  assert.equal(state.configured,true);assert.equal(state.autoStart,false);
  assert.equal(calls[0].body.shares[0].path,undefined);   // 클라우드에는 PC 경로를 보내지 않는다
  assert.doesNotMatch(await readFile(join(dir,'data','file-server.json'),'utf8'),/aaaaaaaa/);
  await assert.rejects(()=>m.state({id:'someone-else'}),e=>e.status===403);
});

test('re-selecting the same folder keeps its share id so invited members keep access',async()=>{
  const {dir,share}=await fixture();const other=join(dir,'두번째');await mkdir(other);await writeFile(join(other,'b.txt'),'b');
  const {m,picks}=managerFor(dir);const {api,calls}=fakeApi();
  const first=await m.configure(USER,{name:'자료',scanIds:[(await scanned(m,picks,share)).scanId]},api);
  const second=await m.configure(USER,{name:'자료 2',scanIds:[(await scanned(m,picks,other)).scanId,(await scanned(m,picks,share)).scanId]},api);
  const kept=second.shares.find(s=>s.path===first.shares[0].path);
  assert.equal(kept.id,first.shares[0].id);
  assert.notEqual(second.shares.find(s=>s.path!==first.shares[0].path).id,first.shares[0].id);
  const patch=calls.at(-1);assert.equal(patch.method,'PATCH');assert.equal(patch.body.status,'paused');assert.ok(patch.body.shares.some(s=>s.id===kept.id));
});

test('unexpected disconnects reconnect automatically; a rejected key or paused server stops retrying',async()=>{
  const {dir,share}=await fixture();let starts=0,mode='ok',report;
  const {m,picks}=managerFor(dir,{reconnectDelays:[0.02],
    onStart:async(config,changed)=>{starts++;report=changed;if(mode==='reject'){const e=new Error('denied');e.status=401;throw e;}if(mode==='offline'){const e=new Error('offline');e.status=503;throw e;}changed({state:'connected',error:null});},
    onStop:async()=>{}});
  const {api}=fakeApi();
  await m.configure(USER,{name:'자료',scanIds:[(await scanned(m,picks,share)).scanId]},api);
  assert.equal((await m.start(USER,api)).relay.state,'connected');assert.equal(starts,1);
  mode='offline';report({state:'disconnected',error:'끊김',retry:true});
  assert.equal((await m.state(USER)).relay.state,'reconnecting');
  await wait(80);assert.ok(starts>=3,'keeps retrying while offline');assert.equal((await m.state(USER)).desiredRunning,true);
  mode='ok';await wait(60);
  let state=await m.state(USER);assert.equal(state.relay.state,'connected');assert.equal(state.ops.reconnectAttempt,0);
  mode='reject';report({state:'disconnected',error:'끊김',retry:true});await wait(60);
  state=await m.state(USER);assert.equal(state.desiredRunning,false);assert.equal(state.relay.state,'error');
  const before=starts;await wait(60);assert.equal(starts,before,'no retry after the cloud rejected the key');
  // 클라우드에서 중지된 경우(heartbeat status paused)도 멈춘다.
  mode='ok';await m.start(USER,api);report({state:'error',error:'중지됨',retry:false});
  assert.equal((await m.state(USER)).desiredRunning,false);
  await m.close();
});

test('auto start resumes only the owner’s server when the option is on',async()=>{
  const {dir,share}=await fixture();let starts=0;
  const {m,picks}=managerFor(dir,{onStart:async(c,changed)=>{starts++;changed({state:'connected',error:null});}});const {api}=fakeApi();
  await m.configure(USER,{name:'자료',scanIds:[(await scanned(m,picks,share)).scanId]},api);
  assert.deepEqual(await m.resume(USER,api),{resumed:false});
  await assert.rejects(()=>m.settings(USER,{autoStart:'yes'}),e=>e.status===400);
  assert.equal((await m.settings(USER,{autoStart:true})).autoStart,true);
  assert.deepEqual(await m.resume({id:'33333333-3333-4333-8333-333333333333'},api),{resumed:false});
  assert.deepEqual(await m.resume(USER,api),{resumed:true});assert.equal(starts,1);
  assert.deepEqual(await m.resume(USER,api),{resumed:false});   // 이미 켜져 있다
  await m.close();
});

test('host address keeps the key out of the URL; ranges are bounded',()=>{
  const r=hostSocketAddress('https://lapis.test/api/v1',SERVER_ID,'a'.repeat(64));
  assert.equal(r.url,`wss://lapis.test/api/v1/file-servers/${SERVER_ID}/host/connect`);assert.doesNotMatch(r.url,/aaaa/);
  assert.throws(()=>hostSocketAddress('http://evil.test/api/v1',SERVER_ID,'a'.repeat(64)));
  assert.deepEqual(fileRange('bytes=2-',8),{start:2,end:7,status:206});
  for(const range of ['bytes=8-','bytes=-5','bytes=1-2,5-6'])assert.throws(()=>fileRange(range,8));
});

class FakeSocket extends EventTarget{
  static last;readyState=1;sent=[];
  constructor(){super();FakeSocket.last=this;setTimeout(()=>this.dispatchEvent(new MessageEvent('message',{data:'{"type":"ready"}'})),0);}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){this.readyState=3;}
  receive(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
  drop(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
test('host streams a file through the relay protocol, records it, and reports drops for reconnect',async()=>{
  const {dir,share}=await fixture();const data=Buffer.alloc(200*1024,7);await writeFile(join(share,'큰파일.bin'),data);
  const scan=await scanFolder(share);const audits=[];const states=[];
  const host=createFileHost({baseUrl:'https://lapis.test/api/v1',dataDir:join(dir,'audit'),WebSocketImpl:FakeSocket,fetchImpl:async(url,init)=>{
    if(url.endsWith('/audit'))audits.push(JSON.parse(init.body));return Response.json({ok:true,status:'active'});}});
  await host.start({serverId:SERVER_ID,hostToken:'a'.repeat(64),shares:[{...scan.root,id:'docs'}]},s=>states.push(s));
  const ws=FakeSocket.last,id='44444444-4444-4444-8444-444444444444';
  ws.receive({type:'request',id,userId:USER.id,operation:'download',shareId:'docs',path:'큰파일.bin'});
  for(let i=0;i<100&&!ws.sent.some(m=>m.type==='head');i++)await wait(100);   // 고정 대기는 부하가 큰 CI 에서 모자란다
  const head=ws.sent.find(m=>m.type==='head');assert.equal(head.length,data.length);
  for(let i=0;i<8&&!ws.sent.some(m=>m.type==='end');i++){ws.receive({type:'pull',id,count:4});await wait(150);}
  const got=Buffer.concat(ws.sent.filter(m=>m.type==='chunk').map(m=>Buffer.from(m.data,'base64')));
  assert.equal(createHash('sha256').update(got).digest('hex'),createHash('sha256').update(data).digest('hex'));
  assert.ok(ws.sent.some(m=>m.type==='end'));
  assert.deepEqual(audits.map(a=>a.action),['download_started','download_completed']);
  const stats=host.stats();assert.equal(stats.completed,1);assert.equal(stats.bytesSent,data.length);assert.equal(stats.activeTransfers,0);
  const local=await readLocalAudit(join(dir,'audit'));assert.equal(local[0].action,'download_completed');
  ws.receive({type:'heartbeat',status:'active'});assert.ok(host.stats().lastHeartbeatAt);
  ws.drop();await wait(20);
  assert.deepEqual(states.at(-1),{state:'disconnected',error:'연결이 끊겼습니다. 자동으로 다시 연결합니다.',retry:true});
  await host.stop();
});
test('a paused-in-cloud heartbeat stops the host without retry',async()=>{
  const states=[];
  const host=createFileHost({baseUrl:'https://lapis.test/api/v1',dataDir:'unused',WebSocketImpl:FakeSocket,fetchImpl:async()=>Response.json({ok:true,status:'active'})});
  await host.start({serverId:SERVER_ID,hostToken:'a'.repeat(64),shares:[]},s=>states.push(s));
  FakeSocket.last.receive({type:'heartbeat',status:'paused'});await wait(10);
  assert.equal(states.at(-1).retry,false);assert.equal(FakeSocket.last.readyState,3);
});

// ── 대시보드 경로 ──
function fakeCloud({signedIn=true}={}){
  const calls=[];
  return {calls,
    async state(){return signedIn?{signedIn:true,user:{id:USER.id,email:'a@b.c',name:'주인'}}:{signedIn:false};},
    async fileServers(method,path,body){calls.push({method,path,body});
      if(path==='/file-servers')return {servers:[{id:SERVER_ID,name:'팀 자료',role:'viewer',shares:[{id:'docs',name:'자료'}],host:{online:true}}]};
      if(path.endsWith('/invitations'))return {code:'123456789012',expiresAt:new Date(Date.now()+600000).toISOString()};
      if(path==='/file-server-invitations/redeem')return {server:{id:SERVER_ID,name:'팀 자료'}};
      return {ok:true};},
    async fileServerStream(path,{range}){calls.push({method:'STREAM',path,range});
      return new Response('file-bytes',{status:range?206:200,headers:{'content-type':'application/octet-stream','content-length':'10','content-disposition':"attachment; filename*=UTF-8''a.txt",'content-range':range?'bytes 0-9/10':''}});},
  };
}
async function listen(options){
  const server=createDashboardServer({requireLogin:false,officeUrl:'http://127.0.0.1:9',rentalUrl:'',calendarStore:{},taskStore:{},...options});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(path,{method='GET',body,headers={}}={})=>fetch(base+path,{method,headers:{...(method==='GET'?{}:{'content-type':'application/json','x-lapis-request':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {server,call,close:()=>new Promise(r=>server.close(r))};
}
test('dashboard routes proxy invitations and redeem, validate codes, and stream downloads with headers',async()=>{
  const cloud=fakeCloud();const {dir}=await fixture();
  const {call,close}=await listen({cloud,dataDir:join(dir,'dash'),vaultCrypto:plain});
  try{
    assert.equal((await call('/api/file-server/servers')).status,200);
    let r=await call('/api/file-server/redeem',{method:'POST',body:{code:'1234'}});assert.equal(r.status,400);
    r=await call('/api/file-server/redeem',{method:'POST',body:{code:'1234-5678-9012'}});assert.equal(r.status,200);
    assert.deepEqual(cloud.calls.at(-1).body,{code:'123456789012'});
    r=await call(`/api/file-server/servers/${SERVER_ID}/invitations`,{method:'POST',body:{shareIds:['docs','bad id!']}});assert.equal(r.status,201);
    assert.deepEqual(cloud.calls.at(-1).body,{shareIds:['docs']});
    r=await call(`/api/file-server/servers/${SERVER_ID}/members/${USER.id}`,{method:'PATCH',body:{status:'owner'}});assert.equal(r.status,400);
    r=await call(`/api/file-server/servers/${SERVER_ID}/download?shareId=docs&path=a.txt`,{headers:{range:'bytes=0-'}});
    assert.equal(r.status,206);assert.equal(await r.text(),'file-bytes');assert.match(r.headers.get('content-disposition'),/attachment/);assert.equal(r.headers.get('content-range'),'bytes 0-9/10');
    assert.equal(cloud.calls.at(-1).path,`/file-servers/${SERVER_ID}/download?shareId=docs&path=a.txt`);
    // 화면에서 보낸 표시가 없는 변경 요청과 경로 탈출 모양은 막는다.
    r=await fetch((await call('/api/file-server/servers')).url.replace('/servers','/start'),{method:'POST'});assert.equal(r.status,403);
    assert.equal((await call(`/api/file-server/servers/${SERVER_ID}/download?shareId=../x&path=a`)).status,400);
    assert.equal((await call('/api/file-server/servers/not-an-id')).status,404);
  }finally{await close();}
});
test('file server routes require a signed-in LAPIS account',async()=>{
  const {dir}=await fixture();const {call,close}=await listen({cloud:fakeCloud({signedIn:false}),dataDir:join(dir,'dash'),vaultCrypto:plain});
  try{const r=await call('/api/file-server/state');assert.equal(r.status,401);}finally{await close();}
});
test('cloud client allows only file-server paths and retries a stream once after refreshing the login',async()=>{
  const {createCloud}=await import('../src/lapis-cloud.mjs');const {dir}=await fixture();
  const vault=createVault(join(dir,'pc-vault'),plain);
  await vault.update({cloud:{accessToken:'old-token',refreshToken:'r1',user:{id:USER.id,email:'a@b.c',name:'주인'}}});
  const seen=[];
  const cloud=createCloud({vault,baseUrl:'https://lapis.test/api/v1',fetchImpl:async(url,init)=>{
    seen.push([url,init.headers?.Authorization||init.headers?.authorization,init.headers?.Range]);
    if(url.endsWith('/auth/refresh'))return Response.json({access_token:'new-token',refresh_token:'r2'});
    if(init.headers.Authorization==='Bearer old-token')return Response.json({error:'expired'},{status:401});
    if(url.includes('/download'))return new Response('bytes',{status:206});
    return Response.json({servers:[]});
  }});
  await assert.rejects(()=>cloud.fileServers('GET','/auth/me'),e=>e.status===400);
  await assert.rejects(()=>cloud.fileServers('GET','/file-servers/../admin'),e=>e.status===400);
  await assert.rejects(()=>cloud.fileServerStream('/file-servers/x/download?a=1'),e=>e.status===400);
  const response=await cloud.fileServerStream(`/file-servers/${SERVER_ID}/download?shareId=docs&path=a`,{range:'bytes=1-'});
  assert.equal(response.status,206);assert.equal(await response.text(),'bytes');
  assert.deepEqual(seen.map(s=>s[1]).filter(Boolean),['Bearer old-token','Bearer new-token']);
  assert.equal(seen.at(-1)[2],'bytes=1-');
  assert.deepEqual(await cloud.fileServers('GET','/file-servers'),{servers:[]});
});
test('every dashboard screen script parses as an ES module',async()=>{
  const {readdir,copyFile}=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');
  const dir=new URL('../web/',import.meta.url),tmp=await mkdtemp(join(BASE,'parse-'));
  for(const name of (await readdir(dir)).filter(n=>n.endsWith('.js'))){
    // .js 를 .mjs 로 복사해 모듈 문법으로만 확인한다(실행하지 않는다).
    const copy=join(tmp,name.replace(/\.js$/,'.mjs'));await copyFile(new URL(name,dir),copy);
    assert.doesNotThrow(()=>execFileSync(process.execPath,['--check',copy],{stdio:'pipe'}),name);
  }
});
