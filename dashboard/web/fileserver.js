// 파일 서버: 이 PC 의 고른 폴더를 라피스 계정·초대 코드로 읽기 전용 공유(내 서버 운영)하고, 초대받은 서버의 파일을 받는다(참여 서버).
// 파일은 클라우드에 보관하지 않고 중계만 한다. 서버 PC 가 켜져 있고 서버가 온라인일 때만 받을 수 있다.
import {q,qa,node,put,button,pill,emptyLine,friendly,api,toast,doing,errorText,fmtDate,fmtBytes,confirmDialog,registerPage} from './ui.js';
import {session,refreshSession,loginPrompt} from './account.js';

const ROOT='/api/file-server';
const enc=encodeURIComponent;
const ACTIONS={server_created:'서버 만들기',server_updated:'서버 설정 변경',invitation_created:'초대 코드 발급',invitation_redeemed:'서버 참여',member_updated:'멤버 권한 변경',host_token_rotated:'보안 연결 재발급',list:'폴더 열기',download:'다운로드',download_started:'다운로드 시작',download_completed:'중계 전송 완료',download_interrupted:'다운로드 중단'};
const REASONS={allowed:'허용',denied:'거부',complete:'완료',revoked:'권한 회수',paused:'서버 중지',disconnected:'연결 끊김',cancelled:'취소',not_found:'파일 없음',forbidden:'접근 제한',io_error:'파일 읽기 오류',timeout:'시간 초과',size_limit:'크기 제한',rate_limit:'요청 제한',host:'PC 기록',control:'서버 설정 기록'};
const RELAY={connected:['온라인','ok'],connecting:['연결 중','warn'],reconnecting:['다시 연결 중','warn'],disconnected:['연결 끊김','warn'],error:['연결 오류','bad'],stopped:['중지됨','']};
const mask=id=>typeof id==='string'&&id.length>8?id.slice(0,4)+'…'+id.slice(-4):'알 수 없는 사용자';
const fmtCode=c=>c.replace(/(\d{4})(?=\d)/g,'$1-');
const ago=v=>{if(!v)return '기록 없음';const s=Math.round((Date.now()-Date.parse(v))/1000);if(!Number.isFinite(s))return '기록 없음';if(s<60)return s+'초 전';if(s<3600)return Math.floor(s/60)+'분 전';if(s<86400)return Math.floor(s/3600)+'시간 전';return fmtDate(v);};
const duration=v=>{if(!v)return '—';const s=Math.max(0,Math.round((Date.now()-Date.parse(v))/1000));const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'시간 '+m+'분':m?m+'분':s+'초';};

let tab='own',ownSection='members',pollTimer=null,ownState=null;
let selectedServer=null,browse={shareId:null,path:''},auditPages=[],auditCursor=null;
const body=()=>q('#fs-body');
const visible=()=>!q('#view-fileserver').hidden;

function setTab(next){tab=next;qa('[data-fs-tab]').forEach(b=>b.classList.toggle('on',b.dataset.fsTab===next));render();}
async function render(){
  clearTimeout(pollTimer);
  const box=body();box.replaceChildren(emptyLine('불러오는 중…'));
  try{
    if(!session.loaded)await refreshSession();
    if(!session.signedIn){box.replaceChildren(loginPrompt('파일 서버를 쓰려면 라피스 계정으로 로그인하세요.'));return;}
    if(tab==='own')await renderOwn(box);else await renderJoined(box);
  }catch(error){box.replaceChildren(node('p','banner warn',errorText(error)));}
}

