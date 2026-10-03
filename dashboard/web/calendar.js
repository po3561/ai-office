// 라피스 캘린더: 월·주·목록 보기, 일정 만들기·고치기·지우기, Google 캘린더와 양방향 동기화(내 OAuth 클라이언트로 직접 연결).
import {q,qa,node,put,button,pill,link,emptyLine,friendly,api,cloud,toast,doing,errorText,fmtDate,dayKey,openDialog,closeDialog,confirmDialog,field,input,textarea,registerPage,safeHttps} from './ui.js';
import {session,refreshSession} from './account.js';

const COLORS=[['sky','하늘'],['blue','파랑'],['violet','보라'],['green','초록'],['amber','노랑'],['rose','분홍'],['gray','회색']];
const DOW=['일','월','화','수','목','금','토'];
let view='month',cursor=new Date(),selected=dayKey(new Date()),events=[],google={configured:false,connected:false,lastSync:null},syncing=false;
cursor.setHours(0,0,0,0);

const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const fromKey=k=>new Date(k+'T00:00:00');
const timeText=iso=>new Intl.DateTimeFormat('ko-KR',{hour:'numeric',minute:'2-digit',hour12:false}).format(new Date(iso));
const eventDays=e=>e.allDay?[e.start,e.end]:[dayKey(new Date(e.start)),dayKey(new Date(Math.max(Date.parse(e.end)-1,Date.parse(e.start))))];
const onDay=(e,key)=>{const [a,b]=eventDays(e);return a<=key&&key<=b;};

