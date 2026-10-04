import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve,dirname,extname,sep,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {statfs} from 'node:fs/promises';
import {RequestError,readLimited,upstream,RentalSessions} from './proxy.mjs';
import {createVault,dpapi} from './vault.mjs';
import {createCloud} from './lapis-cloud.mjs';
import {createCalendarStore,createGoogleCalendar} from './calendar.mjs';
import {createExtraRoutes} from './extra-routes.mjs';
import {createTaskStore} from './tasks.mjs';
import {createAccounts} from './accounts.mjs';
import {rentalUrl as configuredRentalUrl} from './config.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OFFICE_ROUTES=JSON.parse(readFileSync(join(ROOT,'src/office-routes.json'),'utf8')).map(r=>({
  method:r.method,re:new RegExp('^'+r.path.replace(/:[a-z]+/g,'[A-Za-z0-9_.%-]+')+'$')
}));
const RENTAL_ROUTES=[
  ['GET',/^\/list\/(data|photo)$/],['GET',/^\/admin\/photo$/],
  ['GET',/^\/admin\/api\/(summary|rentals|events|collected|catalog|history-reset|history-reset\/archive)$/],
  ['GET',/^\/admin\/api\/rentals\/R-\d{8}-\d+$/],
  ['GET',/^\/admin\/api\/catalog\/[A-Za-z0-9_-]+\/detail$/],
  ['GET',/^\/admin\/api\/export\/(catalog|rentals|events|collected)\.csv$/],
  ['POST',/^\/admin\/api\/(login|logout|catalog|photo|settings|telegram-test|history-reset\/(check|cancel|run-now))$/],
  ['POST',/^\/admin\/api\/rentals\/R-\d{8}-\d+\/(cancel|force-return|note)$/],
  ['POST',/^\/admin\/api\/catalog\/[A-Za-z0-9_-]+(?:\/cover)?$/],
];
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
function json(res,status,data,headers={}){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(data));
}
function respond(res,result,extra={}){
  res.writeHead(result.status,{
    'content-type':result.headers.get('content-type')||'application/octet-stream',
    'cache-control':'no-store',
    ...(result.headers.get('content-disposition')?{'content-disposition':result.headers.get('content-disposition')}:{}),...extra
  });res.end(result.bytes);
}
async function readJson(req){
  const buffer=await readLimited(req,200000);
  try{return JSON.parse(buffer.toString('utf8')||'{}');}catch{throw new RequestError(400,'요청 형식이 올바르지 않습니다.');}
}
async function fetchJson(url){
  const result=await upstream(url,{limit:2*1024*1024});
  if(result.status<200||result.status>=300)throw new RequestError(502,'서비스 조회 실패 ('+result.status+')');
  try{return JSON.parse(result.bytes.toString('utf8'));}catch{throw new RequestError(502,'서비스 응답을 읽지 못했습니다.');}
}
async function safeJson(url){
  try{return {ok:true,data:await fetchJson(url)};}catch(e){return {ok:false,error:e.message};}
}
// 이 PC 의 드라이브 용량(읽기 전용). 응답 없는 빈 드라이브(카드리더 등)가 화면을 막지 않도록 짧게 기다린다.
async function localDrives(){
  const letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const found=await Promise.all(letters.map(async letter=>{
    try{
      const info=await Promise.race([statfs(letter+':/'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),1500))]);
      const total=Number(info.blocks)*Number(info.bsize),free=Number(info.bavail)*Number(info.bsize);
      return total>0?{letter,total,free}:null;
    }catch{return null;}
  }));
  return found.filter(Boolean);
}
// 로그인 없이 부를 수 있는 기능: 로그인·가입에 필요한 것과 상태 확인뿐이다.
const PUBLIC=new Set(['GET /api/health','GET /api/features','GET /api/cloud/state','GET /api/cloud/consents','POST /api/cloud/login','POST /api/cloud/register','POST /api/cloud/login/start','POST /api/cloud/login/poll','GET /oauth/google/callback']);
const needsLogin=(method,path)=>/^\/(api|office|rental|oauth)\//.test(path)&&!PUBLIC.has(method+' '+path);
async function signedIn(cloud){try{return (await cloud.state()).signedIn===true;}catch{return false;}}
export function createDashboardServer(options={}){
  const officeUrl=options.officeUrl||'http://127.0.0.1:5000';
  const rentalUrl=options.rentalUrl||configuredRentalUrl();
  const hermesUrl=options.hermesUrl||'http://127.0.0.1:8642';
  const hermesHome=options.hermesHome||join(homedir(),'AppData/Local/hermes/profiles/lapis-pilot');
  const getDrives=options.drives||localDrives;
  const dataDir=options.dataDir||join(ROOT,'.runtime/data');
  const vault=options.vault||createVault(join(dataDir,'vault.bin'));   // PC 전체에 하나: 누가 로그인했는지(클라우드 세션)만 담는다
  const cloud=options.cloud||createCloud({vault,baseUrl:options.cloudBase||undefined,fetchImpl:options.cloudFetch});
  // 회원제: 로그인이 있어야 앱을 쓸 수 있고, 할 일·일정·Google 연결 정보는 계정마다 따로 보관한다.
  // requireLogin:false 는 자동 시험·개발 전용(예전처럼 한 곳에 저장).
  const requireLogin=options.requireLogin!==false;
  const accounts=requireLogin&&!options.calendarStore&&!options.taskStore?createAccounts({dataDir,cloud,pcVault:vault,createVault:file=>createVault(file,options.vaultCrypto||dpapi),createTaskStore,createCalendarStore}):null;
  const calendarStore=options.calendarStore||accounts?.calendar||createCalendarStore(join(dataDir,'calendar.json'));
  const taskStore=options.taskStore||accounts?.tasks||createTaskStore(join(dataDir,'tasks.json'));
  const gcal=options.googleCalendar||createGoogleCalendar({vault:accounts?.vault||vault,store:calendarStore,cloud,fetchImpl:options.googleFetch});
  // 사무실에 맡긴 드라이브 위치(드라이브 접근)를 Office 에서 읽어 저장소 화면의 허용 범위로 쓴다.
  const getGrants=options.grants||(async()=>{
    const overview=await fetchJson(officeUrl+'/api/overview');
    const office=(overview.offices||[]).find(o=>o.kind!=='hermes'&&!o.readonly&&o.exists!==false);
    if(!office)return [];
    const detail=await fetchJson(officeUrl+'/api/offices/'+encodeURIComponent(office.id));
    return (detail.drives||[]).map(g=>g.path);
  });
  const extra=createExtraRoutes({cloud,calendar:calendarStore,gcal,tasks:taskStore,getGrants,listLocal:options.listLocal,reveal:options.reveal});
  const sessions=new RentalSessions();
  const getTelegram=options.telegramSnapshot||(()=>import('./telegram.mjs').then(m=>m.telegramSnapshot()));
  let overviewCache=null,overviewPending=null;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try{
      const port=server.address()?.port;
      const hosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);
      if(!hosts.has(req.headers.host))throw new RequestError(421,'이 PC의 대시보드 주소로 접속해 주세요.');
      const origin=req.headers.origin;
      const url=new URL(req.url,'http://127.0.0.1:'+port);
      // Google 로그인 후 브라우저가 돌아오는 주소만 다른 사이트에서 오는 이동을 허용한다(한 번만 쓰는 state 값으로 확인).
      const oauthReturn=req.method==='GET'&&url.pathname==='/oauth/google/callback';
      if(!oauthReturn&&((origin&&!hosts.has(origin.replace(/^http:\/\//,'')))||req.headers['sec-fetch-site']==='cross-site'))throw new RequestError(403,'대시보드 화면에서 접속해 주세요.');
      if(/%2f|%5c|%00/i.test(url.pathname))throw new RequestError(400,'잘못된 경로입니다.');
      const write=!['GET','HEAD'].includes(req.method);
      if(write&&req.headers['x-lapis-request']!=='1')throw new RequestError(403,'대시보드 화면에서만 조작할 수 있습니다.');
      // 회원제 게이트: 화면 파일을 뺀 모든 기능은 로그인한 뒤에만 쓸 수 있다.
      if(requireLogin&&needsLogin(req.method,url.pathname)&&!(await signedIn(cloud)))throw new RequestError(401,'로그인이 필요해요.');
      if(await extra(req,res,url,{json,readJson,readRaw:(request,limit)=>readLimited(request,limit),port}))return;
      if(url.pathname==='/api/overview'&&req.method==='GET'){
        if(!overviewCache||Date.now()-overviewCache.at>5000){
          overviewPending??=Promise.all([safeJson(officeUrl+'/api/overview'),safeJson(rentalUrl+'/list/data')])
            .then(([office,stock])=>overviewCache={at:Date.now(),value:{observedAt:new Date().toISOString(),office,stock}})
            .finally(()=>{overviewPending=null;});
          await overviewPending;
        }return json(res,200,overviewCache.value);
      }
      if(url.pathname==='/api/telegram'&&req.method==='GET')return json(res,200,await getTelegram());
      if(url.pathname==='/api/drives'&&req.method==='GET')return json(res,200,{drives:await getDrives()});
      // 개인용 연결(물품 대여 등)은 주소가 설정돼 있을 때만 화면에 보인다.
      if(url.pathname==='/api/features'&&req.method==='GET')return json(res,200,{rental:Boolean(rentalUrl),cloud:true});
      if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{app:'lapis-office-dashboard',version:'0.3.0',receiversOwned:0});
      if(url.pathname==='/api/hermes/health'&&req.method==='GET')return respond(res,await upstream(hermesUrl+'/health',{timeout:5000,limit:10000}));
      if(url.pathname==='/api/hermes/chat'&&req.method==='POST'){
        const body=await readJson(req);
        if(typeof body.message!=='string'||!body.message.trim()||body.message.length>8000)throw new RequestError(400,'업무 내용을 1~8,000자로 입력해 주세요.');
        let env;try{env=await readFile(join(hermesHome,'.env'),'utf8');}catch{throw new RequestError(503,'Hermes API 설정을 찾을 수 없습니다.');}
        const key=/^API_SERVER_KEY\s*=\s*(.+)$/m.exec(env)?.[1].trim().replace(/^["']|["']$/g,'');
        if(!key)throw new RequestError(503,'Hermes API 인증이 설정되지 않았습니다.');
        const result=await upstream(hermesUrl+'/v1/chat/completions',{
          method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},
          body:JSON.stringify({messages:[{role:'user',content:body.message.trim()}],stream:false}),timeout:180000,limit:2*1024*1024
        });
        if(result.status!==200)throw new RequestError(result.status,'Hermes가 요청을 처리하지 못했습니다. 요청을 자동 반복하지 않았습니다.');
        let response;try{response=JSON.parse(result.bytes.toString('utf8'));}catch{throw new RequestError(502,'Hermes 응답 형식이 올바르지 않습니다.');}
        const text=response.choices?.[0]?.message?.content;
        if(typeof text!=='string')throw new RequestError(502,'Hermes 응답을 확인하지 못했습니다.');
        return json(res,200,{text,source:'hermes-api',deliveryVerified:false});
      }
      if(url.pathname.startsWith('/office/')){
        const path=url.pathname.slice('/office'.length);
        if(!OFFICE_ROUTES.some(r=>r.method===req.method&&r.re.test(path)))throw new RequestError(404,'연결되지 않은 Office 기능입니다.');
        const body=write?await readLimited(req,200000):undefined;
        // 로컬 AI 시험 대화처럼 오래 걸리는 요청은 더 기다린다.
        const slow=/^\/api\/bots\/[^/]+\/test$/.test(path);
        const result=await upstream(officeUrl+path+url.search,{method:req.method,body,headers:write?{'content-type':'application/json','x-ai-office':'1'}:{},timeout:slow?190000:60000});
        overviewCache=null;return respond(res,result);
      }
      if(url.pathname.startsWith('/rental/')){
        const path=url.pathname.slice('/rental'.length);
        if(!RENTAL_ROUTES.some(([method,re])=>method===req.method&&re.test(path)))throw new RequestError(404,'연결되지 않은 창고 기능입니다.');
        const session=sessions.get(req.headers.cookie),headers={};
        // Warehouse sessions are signed cookies; its logout only removes that cookie.
        // Our upstream cookie lives here, so revoke it locally even if the service is down.
        if(path==='/admin/api/logout')return json(res,200,{ok:true},{'set-cookie':sessions.logout(session?.id)});
        if(session)headers.cookie=session.cookie;
        if(write)headers['content-type']=req.headers['content-type']||'application/json';
        const body=write?await readLimited(req,12*1024*1024):undefined;
        const result=await upstream(rentalUrl+path+url.search,{method:req.method,body,headers,timeout:60000});
        const extra={};
        if(path==='/admin/api/login'&&result.status===200){
          extra['set-cookie']=sessions.login(result.headers.get('set-cookie'));
          if(session)sessions.logout(session.id);
        }
        return respond(res,result,extra);
      }
      if(req.method!=='GET')throw new RequestError(405,'허용되지 않는 요청입니다.');
      const publicRoot=url.pathname.startsWith('/modules/')?join(ROOT,'modules'):join(ROOT,'web');
      const relative=url.pathname.startsWith('/modules/')?url.pathname.slice(9):(url.pathname==='/'?'index.html':url.pathname.slice(1));
      const file=resolve(publicRoot,decodeURIComponent(relative));
      if(!file.startsWith(publicRoot+sep)||!TYPES[extname(file)])throw new RequestError(404,'파일을 찾을 수 없습니다.');
      let contents;try{contents=await readFile(file);}catch{throw new RequestError(404,'파일을 찾을 수 없습니다.');}
      res.writeHead(200,{'content-type':TYPES[extname(file)],'cache-control':'no-store'});res.end(contents);
    }catch(e){if(process.env.LAPIS_DEBUG)console.error(e);
      if(!res.headersSent)json(res,e instanceof RequestError?e.status:500,{error:e instanceof RequestError?e.message:'처리 중 오류가 발생했습니다.'});
      else res.end();
    }
  });return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const port=Number(process.env.LAPIS_DASHBOARD_PORT||4310);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid dashboard port');
  const server=createDashboardServer({dataDir:process.env.LAPIS_DATA_DIR||undefined,officeUrl:process.env.LAPIS_OFFICE_URL||undefined});
  server.listen(port,'127.0.0.1',()=>console.log('LAPIS Office: http://127.0.0.1:'+port));
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'지정한 포트가 이미 사용 중입니다.':'대시보드 시작 실패');process.exitCode=1;});
}
