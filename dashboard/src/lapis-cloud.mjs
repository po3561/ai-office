// 라피스 클라우드(본인 Cloudflare Worker) 클라이언트.
// 기존 Electron 에디터가 쓰던 같은 서버 API 로 로그인·Google 연결·드라이브·시트·문서·기억·학습·저장소를 쓴다.
// 로그인 토큰은 이 서버만 보관(DPAPI 암호화)하고 화면에는 내보내지 않는다. 허용 목록 밖의 경로는 서버가 대신 호출하지 않는다.
import {randomUUID} from 'node:crypto';

import {cloudBase} from './config.mjs';
export class CloudError extends Error{constructor(status,message){super(message);this.status=status;}}

const okStatus=s=>s>=200&&s<300;
const GOOGLE_SERVICES=['drive','calendar','youtube','sheets','docs','slides','gmail'];
const ID='[A-Za-z0-9_.:-]{1,128}';
// 화면이 부를 수 있는 서버 경로. 이 밖의 경로(관리자·텔레그램 연결 등)는 대신 호출하지 않는다.
export const CLOUD_ROUTES=[
  ['GET',/^\/integrations\/google-drive\/status$/],
  ['POST',/^\/integrations\/google-drive\/(browse|disconnect|tools\/search|tools\/read)$/],
  ['POST',/^\/integrations\/google-sheets\/operations\/preview$/],
  ['POST',new RegExp('^/integrations/google-sheets/operations/'+ID+'/commit$')],
  ['POST',/^\/integrations\/google-workspace\/operations\/preview$/],
  ['POST',new RegExp('^/integrations/google-workspace/operations/'+ID+'/commit$')],
  ['GET',/^\/files$/],['GET',new RegExp('^/files/'+ID+'$')],
  ['GET',/^\/everyday\/status$/],['POST',/^\/everyday\/today$/],
  ['GET',/^\/conversations$/],['GET',new RegExp('^/conversations/'+ID+'$')],
  ['POST',/^\/chat$/],
  ['GET',/^\/memories$/],['POST',/^\/memories$/],['POST',new RegExp('^/memories/'+ID+'/retract$')],['GET',new RegExp('^/memories/'+ID+'/history$')],
  ['GET',/^\/core-link\/consciousness$/],
  ['GET',/^\/training\/(readiness|fine-tune\/jobs|dataset\.jsonl)$/],['POST',/^\/training\/fine-tune$/],
];
export const cloudRouteAllowed=(method,path)=>CLOUD_ROUTES.some(([m,re])=>m===method&&re.test(path));

