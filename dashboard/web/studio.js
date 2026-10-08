// 봇 스튜디오: 봇을 하나든 여러 개든 만들고, 엔진·역할(에이전트)·텔레그램 방과 주제·스킬을 설정한다.
// LAPIS 봇(런타임)과 기존 Claude 사무실·Hermes 를 한 목록에서 본다.
import {q,node,put,button,pill,link,registerPage,toast,errorText,doing,confirmDialog,openDialog,input,textarea,field,select,api,fmtDate} from './ui.js';
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
const MODE_HELP={
  readonly:'보기만 해요. 스킬 목록을 보여 주고 스킬 설치만 도와요. 켜기·끄기나 설정 변경은 하지 않아요.',
  office:'이 프로그램이 이 봇 하나를 사무실처럼 맡아요(단일 사용). 켜고 끄기와 항상 켜두기를 도와요.',
};
const refreshAll=async()=>{await renderList();window.__office?.refresh?.();};
// 선택한 사무실을 사무실 화면(부서·설정 등)에서 열기
const openOffice=(id,hash)=>{window.__office?.select?.(id);go(hash);};

// 이름을 똑같이 입력해야 지워지는 삭제 창(실수 방지)
function removeDialog({title,body,name,run,done}){
  openDialog((box,close)=>{
    const typed=input({placeholder:name,autocomplete:'off',maxLength:80});typed.setAttribute('aria-label','확인용 이름');
    const ok=button('삭제하기',async function(){await doing(this,async()=>{const r=await run(typed.value.trim());close();toast(done(r));await refreshAll();});},'btn danger');
    ok.disabled=true;
    typed.addEventListener('input',()=>{ok.disabled=typed.value.trim()!==name;});
    put(box,put(node('div','dlg-head'),node('h2','',title),node('p','',body)),put(node('div','dlg-body'),field('확인을 위해 이름을 입력하세요',typed)),put(node('div','dlg-foot'),button('취소',close),ok));
    setTimeout(()=>typed.focus(),0);
  });
}
const removeBot=(b)=>removeDialog({title:`「${b.name}」 봇을 삭제할까요?`,name:b.name,
  body:'봇을 끄고 목록에서 없애요. 폴더는 지우지 않고 보관 위치로 옮기고, 텔레그램 토큰은 지워져요.',
  run:t=>eng(`/api/bots/${b.id}/close`,{method:'POST',body:{confirmName:t}}),done:()=>'봇을 삭제했어요. 폴더는 보관 위치에 있어요.'});
const removeOfficeBot=(o)=>removeDialog({title:`「${o.name}」 봇을 삭제할까요?`,name:o.name,
  body:(!o.readonly&&o.running?'지금 근무 중이라 먼저 퇴근시켜요. ':'')+(o.removeKind==='close'
    ?'목록에서 없애고 텔레그램 연결도 끊어요. 폴더는 지우지 않고 보관 위치로 옮겨 둬요.'
    :`이 프로그램의 목록에서만 없애요. 폴더와 파일은 그대로 두니(${o.folder}) 나중에 다시 불러올 수 있어요.`),
  run:t=>eng(`/api/offices/${o.id}/remove`,{method:'POST',body:{confirmName:t}}),
  done:r=>r.kind==='closed'?'봇을 삭제했어요. 폴더는 보관 위치로 옮겨 뒀어요.':'봇을 목록에서 삭제했어요. 폴더와 파일은 그대로예요.'});

