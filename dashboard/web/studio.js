// 봇 스튜디오: 봇을 하나든 여러 개든 만들고, 엔진·역할(에이전트)·텔레그램 방과 주제·스킬을 설정한다.
// LAPIS 봇(런타임)과 기존 Claude 사무실·Hermes 를 한 목록에서 본다.
import {q,node,put,button,pill,link,registerPage,toast,errorText,doing,confirmDialog,input,textarea,field,select} from './ui.js';
import {eng,watchJob,progressBox} from './platform.js';

const ENGINE_ORDER=['claude','codex','ollama','openai','anthropic','hermes'];
const ENGINE_HINT={
  claude:'Claude 구독 계정으로 답해요. 파일 읽기·쓰기까지 시킬 수 있어요.',
  codex:'ChatGPT 계정으로 답해요. 파일 작업도 시킬 수 있어요.',
  ollama:'내 PC의 무료 AI. 인터넷 없이도 돼요.',
  openai:'OpenAI API 키로 GPT 를 써요. 웹 배포도 가능해요.',
  anthropic:'Anthropic API 키로 Claude 를 써요. 웹 배포도 가능해요.',
  hermes:'스스로 배우는 Hermes 에이전트로 답해요.',
};
const ACCESS_LABEL={chat:'대화만',read:'폴더 읽기',write:'폴더 읽기·쓰기'};
let meta=null;   // {engineTypes, agentPresets, readiness}
let tab='overview';

const root=()=>q('#studio-body');
const go=hash=>{location.hash=hash;};
async function loadMeta(){const d=await eng('/api/bots');meta={engineTypes:d.engineTypes,agentPresets:d.agentPresets,readiness:d.readiness};return d;}
const engineLabel=e=>e?`${e.type==='workersai'?'Cloudflare 무료 AI':meta?.engineTypes[e.type]?.label||e.type}${e.model?' · '+e.model:''}`:'-';

// ── 모델 고르기: 엔진에 따라 선택 목록 또는 직접 입력 ──
async function modelPicker(type,current=''){
  const wrap=node('div','row nowrap');
  const free=input({placeholder:'비워 두면 기본 모델',maxLength:80,value:current});free.setAttribute('aria-label','모델 이름');
  let control=free,get=()=>free.value.trim();
  try{
    let list=null;
    if(type==='ollama')list=meta.readiness.ollama.models;
    else if(type==='openai'||type==='anthropic')list=(await eng('/api/connections/models/'+type)).models;
    if(list&&list.length){
      const sel=select(list.map(m=>[m,m]),list.includes(current)?current:list[0]);sel.setAttribute('aria-label','모델 선택');
      control=sel;get=()=>sel.value;
    }
  }catch{ /* 키가 없거나 목록을 못 받으면 직접 입력으로 둔다 */ }
  wrap.append(control);
  return {node:wrap,get};
}

function readinessNote(type){
  const r=meta.readiness[type];
  if(!r||r.ready)return pill('바로 쓸 수 있어요','ok');
  const wrap=node('span','row nowrap');
  put(wrap,pill(r.reason,'warn'),link('연결 허브에서 해결 →','#hub','small'));
  return wrap;
}

// ── 목록 ──
async function renderList(){
  const [d,ov]=await Promise.all([loadMeta(),eng('/api/overview').catch(()=>({offices:[]}))]);
  const head=put(node('div','row between wrap'),node('p','view-intro','봇은 하나만 써도, 여러 개를 만들어 역할별로 나눠도 돼요. 봇마다 두뇌(AI)와 역할, 텔레그램 방을 따로 정해요.'),put(node('div','row'),button('Claude 사무실(고급) 만들기',()=>document.querySelector('#newOffice')?.click(),'btn'),link('＋ 새 봇 만들기','#studio/new','btn primary')));
  const grid=node('div','grid cols-2');
  for(const b of d.bots){
    const c=node('article','card bot-card');
    const st=b.telegram.set?pill('텔레그램 @'+(b.telegram.username||'연결됨'),'ok'):pill('텔레그램 연결 필요','warn');
    put(c,put(node('div','card-head'),put(node('div'),node('h2','',b.name),node('p','sub',engineLabel(b.engine))),pill('LAPIS 봇','accent')),
      put(node('div','row wrap'),pill(`역할 ${b.agents}개`),pill(`방 ${b.rooms}개`),st),
      put(node('div','row'),link('설정 열기','#studio/'+b.id,'btn primary sm')));
    grid.append(c);
  }
  for(const o of ov.offices||[]){
    const c=node('article','card bot-card');
    put(c,put(node('div','card-head'),put(node('div'),node('h2','',o.name),node('p','sub',o.kind==='hermes'?'Hermes 봇 (읽기 전용으로 인식)':'Claude 사무실 · 부서 '+o.teamsCount+'개')),pill(o.kind==='hermes'?'Hermes':'Claude 사무실',o.running?'ok':'')),
      put(node('div','row wrap'),pill(o.running?'근무 중':'꺼짐',o.running?'ok':''),o.telegram?.set?pill('텔레그램 연결됨','ok'):null),
      o.kind==='hermes'?node('p','small muted','Hermes 는 자체 설정으로 관리해요. 스킬 마켓에서 스킬 설치만 도와드려요.'):put(node('div','row'),link('부서 관리 →','#teams','btn sm'),link('텔레그램 설정 →','#connect','btn sm')));
    grid.append(c);
  }
  if(!d.bots.length&&!(ov.offices||[]).length)grid.append(put(node('div','friendly-empty'),node('h3','','아직 봇이 없어요'),node('p','','「새 봇 만들기」로 1분 만에 첫 봇을 만들어 보세요.')));
  root().replaceChildren(head,grid);
}