// ── 내 서버 운영 ──
async function renderOwn(box){
  let state;
  try{state=await api(ROOT+'/state');}
  catch(error){
    if(error.status===403){box.replaceChildren(friendly('다른 계정이 만든 서버예요',errorText(error)));return;}
    throw error;
  }
  ownState=state;box.replaceChildren();
  box.append(node('p','banner info','내 PC에서 고른 폴더를 초대한 라피스 계정에게 읽기 전용으로 공유해요. 파일은 클라우드에 저장되지 않고 이 PC에서 바로 중계돼요. 받는 쪽은 이 PC가 켜져 있고 서버가 온라인일 때만 받을 수 있어요.'));
  if(!state.configured){box.append(configureCard(state,false));return;}
  box.append(statusCard(state),opsStats(state),sharesCard(state));
  const tabs=node('div','tabs fs-sub');
  for(const [id,label] of [['members','초대 · 멤버'],['audit','활동 기록'],['local','PC 기록'],['files','파일 보기']]){
    const b=button(label,()=>{ownSection=id;qa('button',tabs).forEach(x=>x.classList.toggle('on',x===b));renderOwnSection(section,state);},ownSection===id?'on':'');tabs.append(b);
  }
  const section=node('div','stack');box.append(tabs,section);
  renderOwnSection(section,state);
  schedulePoll(state);
}
function schedulePoll(state){
  clearTimeout(pollTimer);
  const busy=['connecting','reconnecting'].includes(state.relay?.state);
  pollTimer=setTimeout(async()=>{
    if(!visible()||tab!=='own')return;
    try{const next=await api(ROOT+'/state');ownState=next;paintStatus(next);schedulePoll(next);}catch{schedulePoll(state);}
  },busy?3000:10000);
}
function relayPill(state){
  const [label,cls]=state.desiredRunning||state.relay?.state==='error'?(RELAY[state.relay?.state]||['확인 중','']):RELAY.stopped;
  const p=pill(label,cls);p.dataset.fs='relay';return p;
}
function statusCard(state){
  const card=node('section','card');card.dataset.fs='status';
  const actions=node('div','row wrap');
  put(actions,
    button('↻ 새로고침',()=>render(),'btn sm'),
    button('연결 점검',function(){selfCheck(this);},'btn sm'),
    button('공유 폴더 변경',()=>{if(state.desiredRunning)return toast('먼저 서버를 중지해 주세요.',true);body().replaceChildren(configureCard(state,true));},'btn sm'),
    state.desiredRunning?button('서버 중지',function(){stopServer(this);},'btn sm danger'):button('▶ 서버 시작',function(){startServer(this);},'btn sm primary'));
  const auto=node('input');auto.type='checkbox';auto.checked=state.autoStart;
  auto.addEventListener('change',()=>doing(null,async()=>{
    try{const next=await api(ROOT+'/settings',{method:'PUT',body:{autoStart:auto.checked}});toast(next.autoStart?'대시보드가 켜지면 서버를 자동으로 시작해요.':'자동 시작을 껐어요.');}
    catch(e){auto.checked=!auto.checked;throw e;}
  }));
  const autoLabel=put(node('label','row small fs-check'),auto,'PC·대시보드가 켜지면 서버 자동 시작 (이 계정으로 로그인돼 있을 때)');
  put(card,
    put(node('div','card-head'),put(node('div'),put(node('h2','fs-title'),state.name+' ',relayPill(state)),node('p','sub','서버 ID '+mask(state.serverId)+' · 마지막 설정 '+fmtDate(state.updatedAt))),actions),
    statusNote(state),autoLabel,node('div','fs-check-result'));
  return card;
}
function statusNote(state){
  const r=state.relay||{},n=node('div');n.dataset.fs='note';
  if(r.state==='reconnecting')put(n,node('p','banner warn',(r.error||'연결이 끊겼어요.')+(state.ops?.nextRetryAt?' · '+fmtDate(state.ops.nextRetryAt,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+'에 '+state.ops.reconnectAttempt+'번째 다시 연결을 시도해요.':'')));
  else if(r.state==='connecting')n.append(node('p','banner warn','클라우드 중계에 연결하는 중이에요. 온라인이 되면 초대받은 사람이 파일을 받을 수 있어요.'));
  else if(r.error)n.append(node('p','banner bad',r.error));
  else if(!state.desiredRunning)n.append(node('p','small muted','서버가 중지돼 있어요. 「서버 시작」을 누르면 공유가 열려요.'));
  return n;
}
function opsStats(state){
  const o=state.ops||{},grid=node('div','stats fs-stats');grid.dataset.fs='stats';
  const tile=(value,label)=>put(node('div','stat'),node('b','',value),node('span','',label));
  put(grid,
    tile(state.desiredRunning&&o.connectedAt?duration(o.connectedAt):'—','연결 유지 시간'),
    tile(String(o.activeTransfers??0)+' / 8','진행 중 전송'),
    tile(String(o.completed??0),'완료한 다운로드'),
    tile(String(o.interrupted??0),'중단된 다운로드'),
    tile(fmtBytes(o.bytesSent||0)||'0 B','보낸 용량 (이번 실행)'),
    tile(o.lastHeartbeatAt?ago(o.lastHeartbeatAt):'—','마지막 연결 신호'));
  return grid;
}
// 주기적으로 상태만 다시 그린다(입력 중인 초대·기록 화면은 그대로 둔다).
function paintStatus(state){
  const card=q('[data-fs="status"]');if(!card)return;
  q('[data-fs="relay"]',card)?.replaceWith(relayPill(state));
  q('[data-fs="note"]',card)?.replaceWith(statusNote(state));
  q('[data-fs="stats"]')?.replaceWith(opsStats(state));
  // 자동 재연결 포기·클라우드 중지처럼 시작/중지 버튼 모양이 바뀌면 전체를 다시 그린다.
  const runningButton=qa('button',card).find(b=>/서버 (시작|중지)/.test(b.textContent));
  if(runningButton&&runningButton.textContent.includes('중지')!==state.desiredRunning)render();
}
function sharesCard(state){
  const card=node('section','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','공유 폴더 '+state.shares.length+'개'),node('p','sub','읽기 전용 · 파일 올리기는 지원하지 않아요. 바꾸려면 서버를 중지하고 폴더를 다시 검사해요.'))));
  for(const s of state.shares)card.append(put(node('div','fs-share'),node('span','fs-icon','📁'),put(node('span'),node('b','',s.name),node('small','muted',s.path))));
  return card;
}
async function startServer(btn){
  await doing(btn,async()=>{await api(ROOT+'/start',{method:'POST',body:{}});toast('서버를 시작했어요. 온라인 상태를 확인하세요.');});render();
}
async function stopServer(btn){
  if(!await confirmDialog({title:'서버를 중지할까요?',body:'진행 중인 다운로드도 끊겨요. 다시 시작할 때까지 초대받은 사람은 파일을 받을 수 없어요.',ok:'중지',danger:true}))return;
  await doing(btn,async()=>{await api(ROOT+'/stop',{method:'POST',body:{}});toast('서버를 중지했어요.');});render();
}
// 연결 점검: 이 PC → 클라우드 중계 → 다시 이 PC 로 실제 폴더 목록을 한 번 받아 본다.
async function selfCheck(btn){
  const out=q('.fs-check-result');out.replaceChildren(emptyLine('점검 중…'));
  const steps=[];const line=(ok,text)=>steps.push(put(node('li',ok?'ok':'bad'),(ok?'✓ ':'✗ ')+text));
  await doing(btn,async()=>{
    const state=await api(ROOT+'/state');
    line(state.desiredRunning,state.desiredRunning?'PC에서 서버가 켜져 있어요':'서버가 중지돼 있어요 — 「서버 시작」을 눌러 주세요');
    line(state.relay?.state==='connected','클라우드 중계 연결: '+(RELAY[state.relay?.state]?.[0]||state.relay?.state||'확인 안 됨'));
    let server=null;
    try{server=(await api(ROOT+'/servers/'+enc(state.serverId))).server;line(true,'클라우드 등록 상태: '+(server.status==='active'?'공유 중':'중지'));}
    catch(e){line(false,'클라우드 등록 정보를 불러오지 못했어요: '+errorText(e));}
    if(server)line(server.host?.online,server.host?.online?'외부에서 보이는 상태: 온라인 (마지막 신호 '+ago(server.host.lastSeenAt)+')':'외부에서 보이는 상태: 오프라인 — 연결 직후라면 30초 뒤 다시 점검해 주세요');
    if(state.desiredRunning&&state.shares[0]){
      const started=performance.now();
      try{const list=await api(ROOT+'/servers/'+enc(state.serverId)+'/files?shareId='+enc(state.shares[0].id)+'&path=');line(true,'중계를 거쳐 「'+state.shares[0].name+'」 목록 받기 성공 · 항목 '+list.entries.length+'개 · '+Math.round(performance.now()-started)+'ms');}
      catch(e){line(false,'중계를 거친 목록 받기 실패: '+errorText(e));}
    }
  });
  out.replaceChildren(put(node('ul','fs-checklist'),...steps));
}

