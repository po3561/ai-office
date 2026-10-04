// 내 계정: 프로필(사진·닉네임·전화번호)·설정 동기화·Google 서비스 연결·로그아웃. 로그인은 입구(gate.js)에서 한다. 로그인 토큰은 서버가 보관하고 이 화면에는 오지 않는다.
import {q,node,put,button,pill,link,emptyLine,field,api,cloud,toast,doing,errorText,fmtDate,confirmDialog,registerPage,safeHttps} from './ui.js';
import {knownConnections,syncStatus} from './sync.js';

export let session={signedIn:false,user:null,loaded:false};
export async function refreshSession(){
  try{session={...(await api('/api/cloud/state')),loaded:true};}catch{session={signedIn:false,user:null,loaded:true};}
  document.dispatchEvent(new CustomEvent('cloud:state',{detail:session}));
  return session;
}
// 로그인이 필요한 화면 위쪽에 보여 주는 안내 카드
export function loginPrompt(text='이 기능은 라피스 계정으로 로그인한 뒤 쓸 수 있어요.'){
  const box=node('div','card');
  put(box,node('h2','','라피스 계정 로그인이 필요해요'),node('p','sub',text),put(node('div','row'),link('로그인하러 가기 →','#account','btn primary')));
  return box;
}

// 브라우저에서 인증을 마칠 때까지 기다린다(2.5초마다 확인, 최대 10분).
export async function waitForAuth({start,poll,status,onDone}){
  const first=await start();
  const authUrl=safeHttps(first.url);
  if(!authUrl)throw new Error('인증 주소가 올바르지 않습니다.');
  const popup=window.open(authUrl,'_blank','noopener');
  status.replaceChildren(node('span','','새 탭에서 Google 인증을 진행해 주세요. 끝나면 이 화면이 자동으로 바뀝니다.'),' ');
  if(!popup)status.append(link('인증 페이지 직접 열기 ↗',authUrl,'small'));
  const deadline=Date.now()+10*60000;let cancelled=false;
  status.append(button('취소',()=>{cancelled=true;},'btn sm ghost'));
  while(!cancelled&&Date.now()<deadline){
    await new Promise(r=>setTimeout(r,2500));
    const result=await poll(first.attemptId);
    if(result.status==='completed'){await onDone(result);return true;}
  }
  status.replaceChildren(node('span','',cancelled?'인증을 취소했습니다.':'인증 시간이 지났습니다. 다시 시도해 주세요.'));
  return false;
}

const SERVICES=[
  ['drive','Google Drive','파일 보기·검색','drive'],['sheets','Google Sheets','시트 읽기·쓰기','spreadsheets'],
  ['docs','Google Docs','문서 만들기·추가','documents'],['slides','Google Slides','슬라이드 추가','presentations'],
  ['calendar','Google Calendar','오늘 일정 읽기','calendar'],['gmail','Gmail','메일 읽기','gmail'],['youtube','YouTube','영상 추천','youtube'],
];
export const hasScope=(scopes,key)=>(scopes||[]).some(s=>String(s).toLowerCase().includes(key));

// ── 내 프로필: 사진 · 닉네임 · 전화번호 · 회원 정보 ──
const initialOf=name=>String(name||'나').trim().slice(0,1).toUpperCase()||'나';
let photoVersion=Date.now();
function avatarNode(cls,name){
  const box=node('div',cls,initialOf(name));
  const img=new Image();img.alt='';img.src='/api/cloud/avatar?v='+photoVersion;
  img.addEventListener('load',()=>{box.replaceChildren(img);});
  return box;
}
// 올릴 사진은 브라우저에서 먼저 512px 이하로 줄여 용량을 아낀다(서버는 PNG·JPG·WEBP 만 받는다).
async function shrink(file){
  if(!/^image\/(png|jpeg|webp)$/.test(file.type))throw new Error('PNG · JPG · WEBP 사진만 올릴 수 있어요.');
  if(file.size>20*1024*1024)throw new Error('사진 파일이 너무 커요.');
  const bitmap=await createImageBitmap(file).catch(()=>{throw new Error('사진을 읽지 못했어요. 다른 파일로 시도해 주세요.');});
  const scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',0.9));
  if(!blob)throw new Error('사진을 줄이지 못했어요.');
  return blob;
}
async function uploadPhoto(blob){
  const response=await fetch('/api/cloud/avatar',{method:'PUT',credentials:'same-origin',headers:{'content-type':blob.type||'application/octet-stream','x-lapis-request':'1'},body:blob});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'사진을 올리지 못했어요.');
}

