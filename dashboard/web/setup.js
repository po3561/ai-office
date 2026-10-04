// 시작 마법사: ① 필요한 도구 설치 ② 계정 연결 ③ 첫 봇 만들기. 터미널 없이 버튼만으로 끝낸다.
import {q,node,put,button,pill,link,registerPage,toast,errorText,confirmDialog} from './ui.js';
import {eng,watchJob,progressBox,componentRow,installComponent,markSetupDone,setupDone} from './platform.js';

// 엔진별 묶음: 무엇을 하고 싶은지만 고르면 필요한 도구가 정해진다.
const PACKS=[
  {id:'claude',title:'Claude 사무실',desc:'Claude 계정으로 일하는 가장 강력한 봇. 파일·도구까지 씁니다.',need:['claude','bun'],badge:'추천'},
  {id:'local',title:'내 PC 로컬 AI',desc:'무료로 내 PC에서 돌리는 AI. 인터넷 없이도 됩니다.',need:['ollama']},
  {id:'gpt',title:'GPT (ChatGPT 계정)',desc:'ChatGPT 로그인으로 GPT를 봇의 두뇌로 씁니다.',need:['codex']},
  {id:'hermes',title:'Hermes',desc:'스스로 배우는 개인 비서 에이전트.',need:['hermes']},
];
let state={components:[],packs:new Set(['claude']),model:'llama3.2:3b',busy:false};

async function load(){
  try{state.components=(await eng('/api/components?fresh=1')).components;}
  catch(e){q('#setup-body').replaceChildren(node('p','banner bad','앱 엔진에 연결하지 못했어요: '+errorText(e)));return false;}
  return true;
}
const byId=id=>state.components.find(c=>c.id===id);
const missing=()=>[...new Set([...state.packs].flatMap(p=>PACKS.find(x=>x.id===p).need))].filter(id=>!byId(id)?.installed);

function stepCard(n,title,sub,status,body){
  const card=node('section','card setup-step');
  const head=put(node('div','card-head'),put(node('div','row nowrap'),node('span','step-n'+(status==='ok'?' done':''),status==='ok'?'✓':String(n)),put(node('div'),node('h2','',title),node('p','sub',sub))),
    status==='ok'?pill('완료','ok'):status==='todo'?pill('할 일','accent'):null);
  put(card,head,body);return card;
}

function installStep(){
  const box=node('div','stack');
  const packs=node('div','pack-grid');
  for(const p of PACKS){
    const ready=p.need.every(id=>byId(id)?.installed);
    const label=node('label','pack'+(state.packs.has(p.id)?' on':''));
    const cb=node('input');cb.type='checkbox';cb.checked=state.packs.has(p.id);
    cb.addEventListener('change',()=>{cb.checked?state.packs.add(p.id):state.packs.delete(p.id);render();});
    put(label,cb,put(node('div'),put(node('div','row nowrap'),node('b','',p.title),p.badge?pill(p.badge,'accent'):null,ready?pill('준비됨','ok'):null),node('p','small muted',p.desc)));
    packs.append(label);
  }
  box.append(packs);
  const todo=missing();
  const list=node('div','comp-list');
  const rows=new Map();
  for(const c of state.components){
    if(![...state.packs].some(p=>PACKS.find(x=>x.id===p).need.includes(c.id)))continue;
    const r=componentRow(c,{onInstall:async(id,prog)=>{await installComponent(id,prog);await load();render();toast(byId(id).name+' 설치를 마쳤어요.');}});
    rows.set(c.id,r);list.append(r.row);
  }
  if(rows.size)box.append(list);
  if(state.packs.has('local')){
    const om=node('div','card inner');
    const input=node('input');input.type='text';input.value=state.model;input.setAttribute('aria-label','내려받을 모델 이름');input.maxLength=60;
    const prog=progressBox();
    const pull=button('모델 내려받기',async()=>{
      pull.disabled=true;
      try{const job=await eng('/api/ollama/pull',{method:'POST',body:{name:input.value.trim()}});prog.update(job);const done=await watchJob(job.id,j=>prog.update(j));if(done.state==='error')throw new Error(done.error);toast('모델을 받았어요: '+input.value.trim());}
      catch(e){toast(errorText(e),true);}finally{pull.disabled=false;}
    },'btn sm');
    put(om,put(node('div'),node('b','','로컬 AI 모델'),node('p','small muted','Ollama 를 설치한 뒤 쓸 모델을 받습니다. 가벼운 llama3.2:3b(약 2GB)를 추천해요. 용량이 커도 괜찮다면 qwen2.5:7b 도 좋아요.')),put(node('div','row'),input,pull),prog.box);
    box.append(om);
  }
  const go=button(todo.length?`선택한 것 모두 설치 (${todo.length}개)`:'모두 준비됐어요',async()=>{
    if(!todo.length)return;
    if(!await confirmDialog({title:'설치를 시작할까요?',body:todo.map(id=>byId(id).name+' '+byId(id).size).join(' · ')+' — 공식 사이트에서 내려받아 설치합니다. 시간이 걸릴 수 있어요.',ok:'설치 시작'}))return;
    go.disabled=true;
    for(const id of todo){
      const r=rows.get(id);
      try{await installComponent(id,r?.prog);}catch(e){toast(`${byId(id).name}: ${errorText(e)}`,true);break;}
    }
    await load();render();
  },'btn primary');
  go.disabled=!todo.length;
  box.append(put(node('div','row'),go,link('연결 허브에서 더 보기 →','#hub','small')));
  return stepCard(1,'필요한 도구 설치','쓰고 싶은 것만 고르세요. 나중에 언제든 더 설치할 수 있어요.',todo.length?'todo':'ok',box);
}