function range(){
  if(view==='month'){const first=new Date(cursor.getFullYear(),cursor.getMonth(),1);const start=addDays(first,-first.getDay());return {start,days:42};}
  if(view==='week'){return {start:addDays(cursor,-cursor.getDay()),days:7};}
  return {start:new Date(new Date().setHours(0,0,0,0)),days:60};
}
function title(){
  if(view==='month')return cursor.getFullYear()+'년 '+(cursor.getMonth()+1)+'월';
  const {start,days}=range();const end=addDays(start,days-1);
  return view==='week'?(start.getMonth()+1)+'월 '+start.getDate()+'일 – '+(end.getMonth()+1)+'월 '+end.getDate()+'일':'다가오는 일정 60일';
}
async function load(){
  const {start,days}=range();
  try{events=(await api('/api/calendar/events?from='+dayKey(start)+'&to='+dayKey(addDays(start,days)))).events;}
  catch(error){q('#cal-body').replaceChildren(node('p','banner warn',errorText(error)));return;}
  paint();
}
function chip(e,compact=true){
  const c=node('button','ev c-'+e.color+(e.source==='google'?' g':''));c.type='button';
  c.textContent=(e.allDay||!compact?'':timeText(e.start)+' ')+e.title;c.title=e.title+(e.location?' · '+e.location:'');
  c.addEventListener('click',ev=>{ev.stopPropagation();eventDialog(e);});return c;
}
function paint(){
  q('#cal-title').textContent=title();
  qa('[data-cal-view]').forEach(b=>b.classList.toggle('on',b.dataset.calView===view));
  const body=q('#cal-body');body.replaceChildren();
  if(view==='month')paintMonth(body);else if(view==='week')paintWeek(body);else paintList(body);
  paintSide();paintGoogleBadge();renderHomeToday();
}
function paintMonth(body){
  const {start}=range(),today=dayKey(new Date());
  const grid=node('div','cal-grid');
  DOW.forEach((d,i)=>grid.append(node('div','cal-dow'+(i===0?' sun':i===6?' sat':''),d)));
  for(let i=0;i<42;i++){
    const day=addDays(start,i),key=dayKey(day);
    const cell=node('div','cal-cell'+(day.getMonth()!==cursor.getMonth()?' other':'')+(key===today?' today':'')+(key===selected?' sel':''));
    cell.append(node('span','cal-num',day.getDate()));
    const list=events.filter(e=>onDay(e,key));
    list.slice(0,3).forEach(e=>cell.append(chip(e)));
    if(list.length>3){const more=node('button','ev-more','+'+(list.length-3)+'개 더');more.type='button';more.addEventListener('click',ev=>{ev.stopPropagation();selected=key;paint();});cell.append(more);}
    cell.addEventListener('click',()=>{selected=key;paint();});
    cell.addEventListener('dblclick',()=>eventDialog(null,key));
    grid.append(cell);
  }
  body.append(grid);
}
function paintWeek(body){
  const {start}=range(),today=dayKey(new Date());const cols=node('div','week-grid');
  for(let i=0;i<7;i++){
    const day=addDays(start,i),key=dayKey(day);
    const col=node('div','week-col'+(key===today?' today':'')+(key===selected?' sel':''));
    col.append(put(node('div','week-head'),node('b','',DOW[i]),node('span','',day.getDate())));
    const list=events.filter(e=>onDay(e,key));
    list.forEach(e=>col.append(chip(e,false)));
    if(!list.length)col.append(node('p','small muted','일정 없음'));
    col.append(button('＋',()=>eventDialog(null,key),'btn sm ghost add'));
    col.addEventListener('click',()=>{selected=key;paintSide();});
    cols.append(col);
  }
  body.append(cols);
}
function paintList(body){
  const {start,days}=range();let any=false;
  for(let i=0;i<days;i++){
    const day=addDays(start,i),key=dayKey(day),list=events.filter(e=>onDay(e,key));
    if(!list.length)continue;any=true;
    const group=node('div','agenda-day');
    group.append(node('div','agenda-date',(day.getMonth()+1)+'월 '+day.getDate()+'일 ('+DOW[day.getDay()]+')'+(i===0?' · 오늘':'')));
    list.forEach(e=>group.append(agendaRow(e)));body.append(group);
  }
  if(!any)body.append(friendly('다가오는 일정이 없어요','「＋ 일정」으로 첫 일정을 만들어 보세요.'));
}
function agendaRow(e){
  const row=node('button','agenda-row');row.type='button';
  put(row,node('i','dot-c c-'+e.color),node('span','agenda-time',e.allDay?'종일':timeText(e.start)+(e.end!==e.start?' – '+timeText(e.end):'')),put(node('span','agenda-main'),node('b','',e.title),e.location?node('small','muted',e.location):null),e.source==='google'?pill('Google','accent'):null);
  row.addEventListener('click',()=>eventDialog(e));return row;
}
function paintSide(){
  const side=q('#cal-side');side.replaceChildren();
  const day=fromKey(selected);
  put(side,put(node('div','card-head'),put(node('div'),node('h2','',(day.getMonth()+1)+'월 '+day.getDate()+'일 ('+DOW[day.getDay()]+')'),node('p','sub',dayKey(new Date())===selected?'오늘':'선택한 날')),button('＋ 일정',()=>eventDialog(null,selected),'btn sm primary')));
  const list=events.filter(e=>onDay(e,selected));
  if(!list.length)side.append(node('p','small muted','이 날은 일정이 없어요. 날짜를 두 번 누르면 바로 만들 수 있어요.'));
  list.forEach(e=>side.append(agendaRow(e)));
}
function paintGoogleBadge(){
  const badge=q('#cal-google-state');
  badge.textContent=google.connected?'Google 연결됨'+(google.lastSync?' · '+fmtDate(google.lastSync,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' 동기화':''):'Google 미연결';
  badge.className='pill '+(google.connected?'ok':'');
  q('#cal-sync').hidden=!google.connected;
}

// ── 일정 대화상자 ──
function toLocalParts(iso){const d=new Date(iso);return {date:dayKey(d),time:String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')};}
function eventDialog(event,day){
  const isNew=!event;
  const base=event||{title:'',allDay:false,start:'',end:'',notes:'',location:'',color:'sky'};
  openDialog((box,close)=>{
    const title=input({maxLength:200,value:base.title,placeholder:'일정 제목',required:true});
    const all=node('input');all.type='checkbox';all.checked=isNew?false:base.allDay;
    let sd,st,ed,et;
    if(isNew){sd=day||selected;ed=sd;st='09:00';et='10:00';}
    else if(base.allDay){sd=base.start;ed=base.end;st='09:00';et='10:00';}
    else{const a=toLocalParts(base.start),b=toLocalParts(base.end);sd=a.date;st=a.time;ed=b.date;et=b.time;}
    const mk=(type,value)=>{const i=node('input');i.type=type;i.value=value;return i;};
    const startDate=mk('date',sd),startTime=mk('time',st),endDate=mk('date',ed),endTime=mk('time',et);
    const location=input({maxLength:300,value:base.location||'',placeholder:'장소 (선택)'}),notes=textarea({rows:3,maxLength:4000,value:base.notes||'',placeholder:'메모 (선택)'});
    let color=base.color||'sky';const swatches=node('div','swatches');
    for(const [id,name] of COLORS){const s=button('',()=>{color=id;qa('.swatch',swatches).forEach(x=>x.classList.toggle('on',x===s));},'swatch c-'+id+(id===color?' on':''));s.title=name;s.setAttribute('aria-label',name);swatches.append(s);}
    const timeRow=()=>{startTime.hidden=endTime.hidden=all.checked;};
    all.addEventListener('change',timeRow);timeRow();
    startDate.addEventListener('change',()=>{if(endDate.value<startDate.value)endDate.value=startDate.value;});
    const save=button(isNew?'만들기':'저장',null,'btn primary');
    save.addEventListener('click',()=>doing(save,async()=>{
      const payload={title:title.value,allDay:all.checked,location:location.value,notes:notes.value,color};
      if(all.checked){payload.start=startDate.value;payload.end=endDate.value||startDate.value;}
      else{payload.start=new Date(startDate.value+'T'+(startTime.value||'00:00')).toISOString();payload.end=new Date((endDate.value||startDate.value)+'T'+(endTime.value||startTime.value||'00:00')).toISOString();}
      if(isNew)await api('/api/calendar/events',{method:'POST',body:payload});else await api('/api/calendar/events/'+event.id,{method:'PATCH',body:payload});
      close();toast(isNew?'일정을 만들었어요.':'일정을 저장했어요.');await load();
    }));
    const del=isNew?null:button('삭제',async()=>{
      if(!await confirmDialog({title:'일정을 지울까요?',body:'「'+event.title+'」을(를) 지웁니다.'+(event.googleId?' Google 캘린더에서도 다음 동기화 때 지워져요.':''),ok:'지우기',danger:true}))return;
      await doing(null,async()=>{await api('/api/calendar/events/'+event.id,{method:'DELETE'});toast('일정을 지웠어요.');await load();});
    },'btn danger');
    put(box,put(node('div','dlg-head'),node('h2','',isNew?'새 일정':'일정 고치기'),!isNew&&event.source==='google'?node('p','','Google 캘린더에서 가져온 일정이에요. 고치면 다음 동기화 때 Google에도 반영돼요.'):null),
      put(node('div','dlg-body'),put(node('div','stack'),field('제목',title),(()=>{const l=node('label','row small');put(l,all,'종일');return l;})(),
        put(node('div','formgrid'),field('시작',put(node('div','row nowrap'),startDate,startTime)),field('끝',put(node('div','row nowrap'),endDate,endTime))),
        field('장소',location),field('메모',notes),field('색상',swatches))),
      put(node('div','dlg-foot'),del,node('span','spacer'),button('취소',close),save));
    title.focus();
  });
}

// ── Google 연동 ──
async function loadGoogle(){try{google=await api('/api/calendar/google');}catch{}paintGoogleBadge();}
async function syncNow(btn){
  if(syncing)return;syncing=true;
  await doing(btn,async()=>{
    const r=await api('/api/calendar/google/sync',{method:'POST',body:{}});
    toast('동기화했어요 · 가져옴 '+r.pulled+' · 올림 '+r.pushed+' · 갱신 '+r.updated+' · 삭제 '+r.removed+(r.errors.length?' · 문제 '+r.errors.length+'건':''),r.errors.length>0);
    await loadGoogle();await load();
  });
  syncing=false;
}
function googleDialog(){
  openDialog((box,close)=>{
    const id=input({placeholder:'1234567890-abc….apps.googleusercontent.com',value:google.clientId||'',autocomplete:'off'});
    const secret=node('input');secret.type='password';secret.placeholder=google.configured?'저장되어 있음 (바꿀 때만 입력)':'GOCSPX-…';secret.autocomplete='off';
    const save=button('저장',null,'btn');
    save.addEventListener('click',()=>doing(save,async()=>{google=await api('/api/calendar/google/config',{method:'POST',body:{clientId:id.value,clientSecret:secret.value}});secret.value='';toast('저장했습니다. 이제 Google 계정을 연결하세요.');close();googleDialog();}));
    const connect=button(google.connected?'다시 연결':'Google 계정 연결',null,'btn primary');connect.disabled=!google.configured;
    connect.addEventListener('click',()=>doing(connect,async()=>{
      const {url}=await api('/api/calendar/google/connect',{method:'POST',body:{}});
      const safe=safeHttps(url);if(!safe)throw new Error('인증 주소가 올바르지 않습니다.');
      window.open(safe,'_blank','noopener');toast('새 탭에서 Google 인증을 마치면 이 화면이 연결됨으로 바뀝니다.');
      for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,2500));await loadGoogle();if(google.connected){close();toast('Google 캘린더가 연결되었어요. 「지금 동기화」를 눌러 주세요.');return;}}
    }));
    const steps=node('ol','guide');
    for(const t of ['Google Cloud 콘솔(console.cloud.google.com)에서 프로젝트를 만들고, 「API 및 서비스」에서 Google Calendar API를 사용 설정합니다.','「OAuth 동의 화면」을 만들고(외부, 테스트 모드) 내 Google 계정을 테스트 사용자로 추가합니다.','「사용자 인증 정보 → OAuth 클라이언트 ID 만들기」에서 애플리케이션 유형을 데스크톱 앱으로 고릅니다.','만들어진 클라이언트 ID와 보안 비밀을 아래에 붙여 넣고 저장한 뒤, 「Google 계정 연결」을 누릅니다.'])steps.append(node('li','',t));
    const disconnect=google.connected?button('연결 해제',async()=>{if(await confirmDialog({title:'Google 캘린더 연결을 해제할까요?',body:'이 PC에 저장된 접근 키를 지우고 Google의 접근 권한도 거둡니다. 이미 가져온 일정은 그대로 남아요.',ok:'해제',danger:true})){await doing(null,async()=>{google=await api('/api/calendar/google/disconnect',{method:'POST',body:{}});toast('연결을 해제했습니다.');paintGoogleBadge();close();});}},'btn danger'):null;
    put(box,put(node('div','dlg-head'),node('h2','','Google 캘린더 연동'),node('p','','내 Google Cloud 프로젝트의 키로 이 PC에서 직접 연결합니다. 키와 접근 토큰은 이 PC의 Windows 계정으로 암호화되어 저장돼요.')),
      put(node('div','dlg-body'),put(node('div','stack'),put(node('div','row'),pill(google.configured?'키 저장됨':'키 필요',google.configured?'ok':'warn'),pill(google.connected?'계정 연결됨':'계정 미연결',google.connected?'ok':'')),
        node('div','group-title','처음 한 번만 준비해요'),steps,field('클라이언트 ID',id),field('클라이언트 보안 비밀',secret,'GOCSPX- 로 시작하는 값'),put(node('div','row'),save,connect,disconnect),
        node('p','small muted','같은 일정이 양쪽에서 바뀌면 나중에 바뀐 쪽을 따라요. 반복 일정은 개별 일정으로 가져옵니다.'))),
      put(node('div','dlg-foot'),button('닫기',close,'btn primary')));
  },{wide:true});
}