async function renderProfile(){
  const box=q('#account-box');box.replaceChildren(emptyLine('내 정보를 불러오는 중…'));
  let me;
  try{me=await cloud('GET','/profile');}
  catch(error){box.replaceChildren(node('p','banner warn','내 정보를 읽지 못했어요: '+errorText(error)));return;}
  let revision=me.revision;
  const name=node('input');name.type='text';name.maxLength=80;name.value=me.profile.name||me.user.name;name.setAttribute('aria-label','닉네임');
  const phone=node('input');phone.type='tel';phone.maxLength=24;phone.value=me.profile.phone||'';phone.placeholder='010-0000-0000';phone.setAttribute('aria-label','전화번호');
  const ro=(value)=>{const i=node('input');i.type='text';i.value=value;i.readOnly=true;return i;};
  const file=node('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;
  const photo=avatarNode('avatar-big',name.value);
  const pick=button('사진 바꾸기',()=>file.click(),'btn sm');
  file.addEventListener('change',async()=>{
    const chosen=file.files[0];file.value='';if(!chosen)return;
    await doing(pick,async()=>{await uploadPhoto(await shrink(chosen));photoVersion=Date.now();toast('프로필 사진을 바꿨어요.');renderProfile();refreshSession();});
  });
  const remove=button('사진 지우기',async function(){
    if(!await confirmDialog({title:'프로필 사진을 지울까요?',body:'지워도 언제든 다시 올릴 수 있어요.',ok:'지우기',danger:true}))return;
    await doing(this,async()=>{await cloud('DELETE','/avatar');photoVersion=Date.now();toast('사진을 지웠어요.');renderProfile();refreshSession();});
  },'btn sm');
  const save=button('저장',async()=>{
    await doing(save,async()=>{
      const r=await cloud('PUT','/profile',{name:name.value,phone:phone.value,revision});
      revision=r.revision;toast('프로필을 저장했어요.');await refreshSession();
    });
  },'btn primary');
  const card=node('div','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','내 프로필'),node('p','sub','앱 곳곳에 보이는 이름과 사진이에요. 전화번호는 암호화해 저장돼요.')),pill('로그인됨','ok')),
    put(node('div','profile-top'),photo,put(node('div','stack'),put(node('div','row'),pick,remove),node('p','small muted','PNG · JPG · WEBP, 알아서 작게 줄여 올려요.')),file),
    put(node('div','formgrid-2'),field('닉네임',name),field('전화번호 (선택)',phone,me.profile.phoneNeedsReview?'저장된 번호의 형식을 확인해 주세요.':'한국 번호는 +82 형식으로 정리돼요.'),
      field('아이디',ro(me.user.username||'(Google 계정)')),field('이메일',ro(me.user.email),'아이디·이메일은 여기서 바꿀 수 없어요.')),
    put(node('div','row'),save));
  box.replaceChildren(card);
}

// ── 동기화·로그아웃 ──
function renderSync(){
  const box=q('#sync-box');box.replaceChildren();
  const line=node('span','small muted');
  const paint=s=>{line.textContent=(s.state==='syncing'?'동기화하는 중…':s.state==='error'?'⚠️ '+s.message:(s.message||'준비됐어요')+(s.at?' · 마지막 '+fmtDate(s.at):''));};
  const card=node('div','card');
  const now=button('지금 동기화',async function(){await doing(this,async()=>{const r=await window.__lapisSync?.reconcile({ask:true});if(r?.state==='error')throw new Error(r.message);});},'btn');
  const pull=button('클라우드에서 다시 가져오기',async function(){
    if(!await confirmDialog({title:'클라우드 내용으로 바꿀까요?',body:'이 계정으로 저장해 둔 설정·할 일·일정으로 이 PC의 내용을 바꿔요. 지금 내용은 한 칸 백업해 둬요.',ok:'가져오기'}))return;
    await doing(this,()=>window.__lapisSync?.pullNow());
  },'btn');
  const sync=node('div','sync-line');put(sync,now,pull,line);
  const known=knownConnections();
  const names={claude:'Claude',gpt:'GPT'};
  const list=known?Object.entries(known).filter(([,v])=>v).map(([k])=>names[k]||k):[];
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','설정·기록 동기화'),node('p','sub','화면 설정, 할 일, 일정, 메모가 계정에 저장돼요. 다른 PC에서 로그인해도 그대로 이어져요.'))),sync,
    node('p','small muted','Claude·GPT·Google 로그인 정보와 토큰은 보안을 위해 이 PC에만 보관돼요. 다른 PC에서는 한 번씩 다시 로그인해 주세요.'+(list.length?` 이 계정은 ${list.join('·')}를 연결해 쓰던 기록이 있어요.`:'')));
  box.append(card);paint(syncStatus());
  document.addEventListener('sync:state',e=>paint(e.detail));
}
function renderSession(){
  const box=q('#session-box');box.replaceChildren();
  const out=button('로그아웃',async()=>{
    if(!await confirmDialog({title:'로그아웃할까요?',body:'이 PC에서 라피스 계정이 로그아웃돼요. 설정과 기록은 계정에 그대로 남아 있어요.',ok:'로그아웃',danger:true}))return;
    await doing(out,async()=>{try{await window.__lapisSync?.reconcile({ask:false});}catch{ /* 올리지 못해도 로그아웃은 한다 */ }await cloud('POST','/logout',{});location.reload();});
  },'btn danger');
  box.append(put(node('div','card'),put(node('div','card-head'),put(node('div'),node('h2','','계정'),node('p','sub','로그인 정보는 이 PC의 Windows 계정으로 암호화해 보관되며 화면이나 로그에 드러나지 않아요.'))),put(node('div','row'),out)));
}

