// 라피스 클라우드(본인 Cloudflare Worker) 클라이언트.
// 기존 Electron 에디터가 쓰던 같은 서버 API 로 로그인·Google 연결·드라이브·시트·문서·기억·학습·저장소를 쓴다.
// 로그인 토큰은 이 서버만 보관(DPAPI 암호화)하고 화면에는 내보내지 않는다. 허용 목록 밖의 경로는 서버가 대신 호출하지 않는다.
import {randomUUID} from 'node:crypto';

import {cloudBase} from './config.mjs';
export class CloudError extends Error{constructor(status,message){super(message);this.status=status;}}

const okStatus=s=>s>=200&&s<300;
export const MAX_AVATAR=5*1024*1024;
// 올린 사진이 정말 그림 파일인지 앞부분(매직 넘버)으로 확인한다. 확장자·헤더의 말은 믿지 않는다.
export function sniffImage(b){
  if(!Buffer.isBuffer(b)||b.length<16)return null;
  if(b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'image/png';
  if(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'image/jpeg';
  if(b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
  return null;
}
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
const FILE_SERVER_PATH=/^\/(?:file-servers(?:\/[^?#]*)?|file-server-invitations\/redeem)(?:\?[^#]*)?$/;
const FILE_SERVER_STREAM_PATH=/^\/file-servers\/[0-9a-f-]{36}\/(?:files|download)\?[^#]*$/;

export function createCloud({baseUrl=cloudBase(),vault,fetchImpl=fetch,appVersion='dashboard-0.3'}){
  const attempts=new Map();
  // 비밀번호 대입을 이 PC 에서도 막는다(서버 제한과 별개): 같은 아이디로 10분에 8번 틀리면 잠시 멈춘다.
  const fails=new Map();
  const throttle={
    check(key){const k=key.toLowerCase();const list=(fails.get(k)||[]).filter(t=>Date.now()-t<600000);fails.set(k,list);if(list.length>=8)throw new CloudError(429,'시도가 너무 많아요. 10분 뒤에 다시 해 주세요.');},
    fail(key){const k=key.toLowerCase();fails.set(k,[...(fails.get(k)||[]),Date.now()]);if(fails.size>500)fails.clear();},
    clear(key){fails.delete(key.toLowerCase());},
  };
  async function saveSession(data){
    const accessToken=typeof data.access_token==='string'?data.access_token:data.token;
    const user=data.user&&typeof data.user==='object'?data.user:null;
    if(!accessToken||typeof data.refresh_token!=='string'||typeof user?.id!=='string'||typeof user?.email!=='string')
      throw new CloudError(502,'서버가 올바른 로그인 결과를 돌려주지 않았습니다.');
    const name=user.name||user.display_name||user.email;
    await vault.update({cloud:{accessToken,refreshToken:data.refresh_token,user:{id:user.id,email:user.email,name,username:typeof user.username==='string'?user.username:''}}});
    return {signedIn:true,user:{id:user.id,email:user.email,name,username:typeof user.username==='string'?user.username:''}};
  }
  let refreshing=null;

  async function raw(route,{method='GET',body,bytes,contentType,binary=false,token,timeout=25000}={}){
    if(!baseUrl)throw new CloudError(503,'라피스 클라우드 주소가 설정되지 않았습니다. config.local.json 의 cloudBase 를 채워 주세요.');
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(bytes!==undefined)headers['Content-Type']=contentType||'application/octet-stream';
    if(token)headers.Authorization='Bearer '+token;
    let response;
    try{response=await fetchImpl(baseUrl+route,{method,headers,body:bytes!==undefined?bytes:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});}
    catch{throw new CloudError(503,'라피스 서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.');}
    if(binary){
      const buffer=Buffer.from(await response.arrayBuffer());
      return {status:response.status,contentType:response.headers.get('content-type')||'application/octet-stream',text:'',buffer};
    }
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
      return saved?{signedIn:true,user:{id:saved.user.id,email:saved.user.email,name:saved.user.name,username:saved.user.username||''}}:{signedIn:false};
    },
    // ── 회원가입·로그인(이메일/아이디 + 비밀번호). Google 로그인은 아래 startGoogleLogin 을 쓴다. ──
    async consents(){
      const result=await raw('/legal/consents/current');
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'가입 동의문을 불러오지 못했습니다'));
      const docs=Array.isArray(parse(result.text).documents)?parse(result.text).documents:[];
      const out=docs.filter(d=>d&&typeof d.consent_type==='string'&&typeof d.version==='string'&&typeof d.title==='string'&&typeof d.body_markdown==='string'&&typeof d.document_hash==='string')
        .map(d=>({consentType:d.consent_type,version:d.version,title:d.title,bodyMarkdown:d.body_markdown,documentHash:d.document_hash,required:d.required===true}));
      if(!out.length)throw new CloudError(502,'가입 동의문을 불러오지 못했습니다.');
      return out;
    },
    async login({identifier,password}={}){
      identifier=String(identifier||'').trim();password=String(password||'');
      if(!identifier||identifier.length>254||!password||password.length>128)throw new CloudError(400,'아이디(또는 이메일)와 비밀번호를 입력해 주세요.');
      throttle.check(identifier);
      const result=await raw('/auth/login',{method:'POST',body:{identifier,password}});
      if(!okStatus(result.status)){
        if([400,401,403].includes(result.status))throttle.fail(identifier);
        throw new CloudError(result.status,result.status===401?'아이디(이메일) 또는 비밀번호가 올바르지 않아요.':errorOf(result,'로그인하지 못했습니다'));
      }
      throttle.clear(identifier);
      return saveSession(parse(result.text));
    },
    async register(input={}){
      const body={
        username:String(input.username||'').trim().toLowerCase(),email:String(input.email||'').trim().toLowerCase(),
        display_name:String(input.displayName||'').trim(),phone:String(input.phone||'').trim()||null,password:String(input.password||''),
        consents:(Array.isArray(input.consents)?input.consents:[]).slice(0,10).map(c=>({consent_type:String(c.consentType||''),version:String(c.version||''),document_hash:String(c.documentHash||''),granted:c.granted===true})),
        locale:'ko-KR',app_version:appVersion,
      };
      if(!/^[a-z0-9][a-z0-9._-]{3,29}$/.test(body.username))throw new CloudError(400,'아이디는 영문 소문자·숫자 4~30자로 적어 주세요.');
      if(!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(body.email))throw new CloudError(400,'이메일 형식을 확인해 주세요.');
      if(!body.display_name||body.display_name.length>80)throw new CloudError(400,'표시 이름(닉네임)을 1~80자로 적어 주세요.');
      if(body.password.length<12||body.password.length>128)throw new CloudError(400,'비밀번호는 12자 이상으로 정해 주세요.');
      throttle.check('register');
      const result=await raw('/auth/register',{method:'POST',body});
      if(!okStatus(result.status)){
        throttle.fail('register');
        throw new CloudError(result.status,result.status===409?'이미 가입된 아이디 또는 이메일이에요.':errorOf(result,'회원가입하지 못했습니다'));
      }
      return saveSession(parse(result.text));
    },
    // ── 프로필: 닉네임(표시 이름)·전화번호·사진 ──
    async profile(){
      const [me,identity]=await Promise.all([authed('/auth/me'),authed('/me/identity-profile')]);
      if(!okStatus(me.status))throw new CloudError(me.status,errorOf(me,'내 정보를 불러오지 못했습니다'));
      const user=parse(me.text).user||{},profile=parse(identity.text);
      return {
        user:{id:user.id,username:user.username||'',email:user.email||'',name:user.name||user.display_name||'',createdAt:user.created_at||''},
        profile:{name:profile.profile?.name||user.name||'',phone:profile.profile?.phone||'',phoneNeedsReview:profile.profile?.phone_needs_review===true},
        revision:Number.isInteger(profile.revision)?profile.revision:0,
      };
    },
    async saveProfile({name,phone,revision}={}){
      name=String(name??'').trim();phone=String(phone??'').trim();
      if(!name||name.length>80)throw new CloudError(400,'닉네임을 1~80자로 적어 주세요.');
      if(phone&&!/^[0-9+\-() ]{7,24}$/.test(phone))throw new CloudError(400,'전화번호 형식을 확인해 주세요. (예: 010-1234-5678)');
      const result=await authed('/me/identity-profile',{method:'PUT',body:{expected_revision:Number.isInteger(revision)?revision:0,name,phone:phone||null}});
      if(!okStatus(result.status))throw new CloudError(result.status,result.status===409?'다른 곳에서 먼저 바뀌었어요. 새로 불러온 뒤 다시 저장해 주세요.':errorOf(result,'프로필을 저장하지 못했습니다'));
      const saved=await session();
      if(saved)await vault.update({cloud:{...saved,user:{...saved.user,name}}});
      return {ok:true,revision:parse(result.text).revision,profile:{name,phone:parse(result.text).profile?.phone||''}};
    },
    async getAvatar(){
      const result=await authed('/me/avatar',{binary:true});
      if(result.status===404)return null;
      if(!okStatus(result.status))throw new CloudError(result.status,'프로필 사진을 불러오지 못했습니다.');
      const kind=sniffImage(result.buffer);
      if(!kind)return null;
      return {type:kind,buffer:result.buffer};
    },
    async putAvatar(bytes){
      const kind=sniffImage(bytes);
      if(!kind)throw new CloudError(415,'PNG · JPG · WEBP 사진만 올릴 수 있어요.');
      if(bytes.length>MAX_AVATAR)throw new CloudError(413,'사진은 5MB 이하로 올려 주세요.');
      const result=await authed('/me/avatar',{method:'PUT',bytes,contentType:kind,timeout:60000});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'프로필 사진을 올리지 못했습니다'));
      return {ok:true};
    },
    async deleteAvatar(){
      const result=await authed('/me/avatar',{method:'DELETE'});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'프로필 사진을 지우지 못했습니다'));
      return {ok:true};
    },
    // ── 계정별 설정·기록 동기화(서버: /dashboard-sync). 비밀(토큰·키)은 보내지 않는다. ──
    async syncGet(){
      const result=await authed('/dashboard-sync');
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'클라우드 설정을 불러오지 못했습니다'));
      const d=parse(result.text);
      return {revision:Number.isInteger(d.revision)?d.revision:0,updatedAt:d.updatedAt||null,snapshot:d.snapshot&&typeof d.snapshot==='object'?d.snapshot:null};
    },
    async syncPut(snapshot,expectedRevision){
      const result=await authed('/dashboard-sync',{method:'PUT',body:{snapshot,expectedRevision},timeout:60000});
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'클라우드에 저장하지 못했습니다'));
      const d=parse(result.text);
      return {revision:d.revision,updatedAt:d.updatedAt};
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
      if(data.status!=='completed')throw new CloudError(502,'서버가 올바른 로그인 결과를 돌려주지 않았습니다.');
      const saved=await saveSession(data);
      attempts.delete(attemptId);
      return {status:'completed',user:saved.user};
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
    // ── 파일 서버(초대·멤버·기록·중계). 경로는 /file-servers…, /file-server-invitations/redeem 만 허용한다. ──
    async fileServers(method,path,body){
      if(!FILE_SERVER_PATH.test(path)||path.includes('..'))throw new CloudError(400,'지원하지 않는 파일 서버 요청입니다.');
      const result=await authed(path,{method,body});
      const data=parse(result.text);
      if(!okStatus(result.status))throw new CloudError(result.status,errorOf(result,'파일 서버 요청을 처리하지 못했습니다'));
      return data;
    },
    // 다운로드처럼 큰 응답은 메모리에 모으지 않고 그대로 흘려보낸다. 응답 머리를 받으면 시간 제한을 푼다.
    async fileServerStream(path,{range,signal}={}){
      if(!FILE_SERVER_STREAM_PATH.test(path)||path.includes('..'))throw new CloudError(400,'지원하지 않는 파일 서버 요청입니다.');
      if(!baseUrl)throw new CloudError(503,'라피스 클라우드 주소가 설정되지 않았습니다.');
      const once=async token=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
        const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
        try{
          const response=await fetchImpl(baseUrl+path,{headers:{Accept:'*/*',Authorization:'Bearer '+token,...(range?{Range:range}:{})},signal:controller.signal,redirect:'error'});
          return response;
        }catch{signal?.removeEventListener('abort',cancel);throw new CloudError(503,'라피스 서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.');}
        finally{clearTimeout(timer);}
      };
      const saved=await session();if(!saved)throw new CloudError(401,'라피스 계정에 로그인해 주세요.');
      let response=await once(saved.accessToken);
      if(response.status===401&&await refresh()){await response.body?.cancel().catch(()=>{});response=await once((await session()).accessToken);}
      if(response.status===401)throw new CloudError(401,'로그인이 만료되었습니다. 다시 로그인해 주세요.');
      return response;
    },
    // 허용 목록 안의 서버 경로를 로그인 정보로 대신 호출한다.
    async call(method,path,{query='',body}={}){
      if(!cloudRouteAllowed(method,path))throw new CloudError(404,'연결되지 않은 라피스 기능입니다.');
      return authed(path+query,{method,body});
    },
    raw,
  };
}
