// 라피스 자체 캘린더: 이 PC 의 파일에 일정을 저장하고, 원하면 Google 캘린더와 양방향으로 맞춘다.
// Google 연결은 기본으로 라피스 계정(서버의 OAuth 앱)을 쓰고, 고급 옵션으로 내 OAuth 클라이언트로 직접 연결할 수도 있다.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';

export class CalendarError extends Error{constructor(status,message){super(message);this.status=status;}}
const bad=message=>{throw new CalendarError(400,message);};

export const COLORS=['sky','blue','violet','green','amber','rose','gray'];
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const addDays=(day,n)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const validDay=value=>DAY.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const instant=value=>{const t=Date.parse(value);return Number.isNaN(t)?null:t;};

// 일정 한 건을 검사해 저장 형식으로 만든다. 종일 일정은 'YYYY-MM-DD'(끝날짜 포함), 시간 일정은 ISO 시각.
export function cleanEvent(input,previous={}){
  const value={...previous,...input};
  const title=String(value.title??'').trim();
  if(!title||title.length>200)bad('제목을 1~200자로 입력해 주세요.');
  const allDay=value.allDay===true;
  let start=String(value.start??''),end=String(value.end??value.start??'');
  if(allDay){
    if(!validDay(start)||!validDay(end))bad('날짜 형식이 올바르지 않습니다.');
    if(end<start)bad('끝나는 날짜가 시작보다 빠릅니다.');
  }else{
    const s=instant(start),e=instant(end);
    if(s===null||e===null)bad('시간 형식이 올바르지 않습니다.');
    if(e<s)bad('끝나는 시간이 시작보다 빠릅니다.');
    start=new Date(s).toISOString();end=new Date(e).toISOString();
  }
  const notes=String(value.notes??'');if(notes.length>4000)bad('메모는 4,000자까지 입력할 수 있습니다.');
  const location=String(value.location??'').trim();if(location.length>300)bad('장소는 300자까지 입력할 수 있습니다.');
  const color=value.color??'sky';if(!COLORS.includes(color))bad('색상이 올바르지 않습니다.');
  return {title,allDay,start,end,notes,location,color};
}