// 불러온 사무실·Hermes 카드: 모드 · 켜기/끄기 · 항상 켜두기 · 설정 · 삭제를 카드 안에서 바로 한다.
function officeCard(o){
  const hermes=o.kind==='hermes',ro=Boolean(o.readonly);
  const c=node('article','card bot-card');
  const kind=hermes?(ro?'Hermes · 읽기 전용':'Hermes · 사무실용'):'Claude 사무실';
  const sub=hermes?(ro?'Hermes 봇 (읽기 전용으로 인식)':'Hermes 봇 (사무실용 · 단일 사용)'):'Claude 사무실 · 부서 '+o.teamsCount+'개';
  const run=(btn,fn)=>doing(btn,async()=>{await fn();await refreshAll();});
  put(c,put(node('div','card-head'),put(node('div'),node('h2','',o.name),node('p','sub',sub)),pill(kind,hermes&&ro?'warn':o.running?'ok':'accent')),
    put(node('div','row wrap'),pill(o.running?(ro?'가동 중':'근무 중'):'꺼짐',o.running?'ok':''),!hermes&&o.telegram?.set?pill('텔레그램 연결됨','ok'):null));
  if(hermes){
    const set=(mode)=>function(){if(mode===(o.mode||'readonly'))return;run(this,async()=>{await eng(`/api/offices/${o.id}`,{method:'PATCH',body:{mode}});toast(mode==='office'?'사무실용으로 바꿨어요. 이제 켜고 끌 수 있어요.':'읽기 전용으로 바꿨어요. 이제 보기만 해요.');});};
    const seg=put(node('div','row'),
      button('🔒 읽기 전용',set('readonly'),'btn sm'+(ro?' primary':'')),
      button('🏢 사무실용 · 단일 사용',set('office'),'btn sm'+(ro?'':' primary')));
    seg.setAttribute('role','group');seg.setAttribute('aria-label','사용 모드');
    put(c,node('div','group-title','사용 모드'),seg,node('p','small muted',MODE_HELP[ro?'readonly':'office']));
  }else put(c,node('p','small muted','이 프로그램이 직접 켜고 끄는 Claude 사무실이에요. 부서와 텔레그램 연결을 설정할 수 있어요.'));
  if(!ro){
    const auto=node('input');auto.type='checkbox';auto.checked=Boolean(o.autoStart);
    auto.addEventListener('change',()=>run(auto,async()=>{try{await eng(`/api/offices/${o.id}`,{method:'PATCH',body:{autoStart:auto.checked}});toast(auto.checked?'꺼져 있으면 다시 켜 드릴게요.':'자동으로 다시 켜지 않아요.');}catch(e){auto.checked=!auto.checked;throw e;}}));
    const lab=put(node('label','row nowrap small'),auto,node('span','','항상 켜두기'));lab.title='이 프로그램이 켜져 있는 동안 봇이 꺼져 있으면 다시 출근시켜요. 직접 퇴근시키면 다시 켜지 않아요.';
    put(c,put(node('div','row wrap'),
      o.running
        ?button('퇴근시키기',async function(){if(!await confirmDialog({title:'퇴근시킬까요?',body:'봇을 꺼요. 진행 중인 업무가 있으면 중단돼요.',ok:'퇴근시키기',danger:true}))return;run(this,async()=>{await eng(`/api/offices/${o.id}/stop`,{method:'POST',body:{}});toast('퇴근시켰어요.');});},'btn sm danger')
        :button('출근시키기',function(){run(this,async()=>{await eng(`/api/offices/${o.id}/start`,{method:'POST',body:{}});toast('출근시켰어요. 잠시 뒤 켜져요.');});},'btn sm primary'),
      lab),node('p','small muted',hermes?'「출근」은 Hermes 를 켜고, 「항상 켜두기」는 꺼졌을 때 이 프로그램이 다시 켜 줘요.':'「출근」은 텔레그램 지시를 받기 시작해요. 「항상 켜두기」는 꺼졌을 때 이 프로그램이 다시 켜 줘요.'));
  }
  const conns=o.connectors||[];
  if(o.exists!==false&&(hermes||!ro))put(c,put(node('div','row wrap'),button('🔌 커넥터'+(conns.length?' · '+conns.length:''),()=>connectorDialog(o),'btn sm'+(conns.length?'':' primary')),
    hermes?button('🧰 기능 · 활용범위',()=>hermesToolsDialog(o),'btn sm'):null,
    conns.length?node('span','small muted','연결됨: '+conns.join(', ')):node('span','small muted','구글 시트·문서·일정 같은 바깥 서비스를 봇에 연결해요')));
  const links=put(node('div','row wrap'));
  if(!hermes)links.append(button('부서 관리 →',()=>openOffice(o.id,'#teams'),'btn sm'),button('텔레그램 설정 →',()=>openOffice(o.id,'#connect'),'btn sm'));
  links.append(button('설정 →',()=>openOffice(o.id,'#settings'),'btn sm'),button('스킬 보기 →',()=>openOffice(o.id,'#skills'),'btn sm'));
  put(c,links,put(node('div','row'),button('삭제',()=>removeOfficeBot(o),'btn sm danger')));
  return c;
}