// ── 새 봇 ──
async function renderNew(){
  await loadMeta();
  const st={name:'',engine:'',presets:new Set(),persona:''};
  const name=input({placeholder:'예: 내 비서, 우리 동아리 봇',maxLength:40});name.setAttribute('aria-label','봇 이름');
  const engineBox=node('div','engine-grid');
  let picker=null;const modelBox=node('div');
  async function pickEngine(type){
    st.engine=type;
    engineBox.querySelectorAll('.engine').forEach(e=>e.classList.toggle('on',e.dataset.type===type));
    picker=await modelPicker(type);modelBox.replaceChildren(put(node('div','field'),node('label','','모델'),picker.node,node('span','hint','잘 모르겠으면 비워 두거나 첫 번째를 쓰세요.')));
  }
  for(const type of ENGINE_ORDER){
    const t=meta.engineTypes[type];
    const el=node('button','engine');el.type='button';el.dataset.type=type;
    put(el,node('b','',t.label),node('small','muted',ENGINE_HINT[type]),readinessNote(type));
    el.addEventListener('click',()=>pickEngine(type));engineBox.append(el);
  }
  const firstReady=ENGINE_ORDER.find(t=>meta.readiness[t]?.ready)||'claude';
  await pickEngine(firstReady);
  const chips=node('div','chips');
  for(const p of meta.agentPresets.slice(0,12)){
    const l=node('label','chip');const cb=node('input');cb.type='checkbox';cb.style.display='none';
    cb.addEventListener('change',()=>{cb.checked?st.presets.add(p.key):st.presets.delete(p.key);l.classList.toggle('on',cb.checked);});
    put(l,cb,put(node('span'),node('b','',p.emoji+' '+p.name),node('span','',p.role)));chips.append(l);
  }
  const persona=textarea({rows:3,maxLength:4000,placeholder:'비워 두면 기본 비서 지침을 써요. 예: 친근한 말투로, 항상 한 줄 요약부터.'});persona.setAttribute('aria-label','봇 성격과 지침');
  const make=button('봇 만들기',async function(){
    await doing(this,async()=>{
      const body={name:name.value.trim(),engine:{type:st.engine,model:picker.get()},presets:[...st.presets],persona:persona.value.trim()||undefined};
      const b=await eng('/api/bots',{method:'POST',body});
      toast('봇을 만들었어요. 이어서 텔레그램을 연결해 보세요.');tab='telegram';go('#studio/'+b.id);
    });
  },'btn primary');
  root().replaceChildren(put(node('div','stack'),
    put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','① 이름'),node('p','sub','봇의 이름이에요. 나중에 바꿀 수 있어요.'))),field('봇 이름',name)),
    put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','② 두뇌(AI)'),node('p','sub','이 봇이 쓸 AI를 골라요. 역할(에이전트)마다 다른 AI를 쓰게 할 수도 있어요.'))),engineBox,modelBox),
    put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','③ 역할 (선택)'),node('p','sub','봇 하나에 여러 역할을 둘 수 있어요. 지금은 건너뛰고 나중에 추가해도 돼요. 텔레그램에서 /agent 로 바꿔 부를 수 있어요.'))),chips,field('성격과 지침 (선택)',persona)),
    put(node('div','row'),make,link('취소','#studio','btn ghost'))));
  name.focus();
}