function configureCard(state,existing){
  const card=node('section','card');
  const name=Object.assign(node('input'),{type:'text',maxLength:80,placeholder:'예: 우리 팀 자료',value:state.name||''});
  const scans=[];const list=node('div','stack');const ack=node('input');ack.type='checkbox';
  const error=node('div');
  const submit=button(existing?'변경 사항 게시':'서버 만들기',null,'btn primary');
  const sync=()=>{submit.disabled=!(name.value.trim()&&ack.checked&&scans.length&&scans.every(s=>s.complete&&Date.parse(s.expiresAt)>Date.now()));};
  const paint=()=>{
    list.replaceChildren();
    if(!scans.length)list.append(friendly('공유할 폴더를 골라 주세요','PC 화면에 폴더 선택 창이 떠요. 고른 폴더의 이름·형식만 검사하고 파일 내용은 올리지 않아요.'));
    for(const s of scans){
      const item=node('div','fs-scan');
      put(item,put(node('div','row between nowrap'),put(node('span'),node('b','',s.name),node('small','muted fs-path',s.path)),button('빼기',()=>{scans.splice(scans.indexOf(s),1);ack.checked=false;paint();},'btn sm ghost')),
        node('p','small muted','확인 '+s.checkedCount.toLocaleString('ko-KR')+'개 · 공유 제외 '+s.blockedCount+'개 · '+(s.complete?'검사 완료':'검사 미완료')),
        s.complete?null:node('p','banner bad','검사가 끝나지 않아(항목 2만 개 또는 15초 초과) 이 폴더는 게시할 수 없어요. 더 작은 하위 폴더를 골라 주세요.'));
      if(s.findings.length){const d=node('details');put(d,node('summary','small','공유에서 빠지는 항목 '+s.findings.length+'개 보기'),put(node('ul','small'),...s.findings.map(f=>node('li','',f.path+' — '+f.reason))));item.append(d);}
      list.append(item);
    }
    sync();
  };
  const pick=button('📁 폴더 선택 후 검사',function(){doing(this,async()=>{
    error.replaceChildren();
    if(scans.length>=10)throw new Error('공유 폴더는 10개까지 고를 수 있어요.');
    toast('PC 화면에 뜬 폴더 선택 창에서 골라 주세요.');
    const picked=await api(ROOT+'/pick',{method:'POST',body:{},timeout:310000});
    if(!picked.path)return;
    if(scans.some(s=>s.path.toLowerCase()===picked.path.toLowerCase()))throw new Error('이미 추가한 폴더예요.');
    toast('폴더를 검사하는 중이에요…');
    scans.push(await api(ROOT+'/scan',{method:'POST',body:{pickId:picked.pickId},timeout:60000}));ack.checked=false;paint();
  });},'btn');
  name.addEventListener('input',sync);ack.addEventListener('change',sync);
  submit.addEventListener('click',()=>doing(submit,async()=>{
    await api(ROOT+'/configure',{method:'POST',body:{name:name.value.trim(),scanIds:scans.map(s=>s.scanId)}});
    toast(existing?'공유 설정을 바꿨어요. 서버를 다시 시작해 주세요.':'서버를 만들었어요. 「서버 시작」을 누르면 공유가 열려요.');render();
  }));
  put(card,
    put(node('div','card-head'),put(node('div'),node('h2','',existing?'공유 폴더 변경':'내 서버 만들기'),node('p','sub','드라이브 전체는 공유할 수 없고, 하위 폴더만 최대 10개까지 고를 수 있어요.')))),
    existing?node('p','banner warn','공유할 폴더를 모두 다시 골라 검사해야 해요. 예전과 같은 폴더를 고르면 이미 초대한 멤버의 권한이 그대로 이어져요.'):null,
    put(node('div','field'),node('label','','서버 이름'),name,node('span','hint','초대받은 사람에게 보이는 이름이에요.')),
    put(node('div','row between'),node('b','','공유할 폴더'),pick),list,
    put(node('label','row small fs-check'),ack,'검사를 통과한 항목이 초대받은 사람에게 읽기 전용으로 보인다는 것을 확인했어요. (연락처·계좌·비밀번호 같은 이름, 실행 파일, 바로가기, 숨김 파일은 자동으로 빠져요)'),
    error,put(node('div','row'),submit,existing?button('취소',()=>render(),'btn ghost'):null));
  paint();return card;
}