const blank=()=>({version:1,events:[],pendingDeletes:[],lastSync:null});
export function createCalendarStore(file){
  let data=null,queue=Promise.resolve();
  async function load(){
    if(data)return data;
    try{
      const parsed=JSON.parse(await readFile(file,'utf8'));
      if(parsed?.version!==1||!Array.isArray(parsed.events))throw new Error('format');
      data={...blank(),...parsed};
    }catch(error){
      if(error?.code==='ENOENT')data=blank();
      else throw new CalendarError(500,'저장된 일정을 읽지 못했습니다. 원본 파일을 보호하기 위해 저장을 중지했습니다: '+file);
    }
    return data;
  }
  async function save(){
    await mkdir(dirname(file),{recursive:true});
    const temp=file+'.'+process.pid+'.tmp';
    await writeFile(temp,JSON.stringify(data,null,1));await rename(temp,file);
  }
  // 동시에 들어온 쓰기가 서로 덮어쓰지 않도록 한 줄로 처리한다.
  const exclusive=fn=>{const run=queue.then(fn);queue=run.catch(()=>undefined);return run;};
  const startOf=event=>event.allDay?new Date(event.start+'T00:00:00').getTime():Date.parse(event.start);
  const endOf=event=>event.allDay?new Date(addDays(event.end,1)+'T00:00:00').getTime():Math.max(Date.parse(event.end),Date.parse(event.start)+1);
  const publicEvent=({syncedAt,remoteUpdated,...rest})=>rest;
  return {
    async list(from,to){
      const db=await load();
      if(!validDay(from)||!validDay(to)||to<=from)bad('조회 기간이 올바르지 않습니다.');
      const a=new Date(from+'T00:00:00').getTime(),b=new Date(to+'T00:00:00').getTime();
      return db.events.filter(e=>startOf(e)<b&&endOf(e)>a).sort((x,y)=>startOf(x)-startOf(y)).map(publicEvent);
    },
    async all(){return (await load()).events.map(publicEvent);},
    create:input=>exclusive(async()=>{
      const db=await load();
      if(db.events.length>=5000)bad('일정은 5,000건까지 저장할 수 있습니다.');
      const now=new Date().toISOString();
      const event={id:randomUUID(),...cleanEvent(input),source:'local',googleId:null,createdAt:now,updatedAt:now};
      db.events.push(event);await save();return publicEvent(event);
    }),
    update:(id,input)=>exclusive(async()=>{
      const db=await load();const event=db.events.find(e=>e.id===id);
      if(!event)throw new CalendarError(404,'일정을 찾을 수 없습니다.');
      if(event.readOnly)throw new CalendarError(403,'읽기 전용 Google 캘린더의 일정이라 여기서 고칠 수 없어요.');
      Object.assign(event,cleanEvent(input,event),{updatedAt:new Date().toISOString()});
      await save();return publicEvent(event);
    }),
    remove:id=>exclusive(async()=>{
      const db=await load();const index=db.events.findIndex(e=>e.id===id);
      if(index<0)throw new CalendarError(404,'일정을 찾을 수 없습니다.');
      if(db.events[index].readOnly)throw new CalendarError(403,'읽기 전용 Google 캘린더의 일정이라 여기서 지울 수 없어요.');
      const [event]=db.events.splice(index,1);
      if(event.googleId)db.pendingDeletes.push({calendarId:event.googleCalendarId||'primary',id:event.googleId});
      await save();return {ok:true};
    }),
    // 동기화가 쓰는 내부 접근. 변경은 반드시 transaction 안에서 한다.
    transaction:fn=>exclusive(async()=>{const db=await load();const result=await fn(db);await save();return result;}),
    async state(){const db=await load();return {lastSync:db.lastSync,count:db.events.length,pendingDeletes:db.pendingDeletes.length};},
    async ics(){
      const db=await load();
      const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
      const stamp=v=>new Date(v).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
      const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//LAPIS//Calendar//KO','CALSCALE:GREGORIAN'];
      for(const e of db.events){
        lines.push('BEGIN:VEVENT','UID:'+e.id+'@lapis.local','DTSTAMP:'+stamp(e.updatedAt));
        if(e.allDay)lines.push('DTSTART;VALUE=DATE:'+e.start.replace(/-/g,''),'DTEND;VALUE=DATE:'+addDays(e.end,1).replace(/-/g,''));
        else lines.push('DTSTART:'+stamp(e.start),'DTEND:'+stamp(e.end));
        lines.push('SUMMARY:'+esc(e.title));
        if(e.notes)lines.push('DESCRIPTION:'+esc(e.notes));
        if(e.location)lines.push('LOCATION:'+esc(e.location));
        lines.push('END:VEVENT');
      }
      lines.push('END:VCALENDAR');return lines.join('\r\n')+'\r\n';
    },
  };
}

// ── Google 캘린더 ──
// 연결 방법 두 가지:
//  · lapis(기본): 라피스 계정의 Google 연결을 서버가 대신 쓴다. 사용자는 버튼 한 번으로 동의만 하면 된다.
//  · own(고급): 사용자가 만든 OAuth 클라이언트(데스크톱 앱)로 이 PC 에서 직접 연결한다. 토큰은 DPAPI 보관소에만 둔다.
// 두 방식 모두 Google Calendar API v3 와 같은 경로 모양(/calendars/{id}/events…)으로 부른다.
const AUTH_URL='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL='https://oauth2.googleapis.com/token';
const API='https://www.googleapis.com/calendar/v3';
const SCOPE='https://www.googleapis.com/auth/calendar.events';
const b64url=buffer=>Buffer.from(buffer).toString('base64url');
const PRIMARY={id:'primary',name:'내 캘린더',primary:true,writable:true,color:'blue'};
const OTHER_COLORS=['violet','green','amber','rose','sky','gray'];
const keyOf=(calendarId,id)=>calendarId+'\n'+id;
const eventsPath=calendarId=>'/calendars/'+encodeURIComponent(calendarId)+'/events';

