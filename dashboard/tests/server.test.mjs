import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboardServer } from '../src/server.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => {server.closeAllConnections(); server.close(r);}));
  return 'http://127.0.0.1:' + server.address().port;
}
async function app(t, options={}) {
  const server = createDashboardServer({requireLogin:false,telegramSnapshot:async()=>({bots:[],messages:[]}), ...options});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return 'http://127.0.0.1:'+server.address().port;
}
const headers={'content-type':'application/json','x-lapis-request':'1'};
test('Office 0.3.5 drive grants use guarded routes without changing unrelated services',async t=>{
  const calls=[];
  const officeUrl=await fixture(t,(req,res)=>{calls.push({method:req.method,path:req.url});res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');});
  const base=await app(t,{officeUrl});
  for(const method of ['POST','DELETE']){
    const denied=await fetch(base+'/office/api/offices/ai-office/drives',{method,headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(denied.status,403);
    const allowed=await fetch(base+'/office/api/offices/ai-office/drives',{method,headers,body:'{}'});
    assert.equal(allowed.status,200);
  }
  assert.deepEqual(calls,[{method:'POST',path:'/api/offices/ai-office/drives'},{method:'DELETE',path:'/api/offices/ai-office/drives'}]);
});

test('untrusted mutation never reaches Office',async t=>{
  let calls=0;
  const officeUrl=await fixture(t,(req,res)=>{calls++;res.end('{}');});
  const base=await app(t,{officeUrl});
  const r=await fetch(base+'/office/api/config',{method:'PATCH',headers:{...headers,origin:'https://outside.example'},body:'{}'});
  assert.equal(r.status,403); assert.equal(calls,0);
});
test('Office mutation routes to real connector and preserves rejection',async t=>{
  let seen;
  const officeUrl=await fixture(t,async(req,res)=>{
    let body=''; for await(const c of req)body+=c;
    seen={method:req.method,url:req.url,body,headers:req.headers};
    res.writeHead(409,{'content-type':'application/json'}); res.end('{"error":"사용 중"}');
  });
  const base=await app(t,{officeUrl});
  const r=await fetch(base+'/office/api/config',{method:'PATCH',headers,body:'{"theme":"light"}'});
  assert.equal(r.status,409); assert.equal((await r.json()).error,'사용 중');
  assert.equal(seen.method,'PATCH'); assert.equal(seen.url,'/api/config');
  assert.equal(seen.headers['x-ai-office'],'1');
  assert.equal(seen.headers.cookie,undefined); assert.equal(seen.body,'{"theme":"light"}');
});
test('unknown Office routes cannot use proxy',async t=>{
  let calls=0;
  const officeUrl=await fixture(t,(req,res)=>{calls++;res.end('{}');});
  const base=await app(t,{officeUrl});
  assert.equal((await fetch(base+'/office/api/not-a-feature')).status,404);
  assert.equal(calls,0);
});
test('Warehouse sessions are isolated and upstream cookie is never exposed',async t=>{
  const seen=[];
  const rentalUrl=await fixture(t,async(req,res)=>{
    seen.push(req.headers.cookie||'');
    if(req.url==='/admin/api/login'){
      res.writeHead(200,{'content-type':'application/json','set-cookie':'adm=upstream-secret; HttpOnly; Secure; Path=/'});
      res.end('{"ok":true}'); return;
    }
    res.writeHead(req.headers.cookie==='adm=upstream-secret'?200:401,{'content-type':'application/json'});
    res.end('{"ok":true}');
  });
  const base=await app(t,{rentalUrl});
  const login=await fetch(base+'/rental/admin/api/login',{method:'POST',headers,body:'{"password":"fixture"}'});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/); assert.doesNotMatch(cookie,/upstream-secret/);
  assert.equal((await fetch(base+'/rental/admin/api/summary',{headers:{cookie:cookie.split(';')[0]}})).status,200);
  assert.equal((await fetch(base+'/rental/admin/api/summary')).status,401);
  assert.equal(seen.at(-1),'');
});
test('cross-site reads and DNS rebinding rejected',async t=>{
  const base=await app(t);
  assert.equal((await fetch(base+'/api/telegram',{headers:{origin:'https://outside.example'}})).status,403);
  const status=await new Promise((resolve,reject)=>{
    const req=http.get(base+'/api/telegram',{headers:{host:'outside.example'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);
  });
  assert.equal(status,421);
});
test('redirects from upstream are not followed',async t=>{
  let downstream=0;
  const redirect=await fixture(t,(q,s)=>{downstream++;s.end('secret');});
  const rentalUrl=await fixture(t,(q,s)=>{s.writeHead(302,{location:redirect});s.end();});
  const base=await app(t,{rentalUrl});
  assert.equal((await fetch(base+'/rental/admin/api/summary')).status,502);
  assert.equal(downstream,0);
});
test('Telegram connector wired to endpoint without starting polling',async t=>{
  let calls=0;
  const base=await app(t,{telegramSnapshot:async()=>{calls++;return {bots:[{id:'lapis'}],messages:[{id:'123'}]};}});
  const data=await (await fetch(base+'/api/telegram')).json();
  assert.equal(data.messages[0].id,'123');assert.equal(calls,1);
});
test('Warehouse logout revokes local session even when upstream is unavailable',async t=>{
  let cookieSeen='';
  const rentalUrl=await fixture(t,(req,res)=>{
    if(req.url==='/admin/api/login'){res.writeHead(200,{'set-cookie':'adm=fixture-session; HttpOnly'});return res.end('{"ok":true}');}
    if(req.url==='/admin/api/logout'){res.destroy();return;}
    cookieSeen=req.headers.cookie||'';res.writeHead(cookieSeen?200:401);res.end('{}');
  });
  const base=await app(t,{rentalUrl});
  const login=await fetch(base+'/rental/admin/api/login',{method:'POST',headers,body:'{}'});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const logout=await fetch(base+'/rental/admin/api/logout',{method:'POST',headers:{...headers,cookie},body:'{}'});
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await fetch(base+'/rental/admin/api/summary',{headers:{cookie}})).status,401);
  assert.equal(cookieSeen,'');
});
test('Office screens are embedded in the unified page and keep the guarded proxy wiring',async t=>{
  const base=await app(t);
  const js=await (await fetch(base+'/office.js')).text();
  assert.ok(js.includes("|| 'ai-office'"),'Default workspace must be Office');
  assert.ok(js.includes("fetch('/office' + path"),'Office screens must use integration proxy');
  assert.ok(js.includes("'x-lapis-request': '1'"),'Mutations require local request guard');
  assert.ok(js.includes("drive: vDrive"),'Drive access has its own screen');
  const page=await (await fetch(base+'/')).text();
  const gate=await (await fetch(base+'/gate.js')).text();
  assert.ok(page.includes('/gate.js')&&page.includes('id="office-content"'),'the page starts at the membership gate');
  assert.ok(gate.includes("import('/office.js')")&&gate.includes("import('/lapis.js')"),'the gate loads the app after login');
  assert.ok(!/<iframe[^>]*office/i.test(page),'Office is no longer shown in a separate frame');
  for(const theme of ['theme.css','office.css','lapis.css'])assert.equal((await fetch(base+'/'+theme)).status,200);
  const css=await (await fetch(base+'/theme.css')).text();
  assert.ok(css.includes('[data-theme="dark"]')&&css.includes('--bg: #000000'),'Black and gray theme must be defined');
  const html=await (await fetch(base+'/modules/rental/admin.html')).text();
  assert.ok(html.includes("fetch('/rental/admin/api' + path"));
  assert.ok(html.includes("'x-lapis-request': '1'"));
  assert.ok(!html.includes("fetch('/admin/api'"));
});
test('drive usage is read-only, comes from the injected reader, and mutation is not allowed',async t=>{
  const base=await app(t,{drives:async()=>[{letter:'D',total:1000,free:400}]});
  const body=await (await fetch(base+'/api/drives')).json();
  assert.deepEqual(body,{drives:[{letter:'D',total:1000,free:400}]});
  assert.equal((await fetch(base+'/api/drives',{method:'POST',headers})).status,405);
  assert.equal((await fetch(base+'/api/capabilities')).status,404,'capability matrix screen was removed');
});
test('an uncertain mutation is attempted once and returns a service error',async t=>{
  let attempts=0;
  const officeUrl=await fixture(t,(req,res)=>{attempts++;res.destroy();});
  const base=await app(t,{officeUrl});
  const response=await fetch(base+'/office/api/config',{method:'PATCH',headers,body:'{}'});
  assert.equal(response.status,503);assert.equal(attempts,1);
  assert.match((await response.json()).error,/응답하지 않습니다/);
});
test('malformed or empty Hermes requests never reach the gateway',async t=>{
  let calls=0;
  const hermesUrl=await fixture(t,(q,s)=>{calls++;s.end('{}');});
  const base=await app(t,{hermesUrl});
  for(const body of ['{','{}','{"message":""}']){
    const response=await fetch(base+'/api/hermes/chat',{method:'POST',headers,body});
    assert.equal(response.status,400);
  }
  assert.equal(calls,0);
});

test('unified page wires every new screen and its scripts and styles exist',async t=>{
  const base=await app(t);
  const page=await (await fetch(base+'/')).text();
  for(const id of ['view-calendar','view-storage','view-learning','view-account','view-appearance','chat-lapis','chat-hermes','ui-dlg','palette','home-events'])assert.ok(page.includes('id="'+id+'"'),id);
  const lapis=await (await fetch(base+'/lapis.js')).text();
  for(const mod of ['account','storage','learning','chat','calendar','prefs']){
    assert.ok(lapis.includes("'./"+mod+".js'"),mod+' is loaded');
    assert.equal((await fetch(base+'/'+mod+'.js')).status,200);
  }
  for(const css of ['pages.css','prefs.css','account.css'])assert.equal((await fetch(base+'/'+css)).status,200);
  for(const key of ["['calendar','캘린더']","['learning','라피스 학습']","['storage','저장소']","['account','내 계정 · 프로필']","['appearance','화면 설정']"])assert.ok(lapis.includes(key),key);
});
