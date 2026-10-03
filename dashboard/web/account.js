// 라피스 계정(클라우드) 로그인과 Google 서비스 연결. 로그인 토큰은 서버가 보관하고 이 화면에는 오지 않는다.
import {q,node,put,button,pill,link,emptyLine,api,cloud,toast,doing,errorText,fmtDate,confirmDialog,registerPage,safeHttps} from './ui.js';

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
async function waitForAuth({start,poll,status,onDone}){
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

function renderAccount(){
  const box=q('#account-box');box.replaceChildren();
  const card=node('div','card');
  if(!session.signedIn){
    const status=node('p','small muted');
    const go=button('Google로 로그인',async()=>{
      await doing(go,async()=>{
        const ok=await waitForAuth({start:()=>cloud('POST','/login/start',{}),poll:id=>cloud('POST','/login/poll',{attemptId:id}),status,
          onDone:async()=>{await refreshSession();toast('로그인했습니다.');}});
        if(ok)renderAll();
      });
    },'btn primary');
    put(card,put(node('div','card-head'),put(node('div'),node('h2','','라피스 계정'),node('p','sub','라피스 기억·학습·Google 드라이브·시트 기능을 쓰려면 로그인하세요. 에디터에서 쓰던 같은 계정입니다.')),pill('로그아웃 상태','warn')),
      put(node('div','row'),go),status,node('p','small muted','로그인 정보는 이 PC의 Windows 계정으로 암호화해 보관되며 화면이나 로그에 드러나지 않습니다.'));
  }else{
    const out=button('로그아웃',async()=>{
      if(!await confirmDialog({title:'로그아웃할까요?',body:'이 대시보드에서 라피스 계정 연결이 끊어집니다. 계정과 Google 연결 자체는 그대로 남습니다.',ok:'로그아웃',danger:true}))return;
      await doing(out,async()=>{await cloud('POST','/logout',{});await refreshSession();renderAll();toast('로그아웃했습니다.');});
    },'btn');
    put(card,put(node('div','card-head'),put(node('div'),node('h2','','라피스 계정'),node('p','sub',session.user.email)),pill('로그인됨','ok')),
      put(node('div','row'),put(node('div','avatar',(session.user.name||'나')[0]),),put(node('div'),node('b','',session.user.name),node('div','small muted',session.user.email)),node('span','spacer'),out));
  }
  box.append(card);
}

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
function renderAll(){renderAccount();renderGoogle();}

registerPage('account',{show(){refreshSession().then(renderAll);}});
refreshSession();
