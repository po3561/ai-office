// 봇 커넥터: 실제 MCP 서버(src/connectors/lapis-mcp.mjs)를 띄워 대시보드 관문 → 가짜 라피스 클라우드까지 이어서 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createDashboardServer} from '../src/server.mjs';
import {createTaskStore} from '../src/tasks.mjs';
import {createCalendarStore} from '../src/calendar.mjs';

const MCP=resolve(dirname(fileURLToPath(import.meta.url)),'../../src/connectors/lapis-mcp.mjs');
const TOKEN='t'.repeat(43);
const sha=s=>createHash('sha256').update(s).digest('hex');

function fakeCloud(){
  const calls=[];
  let n=0;
  return {calls,async state(){return {signedIn:true,user:{id:'u1',email:'a@b.c',name:'A'}};},
    async call(method,path,{body}={}){
      calls.push({method,path,body});
      const ok=data=>({status:200,contentType:'application/json',text:JSON.stringify(data)});
      if(path==='/integrations/google-drive/tools/search')return ok({ok:true,result:{items:[{id:'sheet123456789',title:'운동회 조직도',mimeType:'application/vnd.google-apps.spreadsheet',url:'https://docs.google.com/spreadsheets/d/sheet123456789/edit'}]}});
      if(path==='/integrations/google-sheets/operations/preview'){
        if(body.spreadsheet_url?.includes('nosheets'))return {status:409,contentType:'application/json',text:JSON.stringify({error:'Google Sheets editing permission is not connected'})};
        const id='00000000-0000-4000-8000-00000000000'+(++n);
        return ok({ok:true,operation:{id,kind:body.kind,approval_token:'secret-approval-'+n,expires_at:new Date(Date.now()+600000).toISOString(),spreadsheet_url:body.spreadsheet_url,spreadsheet_title:'운동회',range:body.range,proposed_values:body.values,current_values:[['기존','값']],sheet_names:['조직도','명단']}});
      }
      const commit=/^\/integrations\/google-sheets\/operations\/([^/]+)\/commit$/.exec(path);
      if(commit)return ok({ok:true,operation:{id:commit[1],updated_cells:4,spreadsheet_url:'https://docs.google.com/spreadsheets/d/sheet123456789/edit'}});
      return {status:404,contentType:'application/json',text:'{"error":"no"}'};
    }};
}

async function setup(t,lapis){
  const dir=mkdtempSync(join(tmpdir(),'lapis-conn-'));
  const connectorsFile=join(dir,'connectors.json');
  writeFileSync(connectorsFile,JSON.stringify({version:1,bots:{kao:{name:'카오',tokenHash:sha(TOKEN),lapis:{enabled:true,google:'chat',calendar:true,tasks:true,...lapis}}}}));
  const tokenFile=join(dir,'kao.token');writeFileSync(tokenFile,TOKEN);
  const cloud=fakeCloud();
  const server=createDashboardServer({requireLogin:false,dataDir:dir,cloud,connectorsFile,
    taskStore:createTaskStore(join(dir,'tasks.json')),calendarStore:createCalendarStore(join(dir,'calendar.json')),telegramSnapshot:async()=>({bots:[],messages:[]})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base='http://127.0.0.1:'+server.address().port;
  return {base,cloud,tokenFile,connectorsFile};
}

// MCP 서버를 띄워 JSON-RPC 로 말을 건다.
function mcp(t,env){
  const child=spawn(process.execPath,[MCP],{env:{...process.env,...env},stdio:['pipe','pipe','inherit']});
  t.after(()=>child.kill());
  let buf='',id=0;const waiting=new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const msg=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);waiting.get(msg.id)?.(msg);waiting.delete(msg.id);}});
  const rpc=(method,params)=>new Promise(r=>{const n=++id;waiting.set(n,r);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
  const tool=async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).result;
  return {rpc,tool,notify:(method)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method})+'\n')};
}