// ── 라피스 계정의 오늘 일정(읽기 전용) ──
async function loadCloudToday(btn){
  const out=q('#cal-cloud');out.replaceChildren(emptyLine('불러오는 중…'));
  await doing(btn,async()=>{
    const now=new Date();
    const data=await cloud('POST','/everyday/today',{date:dayKey(now),time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone});
    out.replaceChildren();
    const tasks=(data.tasks||[]).filter(t=>t.source==='calendar');
    if(!tasks.length)out.append(node('p','small muted',(data.sources?.calendar?'오늘 Google 캘린더 일정이 없어요.':'라피스 계정에 Google 캘린더가 연결되어 있지 않아요. (계정·Google 화면에서 연결)')));
    tasks.forEach(t=>{const row=node('div','agenda-row static');put(row,node('i','dot-c c-blue'),node('span','agenda-time',t.start_at?timeText(t.start_at):'종일'),put(node('span','agenda-main'),node('b','',t.title),t.detail?node('small','muted',t.detail):null));out.append(row);});
    (data.notices||[]).forEach(n=>out.append(node('p','small muted',n)));
  });
}

// ── 홈의 오늘 일정 ──
function renderHomeToday(){
  const box=q('#home-events');if(!box)return;
  box.replaceChildren();
  const today=dayKey(new Date());
  api('/api/calendar/events?from='+today+'&to='+dayKey(addDays(new Date(),1))).then(({events:list})=>{
    box.replaceChildren();
    if(!list.length){box.append(friendly('오늘은 일정이 없어요','일정을 추가하면 여기에 모여요.',link('캘린더 열기 →','#calendar','small')));return;}
    list.forEach(e=>box.append(agendaRow(e)));
  }).catch(()=>box.append(emptyLine('일정을 불러오지 못했습니다.')));
}