// ── 상세 ──
const tabs=[['overview','개요'],['agents','역할(에이전트)'],['telegram','텔레그램 · 방과 주제'],['skills','스킬'],['test','시험 대화'],['publish','웹 배포']];
async function renderDetail(id){
  await loadMeta();
  let b;
  try{b=await eng('/api/bots/'+encodeURIComponent(id));}
  catch(e){root().replaceChildren(node('p','banner bad','봇을 찾을 수 없어요: '+errorText(e)),link('← 목록으로','#studio','btn'));return;}
  const rt=b.runtime||{};
  const head=put(node('div','row between wrap'),put(node('div'),link('← 봇 목록','#studio','small'),node('h2','bot-title',b.name),node('p','sub',engineLabel(b.engine))),
    put(node('div','row'),rt.running?pill('수신 중 @'+rt.username,'ok'):pill('꺼짐'),
      rt.running?button('멈추기',async function(){await doing(this,async()=>{await eng(`/api/bots/${id}/stop`,{method:'POST',body:{}});renderDetail(id);});},'btn'):button('켜기',async function(){await doing(this,async()=>{await eng(`/api/bots/${id}/start`,{method:'POST',body:{}});toast('봇을 켰어요.');renderDetail(id);});},'btn primary')));
  const bar=node('div','tabs');
  for(const [k,label] of tabs)bar.append(button(label,()=>{tab=k;renderDetail(id);},k===tab?'on':''));
  const err=rt.error?node('p','banner warn',rt.error):null;
  const body=node('div','stack');
  const view={overview:detailOverview,agents:detailAgents,telegram:detailTelegram,skills:detailSkills,test:detailTest,publish:detailPublish}[tab];
  await view(b,body,()=>renderDetail(id));
  root().replaceChildren(...[head,err,bar,body].filter(Boolean));
}

async function detailOverview(b,body,refresh){
  const name=input({value:b.name,maxLength:40});
  const hon=input({value:b.honorific,maxLength:20});
  const persona=textarea({rows:5,maxLength:4000,value:b.persona});
  const eng_=select(ENGINE_ORDER.map(t=>[t,meta.engineTypes[t].label]),b.engine.type);
  const modelSlot=node('div');let picker=await modelPicker(b.engine.type,b.engine.model);modelSlot.append(picker.node);
  eng_.addEventListener('change',async()=>{picker=await modelPicker(eng_.value,'');modelSlot.replaceChildren(picker.node);});
  const access=select(Object.entries(ACCESS_LABEL),b.access);
  const auto=node('input');auto.type='checkbox';auto.checked=b.autoStart;
  const save=button('저장',async function(){await doing(this,async()=>{await eng('/api/bots/'+b.id,{method:'PATCH',body:{name:name.value,honorific:hon.value,persona:persona.value,engine:{type:eng_.value,model:picker.get()},access:access.value,autoStart:auto.checked}});toast('저장했어요.');refresh();});},'btn primary');
  put(body,put(node('section','card'),put(node('div','card-head'),node('h2','','기본 설정')),
    field('이름',name),field('나를 부르는 호칭',hon,'봇이 나를 이렇게 불러요.'),
    field('두뇌(AI)',eng_),field('모델',modelSlot),
    field('기본 권한',access,'Claude·GPT(로그인) 엔진에서만 폴더를 읽고 쓸 수 있어요. 나머지는 대화만 해요.'),
    field('성격과 지침',persona,'모든 역할에 공통으로 적용돼요.'),
    put(node('label','row nowrap'),auto,node('span','','앱을 켤 때 이 봇도 자동으로 켜기')),
    put(node('div','row'),save)));
  const danger=put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','봇 폐쇄'),node('p','sub','폴더는 지우지 않고 보관 위치로 옮겨요. 텔레그램 토큰은 지워져요.'))),
    button('이 봇 폐쇄…',async function(){
      const typed=prompt(`폐쇄하려면 봇 이름 "${b.name}" 을 똑같이 입력하세요.`);
      if(typed===null)return;
      await doing(this,async()=>{await eng(`/api/bots/${b.id}/close`,{method:'POST',body:{confirmName:typed}});toast('폐쇄했어요.');go('#studio');});
    },'btn danger'));
  body.append(danger);
}