async function renderOwnSection(box,state){
  box.replaceChildren(emptyLine('불러오는 중…'));
  try{
    if(ownSection==='members')await renderMembers(box,state);
    else if(ownSection==='audit'){auditPages=[];auditCursor=null;await renderAudit(box,state.serverId);}
    else if(ownSection==='local')await renderLocalAudit(box);
    else{const server=(await api(ROOT+'/servers/'+enc(state.serverId))).server;box.replaceChildren(fileBrowser(server,'서버 주인으로 중계를 거쳐 실제로 보이는 목록이에요. 초대받은 사람은 허용된 폴더만 보여요.'));}
  }catch(error){box.replaceChildren(node('p','banner warn',errorText(error)));}
}
async function renderMembers(box,state){
  const [{server},{members}]=await Promise.all([api(ROOT+'/servers/'+enc(state.serverId)),api(ROOT+'/servers/'+enc(state.serverId)+'/members')]);
  box.replaceChildren();
  const invite=node('section','card');const selected=new Set(server.shares.map(s=>s.id));const result=node('div');
  const checks=put(node('div','row wrap'),...server.shares.map(s=>{const c=node('input');c.type='checkbox';c.checked=true;c.addEventListener('change',()=>c.checked?selected.add(s.id):selected.delete(s.id));return put(node('label','row small fs-check'),c,s.name);}));
  const issue=button('초대 코드 발급',function(){doing(this,async()=>{
    if(!selected.size)throw new Error('초대할 공유 폴더를 하나 이상 골라 주세요.');
    const r=await api(ROOT+'/servers/'+enc(server.id)+'/invitations',{method:'POST',body:{shareIds:[...selected]}});
    const code=Object.assign(node('input','fs-code'),{type:'text',readOnly:true,value:fmtCode(r.code)});code.addEventListener('focus',()=>code.select());
    const left=node('span','small muted');const tick=()=>{const s=Math.max(0,Math.round((Date.parse(r.expiresAt)-Date.now())/1000));left.textContent=s?Math.floor(s/60)+'분 '+String(s%60).padStart(2,'0')+'초 뒤 만료 · 한 번만 쓸 수 있어요':'만료됐어요. 새 코드를 발급해 주세요.';if(s&&code.isConnected)setTimeout(tick,1000);};
    result.replaceChildren(put(node('div','fs-invite'),code,button('복사',async()=>{try{await navigator.clipboard.writeText(r.code);toast('초대 코드를 복사했어요.');}catch{code.select();toast('코드를 선택했어요. Ctrl+C로 복사해 주세요.');}},'btn sm'),left));tick();
  });},'btn primary');
  put(invite,put(node('div','card-head'),put(node('div'),node('h2','','초대 코드 발급'),node('p','sub','받는 사람은 자기 라피스 계정으로 로그인한 뒤 「참여 서버」에 코드를 넣어요. 새 코드를 발급하면 이전 코드는 무효가 돼요.')))),
    node('p','small muted','이 코드로 볼 수 있는 폴더'),checks,put(node('div','row'),issue),result,
    server.status!=='active'?node('p','banner warn','서버가 중지 상태라 코드를 써도 참여할 수 없어요. 서버를 시작한 뒤 발급해 주세요.'):null);
  const list=node('section','card');
  put(list,put(node('div','card-head'),put(node('div'),node('h2','','멤버 '+members.length+'명'),node('p','sub','접근을 회수하면 진행 중인 다운로드도 30초 안에 끊겨요. 이미 받은 파일은 지울 수 없어요.'))));
  const shareName=new Map(server.shares.map(s=>[s.id,s.name]));
  for(const m of members){
    const row=node('div','fs-member');
    const scope=m.role==='owner'?'모든 폴더':m.shareIds.map(id=>shareName.get(id)||'삭제된 폴더').join(', ')||'폴더 없음';
    put(row,put(node('span'),node('b','',m.name||mask(m.userId)),node('small','muted',(m.role==='owner'?'주인':'참여자')+' · '+scope+' · '+fmtDate(m.joinedAt)+' 참여')),
      m.role==='owner'?pill('주인','accent'):put(node('span','row nowrap'),pill(m.status==='active'?'접근 가능':'접근 회수',m.status==='active'?'ok':'bad'),button(m.status==='active'?'접근 회수':'다시 허용',function(){changeMember(this,server.id,m);},'btn sm '+(m.status==='active'?'danger':''))));
    list.append(row);
  }
  box.append(invite,list);
}
async function changeMember(btn,serverId,m){
  const next=m.status==='active'?'revoked':'active';
  if(next==='revoked'&&!await confirmDialog({title:(m.name||'이 멤버')+'님의 접근을 회수할까요?',body:'진행 중인 다운로드도 끊겨요. 다시 허용하면 원래 폴더 권한으로 돌아가요.',ok:'접근 회수',danger:true}))return;
  await doing(btn,async()=>{await api(ROOT+'/servers/'+enc(serverId)+'/members/'+enc(m.userId),{method:'PATCH',body:{status:next}});toast(next==='revoked'?'접근을 회수했어요.':'접근을 다시 허용했어요.');});
  renderOwnSection(btn.closest('.stack'),ownState);
}
async function renderAudit(box,serverId){
  const [page,members]=await Promise.all([api(ROOT+'/servers/'+enc(serverId)+'/audit?limit=50'+(auditCursor?'&cursor='+enc(auditCursor):'')),api(ROOT+'/servers/'+enc(serverId)+'/members').catch(()=>({members:[]}))]);
  auditPages.push(...page.events);auditCursor=page.nextCursor;
  const names=new Map(members.members.map(m=>[m.userId,m.name]));
  const card=node('section','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','활동 기록 (클라우드)'),node('p','sub','누가 언제 어떤 폴더를 열고 어떤 파일을 받았는지 계정별로 남아요. 「중계 전송 완료」는 받는 PC의 저장 완료를 보증하지 않아요.'))));
  card.append(auditList(auditPages,names));
  if(auditCursor)card.append(button('이전 기록 더 보기',function(){doing(this,()=>renderAudit(box,serverId));},'btn sm'));
  box.replaceChildren(card);
}
function auditList(events,names=new Map()){
  if(!events.length)return emptyLine('아직 기록이 없어요.');
  const listBox=node('div','fs-audit');
  for(const e of events){
    const who=names.get(e.actorUserId)||mask(e.actorUserId);
    const what=(ACTIONS[e.action]||e.action)+(e.relativePath?' · '+e.relativePath:'');
    const detail=[REASONS[e.reasonCode||e.outcome||e.source]||'',e.bytesSent!=null&&e.action!=='list'?fmtBytes(e.bytesSent)+(e.expectedBytes?' / '+fmtBytes(e.expectedBytes):''):''].filter(Boolean).join(' · ');
    listBox.append(put(node('div','fs-audit-row'),put(node('span'),node('b','',who),' · '+what,node('small','muted',detail)),node('time','small muted',fmtDate(e.at,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}))));
  }
  return listBox;
}
async function renderLocalAudit(box){
  const {events}=await api(ROOT+'/local-audit?limit=200');
  const card=node('section','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','PC 기록'),node('p','sub','이 PC가 보낸 목록·다운로드를 PC에도 따로 남긴 기록이에요(최근 200건). 클라우드 기록과 맞춰 볼 때 써요.'))),auditList(events));
  box.replaceChildren(card);
}