function shift(n){
  if(view==='month')cursor=new Date(cursor.getFullYear(),cursor.getMonth()+n,1);
  else cursor=addDays(cursor,n*(view==='week'?7:30));
  load();
}
q('#cal-prev').addEventListener('click',()=>shift(-1));
q('#cal-next').addEventListener('click',()=>shift(1));
q('#cal-today').addEventListener('click',()=>{cursor=new Date();cursor.setHours(0,0,0,0);selected=dayKey(cursor);load();});
q('#cal-add').addEventListener('click',()=>eventDialog(null,selected));
q('#cal-google').addEventListener('click',googleDialog);
q('#cal-sync').addEventListener('click',function(){syncNow(this);});
q('#cal-views').addEventListener('click',e=>{const b=e.target.closest('[data-cal-view]');if(!b)return;view=b.dataset.calView;if(view!=='list'&&view!=='month')cursor=fromKey(selected);load();});
q('#cal-cloud-load').addEventListener('click',function(){loadCloudToday(this);});

registerPage('calendar',{async show(){
  await loadGoogle();await load();
  if(google.connected&&(!google.lastSync||Date.now()-Date.parse(google.lastSync)>10*60000))syncNow(null);
  if(!session.loaded)refreshSession();
}});
registerPage('home',{show(){renderHomeToday();}});
