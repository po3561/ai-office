// 라피스 학습: 라피스가 나에 대해 기억하는 것(보기·추가·정정), 스스로 정리한 교훈, 학습 데이터 준비 상태와 모델 학습 작업.
import {q,qa,node,put,button,pill,emptyLine,friendly,cloud,toast,doing,errorText,fmtDate,openDialog,confirmDialog,field,select,textarea,registerPage} from './ui.js';
import {session,refreshSession,loginPrompt} from './account.js';

const STATUS={CONFIRMED:['확인됨','ok'],OBSERVED:['들은 것','accent'],INFERRED:['추측',''],DISPUTED:['이견 있음','warn'],RETRACTED:['정정됨','']};
const CATEGORY={episodic:'있었던 일',semantic:'지식',procedural:'방법',preference:'선호',relationship:'관계',project:'프로젝트',decision:'결정',behavioral:'행동 패턴',goal:'목표',experience:'경험',skill:'기술',reflection:'되돌아봄'};
let category='all',memories=[];

async function render(){
  const box=q('#learning-body');box.replaceChildren();
  if(!session.loaded)await refreshSession();
  if(!session.signedIn){box.append(loginPrompt('라피스가 기억하고 배운 것을 보려면 라피스 계정으로 로그인하세요.'));return;}
  const memoryCard=node('div','card'),mindCard=node('div','card'),trainCard=node('div','card');
  box.append(memoryCard,mindCard,trainCard);
  renderMemories(memoryCard);renderMind(mindCard);renderTraining(trainCard);
}

// ── 기억 ──
async function renderMemories(card){
  card.replaceChildren(emptyLine('기억을 불러오는 중…'));
  try{memories=(await cloud('GET','/memories')).memories||[];}catch(error){card.replaceChildren(node('p','banner warn','기억을 읽지 못했습니다: '+errorText(error)));return;}
  paintMemories(card);
}
function paintMemories(card){
  card.replaceChildren();
  const visible=memories.filter(m=>m.status!=='RETRACTED'&&(category==='all'||m.category===category));
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','라피스가 나에 대해 아는 것'),node('p','sub','대화하면서 라피스가 기억하게 된 내용이에요. 틀린 것은 정정하면 이전 기록은 남기고 새 내용으로 바뀝니다.')),button('＋ 직접 알려주기',()=>teachDialog(card),'btn primary')));
  const cats=[...new Set(memories.map(m=>m.category).filter(Boolean))];
  if(cats.length){const tabs=node('div','tabs');for(const [id,name] of [['all','전체'],...cats.map(c=>[c,CATEGORY[c]||c])]){const b=button(name,()=>{category=id;paintMemories(card);},id===category?'on':'');tabs.append(b);}card.append(tabs);}
  if(!visible.length){card.append(friendly('아직 기억한 내용이 없어요','라피스와 대화하거나 위의 「직접 알려주기」로 가르칠 수 있어요.'));return;}
  const list=node('div','memory-list');
  for(const m of visible){
    const [label,cls]=STATUS[m.status]||[m.status||'확인 안 됨',''];
    const row=node('article','memory');
    const conf=node('div','meter');const bar=node('i');bar.style.width=Math.round((Number(m.confidence)||0)*100)+'%';conf.append(bar);conf.title='확신 정도 '+Math.round((Number(m.confidence)||0)*100)+'%';
    put(row,put(node('div','row between wrap'),put(node('div','row'),pill(label,cls),m.category?pill(CATEGORY[m.category]||m.category):null),node('small','muted',fmtDate(m.updated_at||m.created_at,{year:'2-digit',month:'numeric',day:'numeric'}))),
      node('p','memory-text',m.claim||m.content),m.claim&&m.content&&m.claim!==m.content?node('p','small muted',m.content):null,
      put(node('div','row between'),conf,button('정정',()=>correctDialog(m,card),'btn sm ghost')));
    list.append(row);
  }
  card.append(list);
}
function teachDialog(card){
  openDialog((box,close)=>{
    const content=textarea({rows:4,maxLength:2000,placeholder:'예: 나는 회의록을 항상 개조식으로 받고 싶어.'});
    const cat=select(Object.entries(CATEGORY),'preference');
    const save=button('기억시키기',null,'btn primary');
    save.addEventListener('click',()=>doing(save,async()=>{
      if(!content.value.trim())throw new Error('알려줄 내용을 입력해 주세요.');
      await cloud('POST','/memories',{content:content.value.trim(),category:cat.value,confidence:0.8,status:'OBSERVED'});
      close();toast('라피스가 기억했어요.');renderMemories(card);
    }));
    put(box,put(node('div','dlg-head'),node('h2','','라피스에게 알려주기'),node('p','','내가 직접 말해 준 내용으로 기록돼요. 나중에 언제든 정정할 수 있어요.')),put(node('div','dlg-body'),put(node('div','stack'),field('내용',content),field('종류',cat))),put(node('div','dlg-foot'),button('취소',close),save));
  });
}
function correctDialog(memory,card){
  openDialog((box,close)=>{
    const content=textarea({rows:4,maxLength:2000,value:memory.claim||memory.content});
    const reason=node('input');reason.type='text';reason.maxLength=200;reason.placeholder='왜 바꾸나요? (예: 사실과 달라서)';
    const save=button('정정하기',null,'btn primary');
    save.addEventListener('click',()=>doing(save,async()=>{
      if(!content.value.trim()||!reason.value.trim())throw new Error('바꿀 내용과 이유를 입력해 주세요.');
      await cloud('POST','/memories/'+encodeURIComponent(memory.id)+'/retract',{change_reason:reason.value.trim(),replacement:{category:memory.category||'preference',content:content.value.trim(),claim:content.value.trim(),confidence:1,status:'OBSERVED'}});
      close();toast('정정했습니다. 이전 기록은 보관돼요.');renderMemories(card);
    }));
    put(box,put(node('div','dlg-head'),node('h2','','기억 정정하기')),put(node('div','dlg-body'),put(node('div','stack'),field('올바른 내용',content),field('이유',reason))),put(node('div','dlg-foot'),button('취소',close),save));
  });
}