export function createCloud({baseUrl=cloudBase(),vault,fetchImpl=fetch,appVersion='dashboard-0.3'}){
  const attempts=new Map();
  let refreshing=null;

  async function raw(route,{method='GET',body,token,timeout=25000}={}){
    if(!baseUrl)throw new CloudError(503,'라피스 클라우드 주소가 설정되지 않았습니다. config.local.json 의 cloudBase 를 채워 주세요.');
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(token)headers.Authorization='Bearer '+token;
    let response;
    try{response=await fetchImpl(baseUrl+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
    catch{throw new CloudError(503,'라피스 서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.');}
    const text=await response.text();
    return {status:response.status,contentType:response.headers.get('content-type')||'application/json; charset=utf-8',text};
  }
  const parse=text=>{try{return JSON.parse(text);}catch{return {};}};
  const errorOf=(result,fallback)=>{const data=parse(result.text);return typeof data.error==='string'?data.error:typeof data.message==='string'?data.message:fallback+' ('+result.status+')';};

  async function session(){const saved=(await vault.read()).cloud;return saved?.accessToken&&saved?.refreshToken&&saved?.user?saved:null;}
  async function refresh(){
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      const saved=await session();if(!saved)return false;
      const result=await raw('/auth/refresh',{method:'POST',body:{refresh_token:saved.refreshToken}});
      const data=parse(result.text);
      const accessToken=typeof data.access_token==='string'?data.access_token:data.token;
      if(okStatus(result.status)&&accessToken&&typeof data.refresh_token==='string'){
        await vault.update({cloud:{...saved,accessToken,refreshToken:data.refresh_token}});return true;
      }
      // 일시적 장애는 로그인을 지우지 않는다. 세션이 거절된 경우만 로그아웃으로 본다.
      if([401,403].includes(result.status))await vault.update({cloud:undefined});
      return false;
    })();
    try{return await refreshing;}finally{refreshing=null;}
  }
  async function authed(route,options={}){
    const saved=await session();
    if(!saved)throw new CloudError(401,'라피스 계정에 로그인해 주세요.');
    let result=await raw(route,{...options,token:saved.accessToken});
    if(result.status===401&&await refresh()){
      result=await raw(route,{...options,token:(await session()).accessToken});
    }
    if(result.status===401)throw new CloudError(401,'로그인이 만료되었습니다. 다시 로그인해 주세요.');
    return result;
  }
  const rememberAttempt=(kind,data)=>{
    if(typeof data.attempt_id!=='string'||typeof data.poll_token!=='string'||typeof data.authorization_url!=='string')
      throw new CloudError(502,'서버가 올바른 인증 요청을 돌려주지 않았습니다.');
    const url=new URL(data.authorization_url);
    if(url.protocol!=='https:'||!/(^|\.)google\.com$/.test(url.hostname)&&!/workers\.dev$/.test(url.hostname))throw new CloudError(502,'예상하지 못한 인증 주소입니다.');
    attempts.set(data.attempt_id,{kind,pollToken:data.poll_token,expiresAt:Date.parse(data.expires_at)||Date.now()+10*60000});
    for(const [id,item] of attempts)if(item.expiresAt<Date.now()-60000)attempts.delete(id);
    return {attemptId:data.attempt_id,url:url.href,expiresAt:data.expires_at};
  };
  const takeAttempt=(attemptId,kind)=>{
    const attempt=attempts.get(attemptId);
    if(!attempt||attempt.kind!==kind)throw new CloudError(404,'인증 요청을 찾을 수 없습니다. 처음부터 다시 시도해 주세요.');
    return attempt;
  };

  return {
    async state(){
      const saved=await session();
      return saved?{signedIn:true,user:{id:saved.user.id,email:saved.user.email,name:saved.user.name}}:{signedIn:false};
    },
    async startGoogleLogin(){
      const result=await raw('/auth/google/start',{method:'POST',body:{app_version:appVersion,mode:'login',locale:'ko-KR'}});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'Google 로그인을 시작하지 못했습니다'));
      return rememberAttempt('login',parse(result.text));
    },
    async pollGoogleLogin(attemptId){
      const attempt=takeAttempt(attemptId,'login');
      const result=await raw('/auth/google/complete',{method:'POST',body:{attempt_id:attemptId,poll_token:attempt.pollToken}});
      const data=parse(result.text);
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'Google 로그인을 마치지 못했습니다'));
      if(data.status==='pending')return {status:'pending'};
      const accessToken=typeof data.access_token==='string'?data.access_token:data.token;
      const user=data.user&&typeof data.user==='object'?data.user:null;
      if(data.status!=='completed'||!accessToken||typeof data.refresh_token!=='string'||!user?.id||!user?.email)
        throw new CloudError(502,'서버가 올바른 로그인 결과를 돌려주지 않았습니다.');
      const name=user.name||user.display_name||user.email;
      await vault.update({cloud:{accessToken,refreshToken:data.refresh_token,user:{id:user.id,email:user.email,name}}});
      attempts.delete(attemptId);
      return {status:'completed',user:{id:user.id,email:user.email,name}};
    },
    async logout(){
      const saved=await session();
      if(saved)await raw('/auth/logout',{method:'POST',body:{},token:saved.accessToken}).catch(()=>undefined);
      await vault.update({cloud:undefined});
      return {signedIn:false};
    },
    async startGoogleConnect(services=['drive'],tier='standard'){
      if(!Array.isArray(services)||!services.length||!services.every(s=>GOOGLE_SERVICES.includes(s)))throw new CloudError(400,'연결할 Google 서비스를 확인해 주세요.');
      if(!['standard','advanced'].includes(tier))throw new CloudError(400,'권한 단계가 올바르지 않습니다.');
      const result=await authed('/integrations/google-drive/authorize',{method:'POST',body:{device_id:null,services:[...new Set(services)],permission_tier:tier}});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'Google 권한 연결을 시작하지 못했습니다'));
      return rememberAttempt('connect',parse(result.text));
    },
    async pollGoogleConnect(attemptId){
      const attempt=takeAttempt(attemptId,'connect');
      const result=await authed('/integrations/google-drive/authorize/complete',{method:'POST',body:{attempt_id:attemptId,poll_token:attempt.pollToken}});
      const data=parse(result.text);
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'Google 권한 연결을 마치지 못했습니다'));
      if(data.status==='completed')attempts.delete(attemptId);
      return {status:data.status==='completed'?'completed':'pending'};
    },
    // Google 캘린더 양방향 동기화: 서버의 OAuth 앱으로 권한(읽기+일정 쓰기)을 받는다. 확인은 pollGoogleConnect 로 한다.
    async startGoogleCalendarConnect(){
      const result=await authed('/integrations/google-calendar/authorize',{method:'POST',body:{}});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'Google 캘린더 연결을 시작하지 못했습니다'));
      return rememberAttempt('connect',parse(result.text));
    },
    // 서버의 캘린더 프록시. 경로 모양은 Google Calendar API v3 와 같다.
    async calendarApi(method,path,{query,body}={}){
      if(!/^\/(status|users\/me\/calendarList|calendars\/[^/]+\/events(\/[^/]+)?)$/.test(path))throw new CloudError(404,'연결되지 않은 캘린더 기능입니다.');
      const search=query?'?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined&&v!=='')):'';
      const result=await authed('/integrations/google-calendar'+path+search,{method,body});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'Google 캘린더 요청에 실패했습니다'));
      return parse(result.text);
    },
    // 허용 목록 안의 서버 경로를 로그인 정보로 대신 호출한다.
    async call(method,path,{query='',body}={}){
      if(!cloudRouteAllowed(method,path))throw new CloudError(404,'연결되지 않은 라피스 기능입니다.');
      return authed(path+query,{method,body});
    },
    raw,
  };
}