export function createGoogleCalendar({vault,store,cloud=null,fetchImpl=fetch,now=()=>Date.now()}){
  let pending=null;
  const read=async()=>(await vault.read()).gcal||{};
  const write=async patch=>{const current=await read();const next={...current,...patch};for(const k of Object.keys(next))if(next[k]===undefined)delete next[k];await vault.update({gcal:next});return next;};
  // 예전에 내 클라이언트로 연결해 둔 사용자는 그대로 own 으로 본다.
  const modeOf=cfg=>cfg.mode||(cfg.refreshToken?'own':'lapis');

  async function post(url,params){
    let response;
    try{response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params),signal:AbortSignal.timeout(20000)});}
    catch{throw new CalendarError(503,'Google 서버에 연결할 수 없습니다.');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new CalendarError(response.status===400||response.status===401?400:502,'Google 인증 오류: '+(data.error_description||data.error||response.status));
    return data;
  }
  async function accessToken(){
    const cfg=await read();
    if(!cfg.refreshToken)throw new CalendarError(401,'Google 캘린더가 연결되어 있지 않습니다.');
    if(cfg.accessToken&&cfg.expiresAt>now()+60000)return cfg.accessToken;
    const data=await post(TOKEN_URL,{client_id:cfg.clientId,client_secret:cfg.clientSecret,refresh_token:cfg.refreshToken,grant_type:'refresh_token'}).catch(async error=>{
      if(/invalid_grant/.test(error.message))await write({accessToken:undefined,refreshToken:undefined,expiresAt:undefined});
      throw error;
    });
    await write({accessToken:data.access_token,expiresAt:now()+(Number(data.expires_in)||3600)*1000});
    return data.access_token;
  }
  async function ownApi(method,path,{query,body}={}){
    const token=await accessToken();
    const search=query?'?'+new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined&&v!=='')):'';
    let response;
    try{response=await fetchImpl(API+path+search,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});}
    catch{throw new CalendarError(503,'Google 캘린더에 연결할 수 없습니다.');}
    if(response.status===204)return {};
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new CalendarError(response.status===404||response.status===410?response.status:502,'Google 캘린더 오류: '+(data.error?.message||response.status));
    return data;
  }
  async function lapisApi(method,path,options){
    if(!cloud)throw new CalendarError(503,'라피스 계정 기능을 쓸 수 없습니다.');
    try{return await cloud.calendarApi(method,path,options);}
    catch(error){throw new CalendarError(error.status||502,error.message);}
  }
  async function lapisState(){
    if(!cloud)return {signedIn:false};
    const state=await cloud.state().catch(()=>({signedIn:false}));
    if(!state.signedIn)return {signedIn:false};
    try{return {signedIn:true,...await lapisApi('GET','/status')};}
    catch(error){return {signedIn:true,connected:false,error:error.message};}
  }
  // 동기화할 캘린더: 기본 캘린더 + Google 화면에서 켜 둔 다른 캘린더(공유·구독 포함). 기본 캘린더는 항상 'primary' 로 부른다.
  async function lapisCalendars(){
    const {items=[]}=await lapisApi('GET','/users/me/calendarList');
    const list=[PRIMARY];let n=0;
    for(const item of items){
      if(item.primary||!item.selected)continue;
      list.push({id:item.id,name:item.summary||item.id,primary:false,writable:['owner','writer'].includes(item.accessRole),color:OTHER_COLORS[n++%OTHER_COLORS.length]});
    }
    const primary=items.find(i=>i.primary);if(primary)list[0]={...PRIMARY,name:primary.summary||PRIMARY.name};
    return list;
  }

  const toGoogle=event=>({
    summary:event.title,description:event.notes||undefined,location:event.location||undefined,
    start:event.allDay?{date:event.start}:{dateTime:event.start},
    end:event.allDay?{date:addDays(event.end,1)}:{dateTime:event.end},
  });
  const fromGoogle=remote=>{
    const allDay=Boolean(remote.start?.date);
    const start=allDay?remote.start.date:remote.start?.dateTime,end=allDay?addDays(remote.end?.date||remote.start.date,-1):remote.end?.dateTime||start;
    if(!start)return null;
    return {title:String(remote.summary||'(제목 없음)').slice(0,200),allDay,start:allDay?start:new Date(start).toISOString(),end:allDay?(end<start?start:end):new Date(end).toISOString(),notes:String(remote.description||'').slice(0,4000),location:String(remote.location||'').slice(0,300)};
  };

  return {
    async status(){
      const cfg=await read(),mode=modeOf(cfg),lastSync=(await store.state()).lastSync;
      const own={configured:Boolean(cfg.clientId&&cfg.clientSecret),clientId:cfg.clientId||null};
      if(mode==='own')return {mode,...own,connected:Boolean(cfg.refreshToken),writable:Boolean(cfg.refreshToken),lastSync};
      const remote=await lapisState(),enabled=cfg.lapisEnabled===true;
      return {mode,...own,signedIn:remote.signedIn,account:remote.account??null,linked:remote.connected===true,
        connected:enabled&&remote.connected===true,writable:remote.writable===true,reauthRequired:remote.reauthRequired===true,error:remote.error??null,lastSync};
    },
    // ── 라피스 계정으로 연결(기본) ──
    async beginLapis(){
      if(!cloud)throw new CalendarError(503,'라피스 계정 기능을 쓸 수 없습니다.');
      try{return await cloud.startGoogleCalendarConnect();}catch(error){throw new CalendarError(error.status||502,error.message);}
    },
    async pollLapis(attemptId){
      if(!cloud)throw new CalendarError(503,'라피스 계정 기능을 쓸 수 없습니다.');
      let result;
      try{result=await cloud.pollGoogleConnect(String(attemptId||''));}catch(error){throw new CalendarError(error.status||502,error.message);}
      if(result.status==='completed')await write({mode:'lapis',lapisEnabled:true});
      return {status:result.status};
    },
    // 이미 라피스 계정에 캘린더 권한이 있으면 동의 없이 이 PC 의 동기화만 켠다.
    async useLapis(){
      const remote=await lapisState();
      if(!remote.signedIn)throw new CalendarError(401,'라피스 계정에 로그인해 주세요.');
      if(remote.connected!==true)throw new CalendarError(409,'라피스 계정에 Google 캘린더가 연결되어 있지 않습니다.');
      await write({mode:'lapis',lapisEnabled:true});
      return this.status();
    },
    // ── 내 OAuth 클라이언트로 직접 연결(고급) ──
    async saveConfig({clientId,clientSecret}){
      const id=String(clientId||'').trim(),secret=String(clientSecret||'').trim();
      if(!/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(id))bad('클라이언트 ID 형식이 올바르지 않습니다. (…apps.googleusercontent.com)');
      if(secret.length<8||secret.length>200||/\s/.test(secret))bad('클라이언트 보안 비밀 형식이 올바르지 않습니다.');
      pending=null;
      await write({clientId:id,clientSecret:secret,accessToken:undefined,refreshToken:undefined,expiresAt:undefined});
      return this.status();
    },
    async beginAuth(redirectUri){
      const cfg=await read();
      if(!cfg.clientId||!cfg.clientSecret)bad('먼저 클라이언트 ID와 보안 비밀을 저장해 주세요.');
      const verifier=b64url(randomBytes(48)),state=b64url(randomBytes(18));
      pending={state,verifier,redirectUri,expiresAt:now()+10*60000};
      const url=new URL(AUTH_URL);
      for(const [k,v] of Object.entries({client_id:cfg.clientId,redirect_uri:redirectUri,response_type:'code',scope:SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:b64url(createHash('sha256').update(verifier).digest()),code_challenge_method:'S256'}))url.searchParams.set(k,v);
      return {url:url.href};
    },
    async completeAuth({state,code,error}){
      const attempt=pending;pending=null;
      if(!attempt||attempt.expiresAt<now()||state!==attempt.state)throw new CalendarError(400,'인증 요청이 만료되었거나 올바르지 않습니다. 대시보드에서 다시 연결해 주세요.');
      if(error)throw new CalendarError(400,'Google 연결이 취소되었습니다.');
      if(!code)throw new CalendarError(400,'Google 인증 코드가 없습니다.');
      const cfg=await read();
      const data=await post(TOKEN_URL,{client_id:cfg.clientId,client_secret:cfg.clientSecret,code,code_verifier:attempt.verifier,redirect_uri:attempt.redirectUri,grant_type:'authorization_code'});
      if(!data.refresh_token)throw new CalendarError(400,'Google 이 장기 연결 키를 주지 않았습니다. Google 계정의 앱 접근 권한에서 이 앱을 제거한 뒤 다시 연결해 주세요.');
      await write({mode:'own',accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:now()+(Number(data.expires_in)||3600)*1000});
      return this.status();
    },
    // own: 이 PC 의 키를 지우고 Google 권한도 거둔다.
    // lapis: 이 PC 의 동기화만 끈다. 계정의 Google 연결은 드라이브 등과 함께 쓰므로 그대로 둔다.
    async disconnect(){
      const cfg=await read();
      if(modeOf(cfg)==='own'){
        if(cfg.refreshToken)await fetchImpl('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:cfg.refreshToken}),signal:AbortSignal.timeout(10000)}).catch(()=>undefined);
        await write({mode:undefined,lapisEnabled:false,accessToken:undefined,refreshToken:undefined,expiresAt:undefined});
      }else await write({lapisEnabled:false});
      return this.status();
    },
    // 양방향 동기화. 같은 일정이 양쪽에서 바뀌었으면 나중에 바뀐 쪽을 따른다. 지우기는 연결된 일정만 서로 반영한다.
    // 새 일정은 기본 캘린더에 올린다. 읽기 전용 캘린더(구독·휴일 등)의 일정은 가져오기만 한다.
    async sync({days=[-30,180]}={}){
      const cfg=await read(),mode=modeOf(cfg);
      let call,calendars,canWrite=true;
      if(mode==='own'){
        if(!cfg.refreshToken)throw new CalendarError(401,'Google 캘린더가 연결되어 있지 않습니다.');
        call=ownApi;calendars=[PRIMARY];
      }else{
        if(!cfg.lapisEnabled)throw new CalendarError(401,'Google 캘린더가 연결되어 있지 않습니다.');
        const remote=await lapisApi('GET','/status');
        if(!remote.connected)throw new CalendarError(409,remote.reauthRequired?'Google 연결이 만료되었습니다. 캘린더 연결을 다시 해 주세요.':'라피스 계정에 Google 캘린더가 연결되어 있지 않습니다.');
        call=lapisApi;canWrite=remote.writable===true;calendars=remote.calendars?await lapisCalendars():[PRIMARY];
      }
      const today=new Date(now());today.setUTCHours(0,0,0,0);
      const timeMin=new Date(today.getTime()+days[0]*86400000).toISOString(),timeMax=new Date(today.getTime()+days[1]*86400000).toISOString();
      const result={pulled:0,updated:0,pushed:0,removed:0,errors:[],calendars:calendars.map(c=>c.name)};
      const remotes=[];
      for(const cal of calendars){
        try{
          let pageToken;
          for(let page=0;page<10;page++){
            const data=await call('GET',eventsPath(cal.id),{query:{timeMin,timeMax,singleEvents:'true',showDeleted:'true',maxResults:'250',pageToken}});
            for(const item of data.items||[])remotes.push({cal,item});
            pageToken=data.nextPageToken;if(!pageToken)break;
          }
        }catch(error){if(cal.primary)throw error;result.errors.push(cal.name+': '+error.message);}
      }
      await store.transaction(async db=>{
        const byKey=new Map(db.events.filter(e=>e.googleId).map(e=>[keyOf(e.googleCalendarId||'primary',e.googleId),e]));
        for(const {cal,item:remote} of remotes){
          const local=byKey.get(keyOf(cal.id,remote.id));
          if(remote.status==='cancelled'){
            if(local){db.events=db.events.filter(e=>e!==local);result.removed++;}continue;
          }
          const mapped=fromGoogle(remote);if(!mapped)continue;
          const remoteUpdated=remote.updated||new Date(now()).toISOString(),readOnly=!(canWrite&&cal.writable);
          if(!local){
            const stamp=new Date(now()).toISOString();
            db.events.push({id:randomUUID(),...mapped,color:cal.color,source:'google',googleId:remote.id,googleCalendarId:cal.id,calendarName:cal.name,readOnly,createdAt:stamp,updatedAt:stamp,syncedAt:stamp,remoteUpdated});result.pulled++;continue;
          }
          Object.assign(local,{googleCalendarId:cal.id,calendarName:cal.name,readOnly});
          const localDirty=Date.parse(local.updatedAt)>Date.parse(local.syncedAt||0);
          if(localDirty&&!readOnly&&Date.parse(local.updatedAt)>=Date.parse(remoteUpdated))continue; // 로컬이 더 최근: 아래에서 올린다
          if(remoteUpdated!==local.remoteUpdated){
            Object.assign(local,mapped,{remoteUpdated,syncedAt:new Date(now()).toISOString(),updatedAt:new Date(now()).toISOString()});result.updated++;
            local.syncedAt=local.updatedAt;
          }
        }
        for(const item of [...db.pendingDeletes]){
          const target=typeof item==='string'?{calendarId:'primary',id:item}:item; // 예전 형식: 기본 캘린더의 일정 ID 문자열
          if(!canWrite){result.errors.push('Google 캘린더 쓰기 권한이 없어 삭제를 반영하지 못했어요. 캘린더 연결을 다시 해 주세요.');break;}
          try{await call('DELETE',eventsPath(target.calendarId)+'/'+encodeURIComponent(target.id));db.pendingDeletes=db.pendingDeletes.filter(x=>x!==item);result.removed++;}
          catch(error){if([404,410].includes(error.status))db.pendingDeletes=db.pendingDeletes.filter(x=>x!==item);else result.errors.push(error.message);}
        }
        let waiting=0;
        for(const event of db.events){
          if(event.readOnly)continue;
          try{
            if(!event.googleId){
              if(!canWrite){waiting++;continue;}
              const created=await call('POST',eventsPath('primary'),{body:toGoogle(event)});
              Object.assign(event,{googleId:created.id,googleCalendarId:'primary',calendarName:calendars[0].name,remoteUpdated:created.updated||null,syncedAt:event.updatedAt});result.pushed++;
            }else if(Date.parse(event.updatedAt)>Date.parse(event.syncedAt||0)){
              if(!canWrite){waiting++;continue;}
              const patched=await call('PATCH',eventsPath(event.googleCalendarId||'primary')+'/'+encodeURIComponent(event.googleId),{body:toGoogle(event)});
              event.remoteUpdated=patched.updated||event.remoteUpdated;event.syncedAt=event.updatedAt;result.pushed++;
            }
          }catch(error){result.errors.push(event.title+': '+error.message);}
        }
        if(waiting)result.errors.push('Google 캘린더 쓰기 권한이 없어 '+waiting+'건을 올리지 못했어요. 캘린더 연결을 다시 해 주세요.');
        db.lastSync=new Date(now()).toISOString();
      });
      return result;
    },
  };
}