// ── 스스로 정리한 것 ──
async function renderMind(card){
  card.replaceChildren(emptyLine('라피스의 자기 정리를 불러오는 중…'));
  let data;
  try{data=await cloud('GET','/core-link/consciousness');}
  catch(error){card.replaceChildren(put(node('div','card-head'),put(node('div'),node('h2','','라피스가 스스로 정리한 것'),node('p','sub','이 정보는 에디터가 라피스 Core와 연결돼 있을 때 제공됩니다. ('+errorText(error)+')'))));return;}
  const model=data.self_model||{};
  card.replaceChildren(put(node('div','card-head'),put(node('div'),node('h2','','라피스가 스스로 정리한 것'),node('p','sub','대화와 실패에서 배운 교훈, 할 수 있는 일을 라피스가 스스로 정리한 내용이에요.')),data.generated_at?node('small','muted',fmtDate(data.generated_at)):null));
  const columns=node('div','grid cols-3');
  for(const [title,list,empty] of [['배운 교훈',model.learned_lessons,'아직 정리된 교훈이 없어요.'],['할 수 있는 일',model.capabilities,'정리된 능력이 없어요.'],['최근 실수',model.recent_failures,'최근 실수가 없어요. 👍']]){
    const col=node('div','mind-col');col.append(node('div','group-title',title));
    if(list?.length){const ul=node('ul','mind-list');list.slice(0,8).forEach(t=>ul.append(node('li','',t)));col.append(ul);}else col.append(node('p','small muted',empty));
    columns.append(col);
  }
  card.append(columns);
}

// ── 학습 데이터·모델 ──
const LABELS={usable:'쓸 수 있는 학습 예제',total:'전체 대화 조각',skipped:'제외한 것',lessons:'교훈 예제',meetsMinimum:'최소 기준 충족',meetsRecommended:'권장 기준 충족'};
async function renderTraining(card){
  card.replaceChildren(emptyLine('학습 준비 상태를 확인하는 중…'));
  let ready,jobs;
  try{[ready,jobs]=await Promise.all([cloud('GET','/training/readiness'),cloud('GET','/training/fine-tune/jobs')]);}
  catch(error){
    card.replaceChildren(put(node('div','card-head'),put(node('div'),node('h2','','학습 데이터와 모델'),node('p','sub',error.status===403?'관리자 권한이 있는 계정에서만 볼 수 있는 기능이에요.':'불러오지 못했습니다: '+errorText(error)))));return;
  }
  const stats=ready.dataset||{};
  const kv=node('div','stats');
  for(const [key,value] of Object.entries(stats)){
    if(!(typeof value==='number'||typeof value==='boolean'))continue;
    kv.append(put(node('div','stat'),node('b','',typeof value==='boolean'?(value?'예':'아니오'):value.toLocaleString('ko-KR')),node('span','',LABELS[key]||key)));
  }
  const start=button('모델 학습 시작',null,'btn primary');
  start.addEventListener('click',async()=>{
    if(!await confirmDialog({title:'모델 학습을 시작할까요?',body:'지금까지 모인 대화·교훈으로 파인튜닝 작업을 외부 AI 서비스에 제출합니다. 사용료가 발생할 수 있고 되돌릴 수 없어요. 계속할까요?',ok:'학습 시작'}))return;
    await doing(start,async()=>{const r=await cloud('POST','/training/fine-tune',{});toast(r.note?'학습 작업을 제출했습니다.':'학습 작업을 제출했습니다.');renderTraining(card);});
  });
  const download=node('a','btn');download.href='/api/cloud/training/dataset.jsonl';download.textContent='학습 데이터 내려받기 (.jsonl)';download.download='lapis-training.jsonl';
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','학습 데이터와 모델'),node('p','sub',ready.next_step||'라피스 대화가 쌓이면 학습 데이터가 만들어져요.'))),kv,
    ready.thresholds?node('p','small muted','최소 '+ready.thresholds.minimum+'건 · 권장 '+ready.thresholds.recommended+'건'):null,
    ready.note?node('p','banner info',ready.note):null,put(node('div','row'),download,start));
  const list=jobs.jobs||[];
  card.append(node('div','group-title','학습 작업 기록'));
  if(!list.length)card.append(node('p','small muted','아직 제출한 학습 작업이 없어요.'));
  else{
    const table=node('table','tbl');
    table.append(put(node('tr'),...['상태','결과 모델','시작'].map(h=>node('th','',h))));
    for(const j of list.slice(0,10))table.append(put(node('tr'),node('td','',j.status||'확인 안 됨'),node('td','mono',j.fine_tuned_model||'—'),node('td','',fmtDate(j.created_at||j.started_at))));
    card.append(table);
  }
  if(jobs.note)card.append(node('p','small muted',jobs.note));
}

registerPage('learning',{show(){render();}});