function agentCard(b,a,refresh){
  const name=input({value:a.name,maxLength:30}),emoji=input({value:a.emoji,maxLength:4,size:3}),role=input({value:a.role,maxLength:160});
  const instr=textarea({rows:5,maxLength:4000,value:a.instructions});
  const own=a.engine?.type;
  const engSel=select([['','봇 기본과 같음'],...ENGINE_ORDER.map(t=>[t,meta.engineTypes[t].label])],own||'');
  const model=input({value:a.engine?.model||'',maxLength:80,placeholder:'모델 (선택)'});
  const acc=select([['','봇 기본과 같음'],...Object.entries(ACCESS_LABEL)],a.access||'');
  const skillBox=node('div','chips');
  const d=node('details','agent-card');
  const sum=put(node('summary'),node('b','',a.emoji+' '+a.name),node('span','small muted',a.role||'역할 설명 없음'),b.defaultAgent===a.key?pill('기본 역할','accent'):null,a.engine?.type?pill(meta.engineTypes[a.engine.type].label):null);
  const save=button('저장',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/agents/${a.key}`,{method:'PATCH',body:{name:name.value,emoji:emoji.value,role:role.value,instructions:instr.value,engine:engSel.value?{type:engSel.value,model:model.value.trim()}:null,access:acc.value,skills:[...skillBox.querySelectorAll('input:checked')].map(x=>x.value)}});toast('저장했어요.');refresh();});},'btn primary sm');
  const setDefault=button('기본 역할로',async function(){await doing(this,async()=>{await eng('/api/bots/'+b.id,{method:'PATCH',body:{defaultAgent:a.key}});refresh();});},'btn sm');
  const del=button('삭제',async function(){if(!await confirmDialog({title:`"${a.name}" 역할을 삭제할까요?`,body:'이 역할을 쓰던 방·주제는 기본 역할로 돌아가요.',ok:'삭제',danger:true}))return;await doing(this,async()=>{await eng(`/api/bots/${b.id}/agents/${a.key}`,{method:'DELETE',body:{}});refresh();});},'btn sm danger');
  eng('/api/bots/'+b.id+'/skills').then(r=>{
    if(!r.skills.length){skillBox.append(node('span','small muted','붙일 스킬이 없어요. 「스킬」 탭에서 만들거나 스킬 마켓에서 받으세요.'));return;}
    for(const s of r.skills){const l=node('label','chip'+(a.skills.includes(s.id)?' on':''));const cb=node('input');cb.type='checkbox';cb.value=s.id;cb.checked=a.skills.includes(s.id);cb.style.display='none';cb.addEventListener('change',()=>l.classList.toggle('on',cb.checked));put(l,cb,put(node('span'),node('b','',s.name),node('span','',s.description||'')));skillBox.append(l);}
  }).catch(()=>{});
  put(d,sum,put(node('div','agent-form'),put(node('div','row nowrap'),field('이모지',emoji),field('이름',name)),field('하는 일',role),
    field('지침',instr,'이 역할이 지켜야 할 규칙과 말투를 적어요.'),
    put(node('div','grid cols-2'),field('이 역할의 두뇌',engSel),field('모델',model)),
    field('권한',acc),node('div','group-title','붙일 스킬'),skillBox,put(node('div','row'),save,setDefault,node('span','spacer'),del)));
  return d;
}

async function detailAgents(b,body,refresh){
  const intro=node('p','view-intro','역할마다 지침·두뇌·권한·스킬을 따로 정해요. 텔레그램에서는 「기획팀 …」처럼 이름으로 부르거나 /agent 로 바꿔요.');
  const list=node('div','stack');
  if(!b.agents.length)list.append(put(node('div','friendly-empty'),node('h3','','역할이 아직 없어요'),node('p','','봇은 역할 없이도 대답해요. 필요할 때 추가하세요.')));
  for(const a of b.agents)list.append(agentCard(b,a,refresh));
  const sel=select([['','추천 역할 고르기…'],...meta.agentPresets.map(p=>[p.key,`${p.emoji} ${p.name} — ${p.role}`])],'');
  const addPreset=button('추가',async function(){if(!sel.value)return;await doing(this,async()=>{await eng(`/api/bots/${b.id}/agents`,{method:'POST',body:{preset:sel.value}});refresh();});},'btn primary');
  const blank=input({placeholder:'직접 만들기: 역할 이름',maxLength:30});
  const addBlank=button('만들기',async function(){if(!blank.value.trim())return;await doing(this,async()=>{await eng(`/api/bots/${b.id}/agents`,{method:'POST',body:{name:blank.value.trim()}});refresh();});},'btn');
  put(body,intro,list,put(node('section','card'),put(node('div','card-head'),node('h2','','역할 추가')),put(node('div','row wrap'),sel,addPreset),put(node('div','row wrap'),blank,addBlank)));
}

async function detailTelegram(b,body,refresh){
  const tg=b.telegram;
  // 토큰
  const tokenCard=node('section','card');
  if(!tg.set){
    const tok=input({type:'password',placeholder:'123456789:AAH…',autocomplete:'off',spellcheck:false,maxLength:100});tok.setAttribute('aria-label','봇 토큰');
    put(tokenCard,put(node('div','card-head'),put(node('div'),node('h2','','① 텔레그램 봇 연결'),node('p','sub','텔레그램의 BotFather 가 봇을 만들어 주고 토큰을 알려줘요.'))),pill('연결 필요','warn'),
      put(node('ol','guide'),node('li','','아래 버튼으로 텔레그램의 BotFather 를 열어요.'),node('li','','/newbot 을 보내고 봇 이름과 @아이디를 정하면 토큰(숫자:영문 긴 글자)을 줘요.'),node('li','','그 토큰을 아래에 붙여 넣으세요.')),
      put(node('div','row'),link('텔레그램에서 BotFather 열기','https://t.me/BotFather','btn'),tok,button('연결',async function(){await doing(this,async()=>{const r=await eng(`/api/bots/${b.id}/telegram/token`,{method:'POST',body:{token:tok.value.trim()}});toast('연결됐어요: @'+r.username);refresh();});},'btn primary')));
  }else{
    put(tokenCard,put(node('div','card-head'),put(node('div'),node('h2','','① 텔레그램 봇'),node('p','sub','@'+tg.username)),pill('연결됨','ok')),
      put(node('div','row'),link('텔레그램에서 열기','https://t.me/'+tg.username,'btn sm'),button('연결 끊기',async function(){if(!await confirmDialog({title:'텔레그램 연결을 끊을까요?',body:'봇이 멈추고 저장된 토큰이 지워져요.',ok:'끊기',danger:true}))return;await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/token`,{method:'DELETE',body:{}});refresh();});},'btn sm danger')));
  }
  body.append(tokenCard);
  if(!tg.set)return;
  // 허용
  const code=input({placeholder:'6자리 코드',maxLength:6,size:8,inputMode:'numeric'});
  const allowCard=node('section','card');
  const people=node('div','stack');
  for(const id of tg.allowFrom)people.append(put(node('div','row between'),node('span','','사용자 번호 '+id),button('허용 해제',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/remove`,{method:'POST',body:{senderId:id}});refresh();});},'btn sm')));
  if(!tg.allowFrom.length)people.append(node('p','small muted','아직 허용된 사람이 없어요. 텔레그램에서 봇에게 아무 말이나 보내면 6자리 코드가 와요. 그 코드를 아래에 입력하세요.'));
  for(const p of tg.pending||[])people.append(put(node('div','row between'),node('span','',`대기 중: ${p.name||p.senderId} · 코드 ${p.code}`),button('이 사람 허용',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/pair`,{method:'POST',body:{code:p.code}});toast('허용했어요.');refresh();});},'btn sm primary')));
  put(allowCard,put(node('div','card-head'),put(node('div'),node('h2','','② 쓸 수 있는 사람'),node('p','sub','허용된 사람만 봇을 쓸 수 있어요. 낯선 사람이 말을 걸어도 코드만 안내하고 답하지 않아요.'))),people,
    put(node('div','row'),code,button('코드로 허용',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/pair`,{method:'POST',body:{code:code.value.trim()}});toast('허용했어요.');refresh();});},'btn primary')));
  body.append(allowCard);
  // 방·주제
  const roomsCard=node('section','card');
  put(roomsCard,put(node('div','card-head'),put(node('div'),node('h2','','③ 방과 주제별 설정'),node('p','sub','봇을 그룹방에 초대한 뒤 허용된 사람이 아무 말이나 하면 이곳에 방이 나타나요. 주제(토픽)가 있는 방은 주제마다 다른 역할을 맡길 수 있어요.'))));
  const rooms=Object.entries(tg.rooms||{});
  if(!rooms.length)roomsCard.append(node('p','small muted','아직 방이 없어요. 그룹에서 /whoami 를 보내면 방 번호도 알려드려요.'));
  const agentOpts=[['','기본 역할'],...b.agents.map(a=>[a.key,a.emoji+' '+a.name])];
  for(const [chatId,r] of rooms){
    const mode=select([['mention','멘션하거나 답장할 때만'],['all','모든 말에 답하기']],r.mode),ag=select(agentOpts,r.agent),ins=textarea({rows:2,maxLength:2000,value:r.instructions,placeholder:'이 방에서만 지킬 지침 (선택)'});
    const on=node('input');on.type='checkbox';on.checked=r.connected;
    const save=button('저장',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/rooms/${chatId}`,{method:'POST',body:{mode:mode.value,agent:ag.value,instructions:ins.value,connected:on.checked}});toast('저장했어요.');refresh();});},'btn sm primary');
    const forget=button('방 잊기',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/rooms/${chatId}`,{method:'DELETE',body:{}});refresh();});},'btn sm danger');
    const topics=node('div','stack');
    for(const [tid,t] of Object.entries(r.topics||{})){
      const tn=input({value:t.name,maxLength:60,placeholder:'주제 이름'}),ta=select(agentOpts,t.agent),ti=textarea({rows:2,maxLength:2000,value:t.instructions,placeholder:'이 주제의 지침 (선택)'});
      topics.append(put(node('div','topic-row'),node('b','small','주제 '+tid),tn,ta,ti,button('저장',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/rooms/${chatId}/topics/${tid}`,{method:'POST',body:{name:tn.value,agent:ta.value,instructions:ti.value}});toast('저장했어요.');refresh();});},'btn sm')));
    }
    const newTid=input({placeholder:'주제 번호 추가 (그 주제에서 /whoami)',maxLength:12,size:22,inputMode:'numeric'});
    const addTopic=button('주제 추가',async function(){if(!/^\d+$/.test(newTid.value.trim()))return toast('주제 번호는 숫자예요.',true);await doing(this,async()=>{await eng(`/api/bots/${b.id}/telegram/rooms/${chatId}/topics/${newTid.value.trim()}`,{method:'POST',body:{}});refresh();});},'btn sm');
    roomsCard.append(put(node('div','room'),put(node('div','row between wrap'),node('b','',(r.title||'이름 없는 방')+'  '+chatId),put(node('label','row nowrap small'),on,node('span','','이 방에서 일하기'))),
      put(node('div','grid cols-2'),field('응답 방식',mode),field('방 기본 역할',ag)),field('방 지침',ins),
      node('div','group-title','주제별'),topics,put(node('div','row wrap'),newTid,addTopic),put(node('div','row'),save,forget)));
  }
  body.append(roomsCard);
}