test('MCP 서버 → 대시보드 → 클라우드: 시트 보기·미리보기·채팅 확인 후 적용, 승인 토큰은 봇에게 주지 않는다',async t=>{
  const {base,cloud,tokenFile}=await setup(t,{});
  const m=mcp(t,{LAPIS_CONNECTOR_URL:base,LAPIS_CONNECTOR_TOKEN_FILE:tokenFile});
  const init=(await m.rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}})).result;
  assert.equal(init.protocolVersion,'2025-06-18');
  assert.match(init.instructions,/apply_change/);
  m.notify('notifications/initialized');
  const names=(await m.rpc('tools/list',{})).result.tools.map(x=>x.name);
  for(const n of ['lapis_status','drive_search','sheet_inspect','sheet_write','doc_write','apply_change','calendar_add','task_add'])assert.ok(names.includes(n),n);

  const found=await m.tool('drive_search',{query:'운동회 조직도'});
  assert.match(found.content[0].text,/운동회 조직도/);
  const inspect=await m.tool('sheet_inspect',{spreadsheet_url:'https://docs.google.com/spreadsheets/d/sheet123456789/edit#gid=0'});
  assert.match(inspect.content[0].text,/탭: 조직도, 명단/);

  const preview=await m.tool('sheet_write',{action:'update',spreadsheet_url:'sheet123456789',range:"'조직도'!A1",values:[['부서','이름'],['총괄','미정']]});
  const text=preview.content[0].text;
  assert.match(text,/아직 아무것도 바뀌지 않았어요/);
  assert.ok(!text.includes('secret-approval'),'승인 토큰이 봇에게 나가면 안 된다');
  const opId=/operation_id: (\S+)/.exec(text)[1];
  assert.equal(cloud.calls.filter(c=>c.path.endsWith('/commit')).length,0);

  const applied=await m.tool('apply_change',{operation_id:opId});
  assert.match(applied.content[0].text,/✓ 적용했어요.*4칸/s);
  const commit=cloud.calls.find(c=>c.path.endsWith('/commit'));
  assert.equal(commit.body.approval_token,'secret-approval-2');
  assert.match((await m.tool('apply_change',{operation_id:opId})).content[0].text,/이미 적용된/);
  assert.equal(cloud.calls.filter(c=>c.path.endsWith('/commit')).length,1,'두 번 적용하지 않는다');

  // 클라우드의 영어 오류는 사용자에게 전할 수 있는 말로 바뀐다
  const denied=await m.tool('sheet_write',{action:'append',spreadsheet_url:'https://docs.google.com/spreadsheets/d/nosheets123456/edit',range:'A1',values:[['x']]});
  assert.equal(denied.isError,true);assert.match(denied.content[0].text,/Google 연결/);

  // 일정·할 일
  assert.match((await m.tool('calendar_add',{title:'운동회 회의',start:'2026-10-10T19:00'})).content[0].text,/일정을 넣었어요/);
  assert.match((await m.tool('calendar_list',{from:'2026-10-10',to:'2026-10-10'})).content[0].text,/운동회 회의/);
  const added=await m.tool('task_add',{title:'명단 받기',due:'2026-10-12'});
  assert.match(added.content[0].text,/할 일을 넣었어요/);
  const listed=(await m.tool('tasks_list',{})).content[0].text;
  const taskId=/id: (\S+)/.exec(listed)[1];
  assert.match((await m.tool('task_done',{id:taskId})).content[0].text,/끝냄/);

  const log=await (await fetch(base+'/api/connector/activity?bot=kao')).json();
  assert.ok(log.items.some(i=>i.tool==='apply_change'&&i.ok));
});