// ── 파일 보기(참여 서버·내 서버 공통) ──
function fileBrowser(server,note){
  const card=node('section','card');
  if(!server.shares.length){card.append(friendly('볼 수 있는 공유 폴더가 없어요','서버 주인에게 접근 권한을 요청해 주세요.'));return card;}
  if(browse.serverId!==server.id||!server.shares.some(s=>s.id===browse.shareId))browse={serverId:server.id,shareId:server.shares[0].id,path:''};
  const tabs=put(node('div','tabs'),...server.shares.map(s=>button('📁 '+s.name,()=>{browse.shareId=s.id;browse.path='';paint();},s.id===browse.shareId?'on':'')));
  const listBox=node('div');
  async function paint(){
    qa('button',tabs).forEach((b,i)=>b.classList.toggle('on',server.shares[i].id===browse.shareId));
    listBox.replaceChildren(emptyLine('불러오는 중…'));
    try{
      const listing=await api(ROOT+'/servers/'+enc(server.id)+'/files?shareId='+enc(browse.shareId)+'&path='+enc(browse.path));
      const crumbs=node('div','crumbs');const parts=browse.path?browse.path.split('/'):[];
      crumbs.append(button('맨 위',()=>{browse.path='';paint();},'crumb'));
      parts.forEach((p,i)=>crumbs.append(node('span','muted','›'),button(p,()=>{browse.path=parts.slice(0,i+1).join('/');paint();},'crumb')));
      const table=node('div','file-table');
      for(const e of listing.entries){
        const row=node('div','file-row');
        put(row,e.folder?button('📁 '+e.name,()=>{browse.path=e.path;paint();},'file-name folder'):node('span','file-name','📄 '+e.name),
          node('span','file-size small muted',e.folder?'':fmtBytes(e.size)),node('span','file-date small muted',e.modifiedAt?fmtDate(e.modifiedAt,{year:'2-digit',month:'numeric',day:'numeric'}):''),
          e.folder?node('span'):button('⬇ 받기',()=>download(server.id,browse.shareId,e),'btn sm'));
        table.append(row);
      }
      listBox.replaceChildren(crumbs,listing.entries.length?table:emptyLine('빈 폴더예요.'),listing.truncated?node('p','small muted','항목이 많아 앞의 500개만 보여 줘요.'):null);
    }catch(error){listBox.replaceChildren(node('p','banner warn',errorText(error)));}
  }
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','공유 파일'),node('p','sub',note))),button('↻',()=>paint(),'btn sm')),
    server.host?.online?null:node('p','banner warn','서버 PC가 오프라인이에요. 주인이 PC와 서버를 켜면 다시 볼 수 있어요.'),tabs,listBox);
  paint();return card;
}
// 다운로드는 숨은 창에서 연다: 성공하면 브라우저가 저장하고, 실패하면 오류 문구만 읽어 알린다.
function download(serverId,shareId,entry){
  let frame=q('#fs-download');
  if(!frame){frame=node('iframe');frame.id='fs-download';frame.name='fs-download';frame.hidden=true;frame.title='다운로드';document.body.append(frame);
    frame.addEventListener('load',()=>{try{const text=frame.contentDocument?.body?.innerText?.trim();if(text){const data=JSON.parse(text);if(data.error)toast(data.error,true);}}catch{}});}
  frame.src=ROOT+'/servers/'+enc(serverId)+'/download?shareId='+enc(shareId)+'&path='+enc(entry.path);
  toast('「'+entry.name+'」 받기를 시작했어요. 브라우저 다운로드 목록에서 확인하세요.');
}