async function detailSkills(b,body,refresh){
  const {skills}=await eng(`/api/bots/${b.id}/skills`);
  const list=node('div','stack');
  for(const s of skills)list.append(put(node('div','row between'),put(node('div'),node('b','',s.name),node('p','small muted',s.description||'설명 없음')),
    button('삭제',async function(){if(!await confirmDialog({title:`"${s.name}" 스킬을 지울까요?`,body:'파일은 지우지 않고 보관함으로 옮겨요.',ok:'지우기',danger:true}))return;await doing(this,async()=>{await eng(`/api/bots/${b.id}/skills/${s.id}`,{method:'DELETE',body:{}});refresh();});},'btn sm danger')));
  if(!skills.length)list.append(node('p','small muted','아직 스킬이 없어요. 아래에서 직접 만들거나 스킬 마켓에서 받아 보세요.'));
  const n=input({maxLength:60,placeholder:'스킬 이름 (예: 보고서 문체)'}),dsc=input({maxLength:200,placeholder:'한 줄 설명'}),txt=textarea({rows:6,maxLength:12000,placeholder:'AI가 따를 방법을 적어요. 예: 보고서는 □ ○ - 순서로 개조식으로 쓴다.'});
  put(body,put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','이 봇의 스킬'),node('p','sub','스킬은 역할에 붙여 쓰는 “일하는 방법”이에요. 「역할」 탭에서 역할마다 붙여요.')),link('스킬 마켓 열기 →','#market','btn sm')),list),
    put(node('section','card'),put(node('div','card-head'),node('h2','','스킬 직접 만들기')),field('이름',n),field('설명',dsc),field('내용',txt),
      put(node('div','row'),button('만들기',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/skills`,{method:'POST',body:{name:n.value,description:dsc.value,body:txt.value}});toast('스킬을 만들었어요.');refresh();});},'btn primary'))));
}

async function detailTest(b,body){
  const ag=select([['','자동(기본 역할)'],...b.agents.map(a=>[a.key,a.emoji+' '+a.name])],'');
  const msg=textarea({rows:3,maxLength:4000,placeholder:'봇에게 할 말을 적고 보내 보세요. 텔레그램 없이 설정을 바로 시험할 수 있어요.'});
  const out=node('div','bubble bot');out.hidden=true;
  const send=button('보내기',async function(){
    out.hidden=false;out.textContent='생각하는 중…';this.disabled=true;
    try{const r=await eng(`/api/bots/${b.id}/test`,{method:'POST',body:{message:msg.value,agent:ag.value||undefined}});out.textContent=r.answer;}
    catch(e){out.textContent='⚠️ '+errorText(e);}finally{this.disabled=false;}
  },'btn primary');
  put(body,put(node('section','card'),put(node('div','card-head'),node('h2','','시험 대화')),field('역할',ag),msg,put(node('div','row'),send),out));
}

// ── 웹 배포: 이 봇을 내 Cloudflare 계정의 웹 주소로 올린다 ──
function randomPassword(){const a='abcdefghjkmnpqrstuvwxyz23456789';const b=new Uint8Array(12);crypto.getRandomValues(b);return [...b].map(x=>a[x%a.length]).join('').replace(/(.{4})(?=.)/g,'$1-');}
async function detailPublish(b,body,refresh){
  const {plan,status}=await eng(`/api/bots/${b.id}/publish`);
  const intro=put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','웹 주소로 배포'),node('p','sub','이 봇을 내 Cloudflare 계정에 올려요. 올리면 PC가 꺼져 있어도 웹 주소(와 텔레그램)에서 대답해요.'))),
    put(node('ul','guide'),node('li','','웹에서는 PC의 파일과 Claude·ChatGPT 로그인을 쓸 수 없어요. API 키 엔진(GPT·Claude) 또는 Cloudflare 무료 AI로 대답해요.'),
      node('li','','올라가는 것: 봇 이름·성격·역할·지침·스킬 글, 선택한 AI의 API 키(비밀 값으로만), 텔레그램 토큰(연결했을 때).'),
      node('li','','웹 주소는 비밀번호로 보호돼요. 언제든 지우거나 PC로 되돌릴 수 있어요.')));
  body.append(intro);
  if(!plan.tokenSet){
    body.append(put(node('section','card'),put(node('div','card-head'),node('h2','','Cloudflare 계정 연결이 필요해요')),node('p','sub','연결 허브에서 Cloudflare API 토큰을 한 번만 넣으면 돼요.'),put(node('div','row'),link('연결 허브로 가기 →','#hub','btn primary'))));
    return;
  }
  for(const i of plan.issues.filter(i=>i.code==='token'))body.append(node('p','banner bad',i.text));
  if(status){
    const pw=node('span','small muted');
    body.append(put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','배포 중'),node('p','sub',status.alive?'웹 주소가 열려 있어요.':'올렸어요. 주소가 열리기까지 1~2분 걸릴 수 있어요.')),pill('웹에서 동작','ok')),
      put(node('div','row wrap'),link(status.url,status.url,'btn primary'),button('주소 복사',async()=>{try{await navigator.clipboard.writeText(status.url);toast('주소를 복사했어요.');}catch{toast('복사하지 못했어요. 주소를 직접 선택해 복사해 주세요.',true);}},'btn sm'),
        button('비밀번호 보기',async function(){await doing(this,async()=>{const r=await eng(`/api/bots/${b.id}/publish/password`,{method:'POST',body:{}});pw.textContent='비밀번호: '+r.password;});},'btn sm'),pw),
      node('p','small muted',`엔진: ${engineLabel(status.engine)} · 텔레그램: ${status.telegram?'웹이 받고 있어요(PC 수신은 꺼짐)':'PC가 받아요'} · 올린 때 ${new Date(status.deployedAt).toLocaleString('ko-KR')}`),
      put(node('div','row wrap'),status.telegram?button('텔레그램을 PC로 되돌리기',async function(){await doing(this,async()=>{await eng(`/api/bots/${b.id}/publish/restore-local`,{method:'POST',body:{}});toast('텔레그램 수신을 PC로 되돌렸어요. 이제 「켜기」를 누르면 PC가 받아요.');refresh();});},'btn sm'):null,
        button('배포 지우기…',async function(){if(!await confirmDialog({title:'웹 배포를 지울까요?',body:'Cloudflare 의 Worker 와 대화 기록 저장소를 지우고, 텔레그램 웹 연결도 풀어요. PC의 봇은 그대로 남아요.',ok:'지우기',danger:true}))return;await doing(this,async()=>{await eng(`/api/bots/${b.id}/publish`,{method:'DELETE',body:{}});toast('지웠어요.');refresh();});},'btn sm danger'))));
  }
  // 올리기 / 다시 올리기 양식
  const engines=plan.engines;
  const first=(status&&engines.find(e=>e.type===status.engine.type&&e.ready))||engines.find(e=>e.ready)||engines[0];
  let chosen=first.type;
  const engBox=node('div','engine-grid');
  const modelSlot=node('div');let getModel=()=> '';
  async function pickCloudEngine(type){
    chosen=type;
    engBox.querySelectorAll('.engine').forEach(e=>e.classList.toggle('on',e.dataset.type===type));
    let list=[];
    try{
      if(type==='workersai')list=plan.workersAiModels||[];
      else list=(await eng('/api/connections/models/'+type)).models;
    }catch{ /* 키가 없으면 목록이 비어 직접 입력 */ }
    const keep=status?.engine?.type===type?status.engine.model:'';
    if(list.length){const sel=select(list.map(m=>[m,m]),list.includes(keep)?keep:list[0]);getModel=()=>sel.value;modelSlot.replaceChildren(put(node('div','field'),node('label','','모델'),sel));}
    else{const i=input({maxLength:100,placeholder:type==='workersai'?'@cf/meta/…':'모델 이름',value:keep});getModel=()=>i.value.trim();modelSlot.replaceChildren(put(node('div','field'),node('label','','모델'),i));}
  }
  for(const e of engines){
    const el=node('button','engine');el.type='button';el.dataset.type=e.type;
    put(el,node('b','',e.label),e.ready?pill('바로 쓸 수 있어요','ok'):put(node('span','row nowrap'),pill('키가 필요해요','warn'),link('연결 허브 →','#hub','small')));
    el.addEventListener('click',()=>pickCloudEngine(e.type));engBox.append(el);
  }
  await pickCloudEngine(chosen);
  const name=input({value:status?.name||plan.suggestedName,maxLength:51});
  const pwIn=input({type:'text',maxLength:60,placeholder:plan.hasPassword?'비워 두면 지금 비밀번호 그대로':'8자 이상',value:plan.hasPassword?'':randomPassword(),autocomplete:'off'});
  const sub=plan.subdomain?null:input({placeholder:'예: my-lapis (영문 소문자·숫자·하이픈)',maxLength:40});
  const tgOn=node('input');tgOn.type='checkbox';tgOn.checked=Boolean(plan.telegram);tgOn.disabled=!plan.telegram;
  const prog=progressBox();
  const go=button(status?'다시 올리기':'웹으로 올리기',async function(){
    const e=engines.find(x=>x.type===chosen);
    if(!e.ready){toast('먼저 연결 허브에서 키를 연결해 주세요.',true);return;}
    const model=getModel();
    if(!model){toast('모델을 골라 주세요.',true);return;}
    if(!await confirmDialog({title:'내 Cloudflare 계정에 올릴까요?',body:`"${name.value}" 이름으로 Worker 를 올리고(주소: ${name.value}.${plan.subdomain||sub?.value||'…'}.workers.dev) 대화 기록용 KV 저장소를 만들어요. ${tgOn.checked?'텔레그램은 웹이 받도록 바꾸고 PC 수신은 멈춰요. ':''}Cloudflare 요금제 한도 안에서 쓰는 걸 권장해요.`,ok:'올리기'}))return;
    this.disabled=true;
    try{
      const job=await eng(`/api/bots/${b.id}/publish`,{method:'POST',body:{name:name.value.trim(),engine:{type:chosen,model},password:pwIn.value||undefined,subdomain:sub?.value.trim()||undefined,telegram:tgOn.checked}});
      prog.update(job);
      const done=await watchJob(job.id,j=>prog.update(j));
      if(done.state==='error')throw new Error(done.error);
      toast('올렸어요!');refresh();
    }catch(err){toast(errorText(err),true);}finally{this.disabled=false;}
  },'btn primary');
  put(body,put(node('section','card'),put(node('div','card-head'),node('h2','',status?'다시 올리기 (설정 바꾸기)':'올리기')),
    node('div','group-title','웹에서 쓸 AI'),engBox,modelSlot,
    field('웹 주소 이름',name,'주소는 이름.계정이름.workers.dev 가 돼요.'),
    sub?field('내 workers.dev 계정 이름 (처음 한 번)',sub,'Cloudflare 계정에 아직 없어서 만들어요.'):null,
    field('웹 접속 비밀번호',pwIn,plan.hasPassword?'바꾸려면 새 비밀번호를 적어요.':'웹 주소에 들어갈 때 쓰는 비밀번호예요. 자동으로 만들어 두었어요. 올린 뒤 「비밀번호 보기」로 다시 볼 수 있어요.'),
    put(node('label','row nowrap'),tgOn,node('span','',plan.telegram?'텔레그램도 웹으로 옮기기 (PC가 꺼져도 답해요)':'텔레그램 봇을 연결하면 텔레그램도 웹으로 옮길 수 있어요')),
    plan.note?node('p','banner info',plan.note):null,
    put(node('div','row'),go),prog.box));
}

registerPage('studio',{async show(sub){
  const view=root();view.replaceChildren(node('p','empty-line','불러오는 중…'));
  try{
    if(!sub)return await renderList();
    if(sub==='new')return await renderNew();
    return await renderDetail(sub);
  }catch(e){view.replaceChildren(node('p','banner bad','앱 엔진에 연결하지 못했어요: '+errorText(e)));}
}});