// 위쪽 막대의 내 이름표(사진 + 닉네임). 누르면 이 화면으로 와요.
function paintChip(){
  const slot=q('.top-right');if(!slot||!session.signedIn)return;
  let chip=q('#me-chip');
  if(!chip){chip=node('a','me-chip');chip.id='me-chip';chip.href='#account';chip.title='내 계정 · 프로필';slot.prepend(chip);}
  chip.replaceChildren(avatarNode('avatar-mini',session.user.name),node('span','',session.user.name||'내 계정'));
}
document.addEventListener('cloud:state',paintChip);

async function renderGoogle(){
  const box=q('#google-box');box.replaceChildren();
  if(!session.signedIn){box.append(node('p','empty-line','로그인하면 Google 서비스 연결을 설정할 수 있어요.'));return;}
  box.append(emptyLine('Google 연결 상태를 확인하고 있습니다…'));
  let data;
  try{data=await cloud('GET','/integrations/google-drive/status');}
  catch(error){box.replaceChildren(node('p','banner warn','연결 상태를 읽지 못했습니다: '+errorText(error)));return;}
  box.replaceChildren();
  const connected=data.connected===true,scopes=data.connection?.scopes||[];
  const card=node('div','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','Google 연결'),node('p','sub',connected?(data.connection?.account_label||'연결됨'):'서비스를 고르고 Google 계정을 연결하세요. 연결 후에도 파일을 바꾸는 작업은 항상 미리보기와 승인을 거칩니다.')),pill(connected?'연결됨':'연결 안 됨',connected?'ok':'')));
  if(data.configured===false)card.append(node('p','banner warn','서버에 Google 앱 설정이 아직 없습니다. 누락: '+((data.configuration?.missing||[]).join(', ')||'알 수 없음')));
  const picks=new Map();const list=node('div','chips');
  for(const [id,name,desc,key] of SERVICES){
    const on=hasScope(scopes,key);
    const label=node('label','chip'+(on?' on':''));
    const cb=node('input');cb.type='checkbox';cb.checked=on||id==='drive';cb.style.display='none';picks.set(id,cb);
    cb.addEventListener('change',()=>label.classList.toggle('on',cb.checked));
    put(label,cb,put(node('span'),node('b','',name+(on?' ✓':'')),node('span','',desc)));
    label.addEventListener('click',e=>{if(e.target!==cb){e.preventDefault();cb.checked=!cb.checked;cb.dispatchEvent(new Event('change'));}});
    list.append(label);
  }
  const tier=node('select');for(const [v,t] of [['standard','표준 — 필요한 파일만(권장)'],['advanced','고급 — 드라이브 전체']]){const o=node('option','',t);o.value=v;tier.append(o);}
  const status=node('p','small muted');
  const connect=button(connected?'권한 다시 연결':'Google 계정 연결',async()=>{
    const services=[...picks].filter(([,cb])=>cb.checked).map(([id])=>id);
    if(!services.length){toast('연결할 서비스를 하나 이상 고르세요.',true);return;}
    await doing(connect,async()=>{
      const ok=await waitForAuth({start:()=>cloud('POST','/google/connect',{services,tier:tier.value}),poll:id=>cloud('POST','/google/connect/poll',{attemptId:id}),status,onDone:async()=>toast('Google 연결을 마쳤습니다.')});
      if(ok)renderGoogle();
    });
  },'btn primary');
  put(card,node('div','group-title','연결할 서비스'),list,put(node('div','row'),node('label','small muted','권한 범위'),tier),put(node('div','row'),connect,
    button('연결 상태 점검',async function(){await doing(this,async()=>{const v=await cloud('GET','/integrations/google-drive/status?verify=true');const lines=Object.entries(v.verification?.services||{}).map(([k,s])=>k+': '+(s.operational?'정상':s.authorized?'권한 있음·확인 필요':'미연결'));toast(lines.join(' · ')||'점검 결과가 없습니다.');});},'btn'),
    connected?button('연결 해제',async()=>{if(await confirmDialog({title:'Google 연결을 해제할까요?',body:'라피스가 저장해 둔 Google 접근 권한을 거둡니다. 이미 만든 파일은 그대로 남습니다.',ok:'해제',danger:true})){await doing(null,async()=>{await cloud('POST','/integrations/google-drive/disconnect',{});toast('연결을 해제했습니다.');renderGoogle();});}},'btn danger'):null),status);
  if(connected&&data.connection?.connected_at)card.append(node('p','small muted','연결 시각 '+fmtDate(data.connection.connected_at)));
  box.append(card);
}
function renderAll(){renderProfile();renderSync();renderGoogle();renderSession();}

registerPage('account',{show(){refreshSession().then(renderAll);}});
refreshSession();