// ── 참여 서버 ──
async function renderJoined(box){
  const {servers}=await api(ROOT+'/servers');
  const joined=servers.filter(s=>s.role==='viewer');
  box.replaceChildren();
  const form=node('form','row nowrap');
  const code=Object.assign(node('input'),{type:'text',inputMode:'numeric',autocomplete:'off',placeholder:'12자리 초대 코드 (예: 1234-5678-9012)',maxLength:20});code.style.flex='1';
  const join=button('참여',null,'btn primary');join.type='submit';
  form.addEventListener('submit',e=>{e.preventDefault();doing(join,async()=>{
    const value=code.value.replace(/[\s-]/g,'');if(!/^\d{12}$/.test(value))throw new Error('초대 코드는 숫자 12자리예요.');
    const r=await api(ROOT+'/redeem',{method:'POST',body:{code:value}});selectedServer=r.server.id;toast('「'+r.server.name+'」 서버에 참여했어요.');render();
  });});
  const card=node('section','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','초대 코드로 참여'),node('p','sub','서버 주인에게 받은 12자리 코드를 넣어요. 코드는 한 번만 쓸 수 있고 발급 후 10분 동안 유효해요.'))),put(form,code,join));
  box.append(card);
  if(!joined.length){box.append(friendly('참여한 서버가 없어요','서버 주인에게 초대 코드를 받아 위에 넣어 주세요.'));return;}
  if(!joined.some(s=>s.id===selectedServer))selectedServer=joined[0].id;
  const list=node('section','card');
  put(list,put(node('div','card-head'),put(node('div'),node('h2','','참여 서버 '+joined.length+'개')),button('↻ 새로고침',()=>render(),'btn sm')));
  for(const s of joined){
    const row=button('',()=>{selectedServer=s.id;render();},'fs-server'+(s.id===selectedServer?' on':''));
    put(row,put(node('span'),node('b','',s.name),node('small','muted',s.shares.length+'개 폴더 · 마지막 연결 '+ago(s.host?.lastSeenAt))),pill(s.host?.online?'온라인':'오프라인',s.host?.online?'ok':''));
    list.append(row);
  }
  box.append(list,fileBrowser(joined.find(s=>s.id===selectedServer),'읽기 전용이에요. 받은 파일은 브라우저의 다운로드 폴더에 저장돼요.'));
}

q('#fs-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-fs-tab]');if(b)setTab(b.dataset.fsTab);});
registerPage('fileserver',{show(sub){if(sub==='joined'||sub==='own'){tab=sub;qa('[data-fs-tab]').forEach(b=>b.classList.toggle('on',b.dataset.fsTab===sub));}refreshSession().then(render);}});