// ── 커넥터: 봇이 도구로 쓸 바깥 서비스(MCP) ──
const GOOGLE_HELP={
  off:'Google 기능을 쓰지 않아요.',
  read:'드라이브 검색·파일 읽기·시트 보기만 해요. 아무것도 바꾸지 않아요.',
  chat:'봇이 미리보기를 보여 주고, 채팅에서 "진행"이라고 하면 적용해요.',
  app:'봇이 미리보기를 만들면, 이 앱 「봇 스튜디오」의 승인 대기에서 내가 「승인」을 눌러야 적용돼요(가장 안전해요).',
};
const MASK='********';
const linesToMap=(text,sep)=>Object.fromEntries(text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{const i=l.indexOf(sep);if(i<1)throw new Error('「이름'+sep+'값」 모양으로 적어 주세요: '+l);return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const mapToLines=(m,sep)=>Object.entries(m||{}).map(([k,v])=>k+sep+(sep===':'?' ':'')+v).join('\n');
const CUSTOM_PRESETS=[
  {label:'GitHub',name:'github',url:'https://api.githubcopilot.com/mcp/',headers:'Authorization: Bearer 여기에_GitHub_토큰',hint:'GitHub 설정 → Developer settings → Personal access tokens 에서 만든 토큰을 넣어요.'},
  {label:'직접 입력 (주소)',name:'',url:'https://',headers:'',hint:'MCP 서버 주소와, 필요하면 인증 머리말을 적어요.'},
  {label:'직접 입력 (명령)',name:'',command:'npx',args:'-y\n패키지이름',hint:'이 PC에서 실행할 MCP 서버 명령이에요. 봇과 같은 권한으로 실행돼요.'},
];

async function restartOffer(o,r,box){
  box.replaceChildren();
  const hermes=o.kind==='hermes';
  if(!r.running){put(box,node('p','banner info','저장했어요. 다음에 '+(hermes?'Hermes 가 켜질':'출근할')+' 때부터 적용돼요.'));return;}
  if(!r.canRestart){put(box,node('p','banner warn','저장했어요. 이 Hermes 는 읽기 전용 모드라 이 앱이 끄고 켜지 않아요. Hermes 를 직접 다시 시작해야 적용돼요.'));return;}
  put(box,put(node('div','banner info'),node('span','','저장했어요. 봇이 지금 켜져 있어서 다시 시작해야 새 설정을 읽어요.'),
    button('지금 다시 시작',async function(){await doing(this,async()=>{await eng(`/api/offices/${o.id}/restart`,{method:'POST',body:{}});toast('잠시 뒤 다시 시작해요.');this.disabled=true;});},'btn sm primary')));
}

function customEditor(c){
  const box=node('div','mode-card');
  const name=input({value:c.name||'',maxLength:32,placeholder:'예: github'});
  const kind=select([['url','주소(URL)로 연결'],['command','이 PC에서 명령 실행']],c.command?'command':'url');
  const url=input({value:c.url||'',placeholder:'https://…/mcp'});
  const headers=textarea({rows:2,value:typeof c.headers==='string'?c.headers:mapToLines(c.headers,':'),placeholder:'Authorization: Bearer …'});
  const command=input({value:c.command||'',placeholder:'npx'});
  const args=textarea({rows:2,value:Array.isArray(c.args)?c.args.join('\n'):(c.args||''),placeholder:'한 줄에 하나씩'});
  const env=textarea({rows:2,value:typeof c.env==='string'?c.env:mapToLines(c.env,'='),placeholder:'API_KEY=…'});
  const urlBox=put(node('div','stack'),field('주소',url),field('머리말 (선택)',headers,'한 줄에 「이름: 값」. 저장된 값은 '+MASK+' 로 가려 보여요(그대로 두면 유지).'));
  const cmdBox=put(node('div','stack'),field('명령',command),field('인자 (선택)',args,'한 줄에 하나씩'),field('환경 값 (선택)',env,'한 줄에 「이름=값」. 저장된 값은 '+MASK+' 로 가려 보여요.'));
  const sync=()=>{urlBox.hidden=kind.value!=='url';cmdBox.hidden=kind.value!=='command';};
  kind.addEventListener('change',sync);sync();
  const remove=button('빼기',()=>box.remove(),'btn sm danger');
  put(box,put(node('div','top-row'),node('b','',c.name?'🔌 '+c.name:'새 커넥터'),remove),c.hint?node('p','small muted',c.hint):null,put(node('div','stack'),field('이름',name,'영어 소문자로 시작하는 2~32자'),field('연결 방식',kind),urlBox,cmdBox));
  box.read=()=>kind.value==='url'
    ?{name:name.value.trim(),url:url.value.trim(),headers:linesToMap(headers.value,':')}
    :{name:name.value.trim(),command:command.value.trim(),args:args.value.split(/\r?\n/).map(a=>a.trim()).filter(Boolean),env:linesToMap(env.value,'=')};
  return box;
}

async function connectorDialog(o){
  let d;
  try{d=await eng(`/api/offices/${o.id}/connectors`);}catch(e){toast(errorText(e),true);return;}
  openDialog((box,close)=>{
    const hermes=o.kind==='hermes';
    const on=node('input');on.type='checkbox';on.checked=d.lapis.enabled;
    const google=select(Object.entries(d.googleLevels),d.lapis.google);
    const ghelp=node('p','small muted',GOOGLE_HELP[google.value]);google.addEventListener('change',()=>{ghelp.textContent=GOOGLE_HELP[google.value];});
    const cal=node('input');cal.type='checkbox';cal.checked=d.lapis.calendar;
    const tasks=node('input');tasks.type='checkbox';tasks.checked=d.lapis.tasks;
    const lapisBody=put(node('div','stack'),field('Google (드라이브·시트·문서·슬라이드)',google),ghelp,
      put(node('label','row nowrap small'),cal,node('span','','LAPIS 일정 보기·추가')),
      put(node('label','row nowrap small'),tasks,node('span','','LAPIS 할 일 보기·추가·완료')),
      put(node('p','small muted'),'Google 기능은 이 앱이 라피스 계정에 로그인되어 있고 ',link('「내 계정 → Google 연결」','#account'),'에서 Drive·Sheets·Docs 를 켜 둬야 동작해요. 봇에게는 키를 주지 않고, 이 앱이 대신 호출해요.'));
    const card=node('div','mode-card'+(on.checked?' on':''));
    const syncOn=()=>{lapisBody.hidden=!on.checked;card.classList.toggle('on',on.checked);};on.addEventListener('change',syncOn);syncOn();
    const list=node('div','stack');
    for(const c of d.custom)list.append(customEditor(c));
    const addRow=put(node('div','row wrap'),node('span','small muted','추가:'),...CUSTOM_PRESETS.map(p=>button('＋ '+p.label,()=>list.append(customEditor(p)),'btn sm')));
    const after=node('div');
    const save=button('저장',async function(){
      await doing(this,async()=>{
        const custom=[...list.children].map(el=>el.read());
        const r=await eng(`/api/offices/${o.id}/connectors`,{method:'PUT',body:{lapis:{enabled:on.checked,google:google.value,calendar:cal.checked,tasks:tasks.checked},custom}});
        toast('커넥터를 저장했어요.');await restartOffer(o,r,after);refreshAll();
      });
    },'btn primary');
    put(card,put(node('div','top-row'),put(node('label','row nowrap'),on,node('b','','LAPIS 커넥터 (기본 제공)')),pill('추천','accent')),
      node('p','small muted','구글 시트에 직접 쓰기, 문서·슬라이드 만들기, 드라이브 찾기, 일정·할 일 등록을 봇이 텔레그램 지시로 할 수 있게 해요.'),lapisBody);
    put(box,put(node('div','dlg-head'),node('h2','','🔌 '+o.name+' · 커넥터'),node('p','','봇이 도구로 쓸 바깥 서비스를 연결해요. 적용 위치: '+d.appliedTo+(hermes&&d.office.readonly?' (읽기 전용 모드여도 이 설정만은 여기서 직접 바꿔요. 바꾸기 전 원본은 백업해 둬요)':''))),
      put(node('div','dlg-body'),put(node('div','stack'),card,
        node('div','group-title','직접 추가한 커넥터 (MCP 서버)'),list,addRow,
        node('p','small muted','바꾼 뒤에는 봇을 다시 시작해야 적용돼요. 직접 추가한 커넥터는 봇과 같은 권한으로 동작하니 믿을 수 있는 것만 넣으세요.'),
        after,activityBox(o))),
      put(node('div','dlg-foot'),button('닫기',close),save));
  },{wide:true});
}

function activityBox(o){
  const note=node('p','small muted','불러오는 중…');
  const box=put(node('div'),node('div','group-title','최근 사용 기록'),note);
  api('/api/connector/activity?bot='+encodeURIComponent(o.id)).then(r=>{
    if(!r.items.length){note.textContent='아직 이 봇이 LAPIS 커넥터를 쓴 기록이 없어요. (이 앱을 다시 켜면 기록이 비워져요)';return;}
    const ul=node('ul','guide');
    for(const it of r.items.slice(0,12))ul.append(node('li','',`${fmtDate(it.at)} · ${it.ok?'✓':'✗'} ${it.tool} — ${it.note}`));
    note.replaceWith(ul);
  }).catch(()=>{note.textContent='기록을 불러오지 못했어요.';});
  return box;
}

// ── Hermes 기능 · 활용범위: 텔레그램에서 쓸 기능 묶음과 한 번에 할 수 있는 단계 수 ──
async function hermesToolsDialog(o){
  let d;
  try{d=await eng(`/api/offices/${o.id}/hermes/tools`);}catch(e){toast(errorText(e),true);return;}
  openDialog((box,close)=>{
    // 칩의 체크는 office.js 의 전역 처리기가 change 없이 바꾸므로, 저장할 때 체크 상태를 직접 읽는다.
    const chips=node('div','chips');
    for(const t of d.toolsets){
      const l=node('label','chip'+(t.on?' on':''));const cb=node('input');cb.type='checkbox';cb.checked=t.on;cb.style.display='none';cb.dataset.key=t.key;
      put(l,cb,put(node('span'),node('b','',(t.risk?'⚠ ':'')+t.label),node('span','',t.desc+(t.risk?' — '+t.risk:''))));chips.append(l);
    }
    const turns=input({type:'number',min:d.turnsRange.min,max:d.turnsRange.max,value:d.maxTurns??''});
    const after=node('div');
    const save=button('저장',async function(){
      await doing(this,async()=>{
        const picked=new Set([...chips.querySelectorAll('input[type=checkbox]:checked')].map(cb=>cb.dataset.key));
        const risky=d.toolsets.filter(t=>t.risk&&picked.has(t.key)&&!t.on);
        let confirmRisk=false;
        if(risky.length){confirmRisk=await confirmDialog({title:'정말 켤까요?',body:risky.map(t=>t.label+': '+t.risk).join(' / ')+' 텔레그램으로 들어온 지시로 실행되니, 믿을 수 있는 사람만 봇을 쓰는 경우에만 켜세요.',ok:'켜기',danger:true});if(!confirmRisk)return;}
        const n=turns.value===''?undefined:Number(turns.value);
        const r=await eng(`/api/offices/${o.id}/hermes/tools`,{method:'PUT',body:{toolsets:d.toolsets.map(t=>t.key).filter(k=>picked.has(k)),maxTurns:n,confirmRisk}});
        if(!r.changed){toast('바뀐 것이 없어요.');return;}
        toast('Hermes 기능을 저장했어요.');d=r;await restartOffer(o,r,after);
      });
    },'btn primary');
    put(box,put(node('div','dlg-head'),node('h2','','🧰 '+o.name+' · 기능 · 활용범위'),node('p','','텔레그램에서 이 Hermes 가 쓸 수 있는 기능을 골라요. 바꾸기 전 config.yaml 원본은 이 앱의 데이터 폴더에 백업해 둬요.')),
      put(node('div','dlg-body'),put(node('div','stack'),
        d.explicit?null:node('p','banner info','지금은 Hermes 기본 기능 묶음을 쓰고 있어요. 여기서 저장하면 고른 기능만 쓰도록 바뀌어요.'),
        chips,
        field('한 번에 할 수 있는 단계 수',turns,`복잡한 일(시트 읽고 → 정리하고 → 쓰기)은 단계가 많이 필요해요. ${d.turnsRange.min}~${d.turnsRange.max}, 지금 ${d.maxTurns??'기본값'}. 늘리면 사용량도 늘어요.`),
        d.others.length?node('p','small muted','그대로 두는 항목(플러그인 등): '+d.others.join(', ')):null,
        node('p','small muted','구글 시트·문서·일정 같은 바깥 서비스는 「🔌 커넥터」에서 연결해요.'),
        after)),
      put(node('div','dlg-foot'),button('닫기',close),button('🔌 커넥터 열기',()=>connectorDialog(o),'btn'),save));
  },{wide:true});
}

// ── 승인 대기: 「앱에서 승인」으로 둔 봇의 Google 변경 ──
async function pendingCard(){
  let items=[];
  try{items=(await api('/api/connector/pending')).items;}catch{return null;}
  if(!items.length)return null;
  const card=put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','✋ 승인 대기 '+items.length+'건'),node('p','sub','봇이 Google 시트·문서를 바꾸려고 해요. 내용을 보고 승인하면 바로 적용돼요. 10분이 지나면 만료돼요.'))));
  for(const it of items){
    const row=put(node('div','mode-card'),put(node('div','top-row'),node('b','',it.botName+' · '+it.summary),node('span','small muted',fmtDate(it.createdAt)+' 요청')),node('pre','mk-pre',it.detail||''));
    const done=(msg)=>{toast(msg);renderList();};
    if(it.status==='waiting')put(row,put(node('div','row'),
      button('승인하고 적용',async function(){await doing(this,async()=>{const r=await api(`/api/connector/pending/${it.id}/approve`,{method:'POST',body:{}});done('적용했어요.'+(r.item.result?.updatedCells!=null?' '+r.item.result.updatedCells+'칸':''));});},'btn sm primary'),
      button('거절',async function(){await doing(this,async()=>{await api(`/api/connector/pending/${it.id}/reject`,{method:'POST',body:{}});done('거절했어요. 봇에게도 알려져요.');});},'btn sm danger')));
    else put(row,node('p','small muted','적용하는 중이에요…'));
    card.append(row);
  }
  return card;
}

async function renderList(){
  const [d,ov,pend]=await Promise.all([loadMeta(),eng('/api/overview').catch(()=>({offices:[]})),pendingCard()]);
  const head=put(node('div','row between wrap'),node('p','view-intro','봇은 하나만 써도, 여러 개를 만들어 역할별로 나눠도 돼요. 봇마다 두뇌(AI)와 역할, 텔레그램 방을 따로 정해요.'),put(node('div','row'),button('Claude 사무실(고급) 만들기',()=>document.querySelector('#newOffice')?.click(),'btn'),link('＋ 새 봇 만들기','#studio/new','btn primary')));
  const grid=node('div','grid cols-2');
  for(const b of d.bots){
    const c=node('article','card bot-card');
    const st=b.telegram.set?pill('텔레그램 @'+(b.telegram.username||'연결됨'),'ok'):pill('텔레그램 연결 필요','warn');
    put(c,put(node('div','card-head'),put(node('div'),node('h2','',b.name),node('p','sub',engineLabel(b.engine))),pill('LAPIS 봇','accent')),
      put(node('div','row wrap'),pill(`역할 ${b.agents}개`),pill(`방 ${b.rooms}개`),st),
      node('p','small muted','LAPIS 앱이 직접 돌리는 봇이에요. 두뇌(AI)·역할·텔레그램 방을 자유롭게 정해요.'),
      put(node('div','row'),link('설정 열기','#studio/'+b.id,'btn primary sm'),button('삭제',()=>removeBot(b),'btn sm danger')));
    grid.append(c);
  }
  for(const o of ov.offices||[])grid.append(officeCard(o));
  if(!d.bots.length&&!(ov.offices||[]).length)grid.append(put(node('div','friendly-empty'),node('h3','','아직 봇이 없어요'),node('p','','「새 봇 만들기」로 1분 만에 첫 봇을 만들어 보세요.')));
  const legend=put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','봇 종류와 사용 모드'),node('p','sub','카드의 배지가 무엇을 뜻하는지 한눈에 볼 수 있어요.'))),
    put(node('ul','guide'),
      node('li','','LAPIS 봇 — 이 앱이 직접 돌려요. 두뇌(AI)·역할·텔레그램 방과 주제를 모두 여기서 정해요.'),
      node('li','','Claude 사무실 — Claude Code 로 돌아가는 사무실이에요. 부서와 텔레그램을 설정하고, 켜고 끌 수 있어요.'),
      node('li','','Hermes · 읽기 전용 — 스스로 일하는 별개의 봇이에요. 이 앱은 보기만 하고 스킬 설치만 도와요(가장 안전해요).'),
      node('li','','Hermes · 사무실용(단일 사용) — 이 앱이 그 봇 하나를 사무실처럼 맡아 켜고 끄고 항상 켜두기까지 해요. 같은 텔레그램 봇 토큰을 다른 곳에서 동시에 쓰지 마세요.'),
      node('li','','🔌 커넥터 — Claude 사무실과 Hermes 에 구글 시트·문서·드라이브, LAPIS 일정·할 일, 직접 고른 MCP 서버를 도구로 연결해요. 🧰 기능 — Hermes 가 텔레그램에서 쓸 기능(웹·예약 작업·기억·사진 보기 등)을 골라요.'),
      node('li','','삭제 — 이 앱이 만든 봇은 폴더를 보관 위치로 옮기고, 불러온 봇은 파일을 그대로 두고 목록에서만 없애요. 이름을 입력해야 지워져요.')));
  root().replaceChildren(...[head,pend,grid,legend].filter(Boolean));
}

// ── 새 봇 ──
async function renderNew(){
  await loadMeta();
  const st={name:'',engine:'',persona:''};
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
    const l=node('label','chip');const cb=node('input');cb.type='checkbox';cb.style.display='none';cb.dataset.key=p.key;
    put(l,cb,put(node('span'),node('b','',p.emoji+' '+p.name),node('span','',p.role)));chips.append(l);
  }
  const persona=textarea({rows:3,maxLength:4000,placeholder:'비워 두면 기본 비서 지침을 써요. 예: 친근한 말투로, 항상 한 줄 요약부터.'});persona.setAttribute('aria-label','봇 성격과 지침');
  const make=button('봇 만들기',async function(){
    await doing(this,async()=>{
      // 체크 상태는 office.js 의 전역 처리기가 change 없이 바꾸므로 여기서 직접 읽는다.
      const presets=[...chips.querySelectorAll('input[type=checkbox]:checked')].map(cb=>cb.dataset.key);
      const body={name:name.value.trim(),engine:{type:st.engine,model:picker.get()},presets,persona:persona.value.trim()||undefined};
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
  const danger=put(node('section','card'),put(node('div','card-head'),put(node('div'),node('h2','','봇 삭제'),node('p','sub','폴더는 지우지 않고 보관 위치로 옮겨요. 텔레그램 토큰은 지워져요. 이름을 입력해야 지워져요.'))),
    button('이 봇 삭제…',()=>removeDialog({title:`「${b.name}」 봇을 삭제할까요?`,name:b.name,body:'봇을 끄고 목록에서 없애요. 폴더는 지우지 않고 보관 위치로 옮기고, 텔레그램 토큰은 지워져요.',
      run:t=>eng(`/api/bots/${b.id}/close`,{method:'POST',body:{confirmName:t}}),done:()=>{go('#studio');return '봇을 삭제했어요. 폴더는 보관 위치에 있어요.';}}),'btn danger'));
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