test('「앱에서 승인」: 봇은 적용할 수 없고, 화면에서 승인해야 적용된다',async t=>{
  const {base,cloud,tokenFile}=await setup(t,{google:'app'});
  const m=mcp(t,{LAPIS_CONNECTOR_URL:base,LAPIS_CONNECTOR_TOKEN_FILE:tokenFile});
  await m.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{}});
  const opId=/operation_id: (\S+)/.exec((await m.tool('sheet_write',{action:'append',spreadsheet_url:'sheet123456789',range:'A1',values:[['a']]})).content[0].text)[1];
  assert.match((await m.tool('apply_change',{operation_id:opId})).content[0].text,/승인하지 않았어요/);
  assert.equal(cloud.calls.filter(c=>c.path.endsWith('/commit')).length,0);

  const pending=await (await fetch(base+'/api/connector/pending')).json();
  assert.equal(pending.items.length,1);assert.equal(pending.items[0].botName,'카오');
  assert.ok(!JSON.stringify(pending).includes('secret-approval'));
  // 화면 밖(표시 머리말 없음)에서는 승인할 수 없다
  assert.equal((await fetch(base+`/api/connector/pending/${opId}/approve`,{method:'POST'})).status,403);
  const ok=await fetch(base+`/api/connector/pending/${opId}/approve`,{method:'POST',headers:{'content-type':'application/json','x-lapis-request':'1'},body:'{}'});
  assert.equal(ok.status,200);
  assert.equal(cloud.calls.filter(c=>c.path.endsWith('/commit')).length,1);
  assert.match((await m.tool('apply_change',{operation_id:opId})).content[0].text,/이미 적용된/);
});

test('관문 보안: 키 없음·틀린 키·브라우저 요청·꺼진 권한은 거절한다',async t=>{
  const {base,cloud,connectorsFile}=await setup(t,{google:'read',tasks:false});
  // fetch 는 sec-fetch-mode 를 붙여 브라우저 요청으로 보이므로(관문이 거절), MCP 서버처럼 node:http 로 부른다.
  const call=(headers,body={tool:'_list'})=>new Promise((ok,bad)=>{const u=new URL(base);const data=JSON.stringify(body);
    const req=http.request({host:u.hostname,port:u.port,path:'/api/connector/call',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data),...headers}},res=>{let t='';res.setEncoding('utf8');res.on('data',c=>t+=c);res.on('end',()=>ok({status:res.statusCode,json:async()=>JSON.parse(t)}));});
    req.on('error',bad);req.end(data);});
  assert.equal((await fetch(base+'/api/connector/call',{method:'POST',headers:{authorization:'Bearer '+TOKEN},body:'{}'})).status,403,'브라우저식 요청(fetch)은 거절');
  assert.equal((await call({})).status,401);
  assert.equal((await call({authorization:'Bearer '+'x'.repeat(43)})).status,401);
  assert.equal((await call({authorization:'Bearer '+TOKEN,origin:base})).status,403);
  assert.equal((await call({authorization:'Bearer '+TOKEN,'sec-fetch-site':'same-origin'})).status,403);
  const listed=await (await call({authorization:'Bearer '+TOKEN})).json();
  const names=listed.tools.map(x=>x.name);
  assert.ok(names.includes('drive_search')&&!names.includes('sheet_write')&&!names.includes('task_add'));
  const denied=await call({authorization:'Bearer '+TOKEN},{tool:'sheet_write',args:{action:'create',title:'x',values:[['a']]}});
  assert.equal(denied.status,403);assert.match((await denied.json()).error,/Google 쓰기 권한이 꺼져/);
  assert.equal(cloud.calls.length,0);
  // 엔진이 설정을 바꾸면(파일 갱신) 바로 따른다
  await new Promise(r=>setTimeout(r,30));
  writeFileSync(connectorsFile,JSON.stringify({version:1,bots:{kao:{tokenHash:sha(TOKEN),lapis:{enabled:false}}}}));
  assert.equal((await call({authorization:'Bearer '+TOKEN})).status,403);
});

test('대시보드가 꺼져 있어도 MCP 서버는 이유를 알려 주는 상태 도구를 보여 준다',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lapis-conn-off-'));
  const tokenFile=join(dir,'kao.token');writeFileSync(tokenFile,TOKEN);
  const m=mcp(t,{LAPIS_CONNECTOR_URL:'http://127.0.0.1:9',LAPIS_CONNECTOR_TOKEN_FILE:tokenFile});
  await m.rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{}});
  assert.deepEqual((await m.rpc('tools/list',{})).result.tools.map(x=>x.name),['lapis_status']);
  const s=await m.tool('lapis_status');
  assert.equal(s.isError,true);assert.match(s.content[0].text,/LAPIS 앱/);
  assert.equal((await m.rpc('nope',{})).error.code,-32601);
});