async function connectStep(){
  let s={};
  try{s=await eng('/api/connections');}catch{}
  const rows=node('div','stack');
  const row=(title,ok,detail,action)=>put(node('div','conn-row'),put(node('div'),put(node('div','row nowrap'),node('b','',title),ok?pill('연결됨','ok'):pill('연결 안 됨')),node('p','small muted',detail)),action);
  const claude=s.claude||{};
  rows.append(row('Claude',claude.loggedIn,claude.loggedIn?(claude.email||'로그인됨'):claude.installed?'Claude 계정으로 로그인하세요.':'먼저 위에서 Claude Code 를 설치하세요.',
    claude.installed&&!claude.loggedIn?button('로그인',async()=>{try{await eng('/api/claude/login',{method:'POST',body:{method:'claudeai'}});toast('열린 창에서 로그인을 끝내고, 이 화면으로 돌아와 「다시 확인」을 눌러 주세요.');}catch(e){toast(errorText(e),true);}},'btn sm primary'):null));
  const gpt=s.gpt?.codex||{};
  rows.append(row('GPT',gpt.loggedIn||s.gpt?.apiKey?.set,gpt.loggedIn?gpt.method:s.gpt?.apiKey?.set?'OpenAI API 키 연결됨':'ChatGPT 계정으로 로그인하거나 API 키를 넣으세요.',
    link('연결 허브에서 설정 →','#hub','btn sm')));
  rows.append(row('Google (라피스 계정)',false,'캘린더·드라이브·문서를 쓰려면 라피스 계정으로 로그인하세요. 건너뛰어도 돼요.',link('계정 · Google →','#account','btn sm')));
  rows.append(put(node('div','row'),button('다시 확인',()=>render(),'btn sm')));
  const ok=claude.loggedIn||gpt.loggedIn||s.gpt?.apiKey?.set;
  return stepCard(2,'계정 연결','쓰는 AI 계정에 로그인해요. 비밀번호는 이 앱이 받지 않고, 각 서비스의 공식 로그인 창을 엽니다.',ok?'ok':'todo',rows);
}

function botStep(bots){
  const body=node('div','stack');
  body.append(node('p','sub',bots?`만든 봇 ${bots}개가 있어요. 더 만들거나 설정을 바꿀 수 있어요.`:'이름과 두뇌(AI)만 정하면 첫 봇이 만들어져요. 텔레그램 연결도 안내해 드려요.'));
  body.append(put(node('div','row'),link(bots?'봇 스튜디오 열기':'첫 봇 만들기 →','#studio/new','btn primary'),
    button('나중에 할게요',()=>{markSetupDone();location.hash='#home';},'btn ghost')));
  return stepCard(3,'첫 봇 만들기','봇은 하나만 써도, 여러 개를 만들어 역할별로 나눠도 돼요.',bots?'ok':'todo',body);
}

async function render(){
  const root=q('#setup-body');
  if(!state.components.length&&!await load())return;
  const keep=root.scrollTop;
  let bots=0;try{bots=(await eng('/api/bots')).bots.length;}catch{}
  const hero=put(node('div','hero setup-hero'),put(node('div'),node('p','eyebrow','LAPIS 시작하기'),node('h2','','세 단계면 끝나요'),node('p','sub','터미널은 필요 없어요. 버튼만 누르면 설치하고 연결해 드립니다.')));
  root.replaceChildren(hero,installStep(),await connectStep(),botStep(bots));
  if(!missing().length&&bots)markSetupDone();
  root.scrollTop=keep;
}

registerPage('setup',{show(){state.components=[];render();}});
export const needsSetup=()=>!setupDone();
