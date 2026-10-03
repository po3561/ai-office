// LAPIS 통합 화면: 메뉴·이동, 개인 업무(할 일·업무 흐름·자료·메모), 텔레그램 수신함, 라피스 대화, 물품 대여.
// 사무실(Claude Office) 화면은 office.js 가 같은 페이지 안에서 직접 그린다.
import {createWorkspaceStore,validateLink,progress,TEMPLATES,SERVICES,STORAGE_KEY} from './workspace-model.js';
import {pages} from './ui.js';
import './account.js';import './storage.js';import './learning.js';import './chat.js';import './calendar.js';
import {applyNavPrefs,startView} from './prefs.js';

const q=s=>document.querySelector(s);
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
const put=(parent,...children)=>{parent.append(...children.filter(Boolean));return parent;};
const link=(text,href,cls='')=>{const a=node('a',cls,text);a.href=href;if(href.startsWith('https://')){a.target='_blank';a.rel='noopener noreferrer';a.title='새 탭에서 열기';}return a;};
const button=(text,action,cls='btn')=>{const b=node('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
const empty=(title,detail,href,label)=>{const box=node('div','friendly-empty');put(box,node('h3','',title),detail?node('p','',detail):null);if(href)box.append(link(label,href,'small'));return box;};
const emptyLine=text=>node('p','empty-line',text);
const pill=(text,cls='')=>node('span','pill '+cls,text);
const errorText=e=>typeof e==='string'?e:e?.message||'연결 상태를 확인하지 못했습니다.';
const time=v=>{if(!v)return '기록 없음';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);};
const count=v=>Number.isFinite(Number(v))?Number(v).toLocaleString('ko-KR'):'—';

// ── 메뉴 ──
const ICONS={
  home:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  flows:'<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  library:'<path d="M5 4h11a3 3 0 0 1 3 3v13l-4-3H5z"/><path d="M5 4v13"/>',
  board:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  teams:'<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.4c1.9.8 3 2.6 3 5.6"/>',
  skills:'<circle cx="12" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M12 7.5V12M12 12l-5 5M12 12l5 5"/>',
  market:'<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a2.67 2.67 0 0 1-5.33 0 2.67 2.67 0 0 1-5.34 0A2.67 2.67 0 0 1 4 11z"/><path d="M5 13.5V20h14v-6.5"/>',
  inbox:'<path d="M21 4L3 11l7 2.5L12.5 21z"/><path d="M10 13.5L21 4"/>',
  chat:'<path d="M4 5h16v11H9l-5 4z"/><path d="M9 10h6"/>',
  rental:'<path d="M3 8l9-5 9 5-9 5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  drive:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  connect:'<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  learning:'<path d="M12 3l9 5-9 5-9-5z"/><path d="M7 11v5c0 1.5 2.2 3 5 3s5-1.5 5-3v-5"/>',
  account:'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  storage:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  appearance:'<circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 3a9 9 0 0 1 0 18"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};
const GROUPS=[
  {title:'업무',items:[['home','오늘'],['calendar','캘린더'],['flows','업무 흐름'],['library','자료 모음']]},
  {title:'사무실',items:[['board','현황판'],['teams','부서 관리'],['skills','봇 · 스킬트리'],['market','스킬 마켓']]},
  {title:'라피스',items:[['chat','라피스 대화'],['learning','라피스 학습'],['account','계정 · Google']]},
  {title:'연결',items:[['storage','저장소'],['drive','드라이브'],['inbox','텔레그램 수신함'],['rental','물품 대여']]},
  {title:'관리',items:[['connect','Claude · 텔레그램'],['settings','설정'],['appearance','화면 설정']]},
];
const OFFICE_VIEWS=['board','teams','skills','market','connect','settings','drive'];
const TITLES={search:'검색'};
GROUPS.forEach(g=>g.items.forEach(([id,label])=>{TITLES[id]=label;}));
const nav=q('#nav');
for(const group of GROUPS){
  nav.append(node('div','nav-group',group.title));
  for(const [id,label] of group.items){
    const a=node('a','nav-item');a.href='#'+id;a.dataset.nav=id;
    a.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;
    a.append(node('span','',label),node('span','nav-extra'));
    nav.append(a);
  }
}
function paintNavExtras(detail){
  if(!detail)return;
  const set=(id,html)=>{const slot=nav.querySelector(`[data-nav="${id}"] .nav-extra`);if(slot)slot.innerHTML=html;};
  set('teams',detail.teams!=null?`<span class="count">${detail.teams}</span>`:'');
  set('skills',`<span class="count">${detail.skills}</span>`);
  set('market',detail.market?`<span class="count" title="업데이트 있는 스킬 · 봇의 게시 요청">${detail.market}</span>`:'');
  set('connect',detail.connectFlag?'<i class="flag"></i>':'');
  set('drive',detail.drives?`<span class="count">${detail.drives}</span>`:'');
}
document.addEventListener('office:chrome',e=>paintNavExtras(e.detail));
paintNavExtras(window.__officeChrome);

// ── 이동 ──
function route(){
  const [requested='home',sub]=location.hash.slice(1).split('/');
  const name=requested==='search'||TITLES[requested]?requested:'home';
  const officeView=OFFICE_VIEWS.includes(name);
  const target=officeView?'office':name;
  if(!document.getElementById('view-'+target))return;
  document.querySelectorAll('.view').forEach(v=>{v.hidden=v.id!=='view-'+target;});
  nav.querySelectorAll('.nav-item').forEach(a=>{if(a.dataset.nav===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  q('#title').textContent=TITLES[name];
  document.title=TITLES[name]+' · LAPIS';
  document.body.classList.remove('menu-open');
  if(officeView||name==='home')window.__office?.setView(name);
  pages[name]?.show?.(sub);
  if(name==='rental'){const f=q('#rental-frame');if(!f.getAttribute('src'))f.src=f.dataset.src;}
  if(name==='flows')renderFlowDetail(sub);
  if(name==='search')renderSearch();
  document.getElementById('main').scrollTo?.(0,0);window.scrollTo(0,0);
}
window.addEventListener('hashchange',route);
q('#menuBtn').addEventListener('click',()=>document.body.classList.toggle('menu-open'));
q('#scrim').addEventListener('click',()=>document.body.classList.remove('menu-open'));

// ── 개인 업무 저장소 ──
let store;
try{store=createWorkspaceStore(localStorage);}catch{store=createWorkspaceStore({getItem(){throw Error();}});}
let taskFilter='open',resourceFilter='all',resourceQuery='',undo=null,noteDirty=false,undoTimer=0;
function notify(text,restore=null){
  q('#undo-text').textContent=text;q('#undo-toast').hidden=false;q('#undo-run').hidden=!restore;undo=restore;
  clearTimeout(undoTimer);undoTimer=setTimeout(()=>{q('#undo-toast').hidden=true;undo=null;},restore?8000:3500);
}
function showStorageWarning(){q('#storage-warning').hidden=!store.error;q('#storage-warning').textContent=store.error||'';}
function save(next,message,restore=null){
  try{store.save(next);render();if(message)notify(message,restore);return true;}
  catch(error){showStorageWarning();render();notify(error.message);return false;}
}
function removeItem(kind,id){
  const item=store.value[kind].find(x=>x.id===id);if(!item)return;
  const next=store.value;next[kind]=next[kind].filter(x=>x.id!==id);
  save(next,kind==='flows'?'업무 흐름을 목록에서 지웠습니다.':'목록에서 지웠습니다.',()=>{const current=store.value;if(!current[kind].some(x=>x.id===item.id)){current[kind].unshift(item);save(current,'다시 복원했습니다.');}});
}
function changeTask(id,done){const next=store.value;const task=next.tasks.find(t=>t.id===id);if(task){task.done=done;save(next);}}

function renderTasks(){
  const tasks=store.value.tasks;q('#task-count').textContent=tasks.filter(t=>!t.done).length;
  const list=q('#task-list');list.replaceChildren();
  const selected=tasks.filter(t=>taskFilter==='all'||t.done===(taskFilter==='done'));
  for(const task of selected){
    const row=node('div','task-row'+(task.done?' completed':''));const label=node('label','task-label');
    const check=node('input');check.type='checkbox';check.checked=task.done;check.addEventListener('change',()=>changeTask(task.id,check.checked));
    put(label,check,node('span','',task.title));
    const del=button('×',()=>removeItem('tasks',task.id),'remove-button');del.setAttribute('aria-label',task.title+' 삭제');
    put(row,label,del);list.append(row);
  }
  if(!selected.length)list.append(empty(taskFilter==='done'?'완료한 일이 여기 모여요':'오늘의 첫 할 일을 적어보세요',taskFilter==='done'?'끝낸 일을 체크하면 이곳에서 확인할 수 있어요.':'작은 일부터 하나씩. 위 입력칸에서 바로 추가할 수 있어요.'));
}
function serviceIcon(service){return put(node('span','app-icon '+service.color),node('b','',service.icon));}
function resourceCard(item,compact=false){
  const service=SERVICES.find(s=>s.id===validateLink(item.url).service);
  const card=node('article',compact?'resource-row':'resource-card');
  const a=link('',item.url,'resource-open');
  put(a,serviceIcon(service),put(node('div','resource-text'),node('h3','',item.title),node('small','',service.name+' · 저장한 링크')),node('span','external-arrow','↗'));
  card.append(a);
  if(!compact){const del=button('삭제',()=>removeItem('resources',item.id),'btn sm ghost');del.setAttribute('aria-label',item.title+' 삭제');card.append(del);}
  return card;
}
function renderResources(){
  const resources=store.value.resources;
  const list=q('#resource-list');list.replaceChildren();
  const selected=resources.filter(r=>(resourceFilter==='all'||validateLink(r.url).service===resourceFilter)&&r.title.toLocaleLowerCase().includes(resourceQuery.toLocaleLowerCase()));
  selected.forEach(r=>list.append(resourceCard(r)));
  if(!selected.length)list.append(empty(resources.length?'조건에 맞는 자료가 없어요':'자주 찾는 자료를 가까이 두세요',resources.length?'다른 검색어나 자료 종류를 선택하세요.':'시트나 영상의 링크를 위에서 저장하면 이곳에 모입니다.'));
  const home=q('#home-resources');home.replaceChildren();
  resources.slice(0,4).forEach(r=>home.append(resourceCard(r,true)));
  if(!resources.length)home.append(empty('찾던 링크, 여기에 모아보세요','매번 검색하던 시트와 문서를 바로 열 수 있어요.','#library','＋ 첫 자료 저장하기'));
}
function flowCard(flow){
  const template=TEMPLATES.find(t=>t.id===flow.template);const card=node('article','card flow-card');const done=progress(flow);
  put(card,put(node('div','row between'),put(node('span','app-icon sky'),node('b','',template.icon)),pill(done===100?'완료':'진행 중',done===100?'ok':'accent')),
    link(flow.title,'#flows/'+flow.id,'flow-title'),node('p','small muted',template.category));
  const meter=node('div','meter');meter.append(node('i'));meter.firstChild.style.width=done+'%';meter.setAttribute('role','img');meter.setAttribute('aria-label',flow.title+' 진행률 '+done+'%');
  put(card,meter,put(node('div','row between'),node('small','muted',done+'% 완료'),link('이어서 하기 →','#flows/'+flow.id,'small')));
  return card;
}
function startFlow(templateId){
  const template=TEMPLATES.find(t=>t.id===templateId);if(!template)return;
  const next=store.value;const flow={id:crypto.randomUUID(),title:template.title,template:template.id,completed:[],createdAt:new Date().toISOString()};
  next.flows.unshift(flow);if(save(next,'새 업무 흐름을 만들었습니다.'))location.hash='flows/'+flow.id;
}
function renderFlows(){
  const flows=store.value.flows;
  const active=q('#active-flows');active.replaceChildren();flows.forEach(f=>active.append(flowCard(f)));
  if(!flows.length)active.append(empty('첫 업무 흐름을 시작해 보세요','아래에서 지금 필요한 템플릿을 골라주세요.'));
  const home=q('#home-flows');home.replaceChildren();
  const open=flows.filter(f=>progress(f)<100);open.slice(0,2).forEach(f=>home.append(flowCard(f)));
  if(!open.length){
    home.append(node('p','small muted',flows.length?'진행 중인 업무를 모두 마쳤어요. 다음 업무를 골라보세요.':'오늘 필요한 업무를 골라 시작해 보세요.'));
    for(const template of TEMPLATES.slice(0,2)){
      const row=button('',()=>startFlow(template.id),'suggested-flow');
      put(row,put(node('span','app-icon sky'),node('b','',template.icon)),put(node('span','suggested-body'),node('strong','',template.title),node('small','',template.steps.length+'단계 · '+template.category)),node('span','','→'));
      home.append(row);
    }
  }
  renderFlowDetail();
}
function renderFlowDetail(forcedId){
  const [page,hashId]=location.hash.slice(1).split('/');const id=forcedId||hashId;
  const box=q('#flow-detail');box.hidden=true;box.replaceChildren();
  if(page!=='flows'||!id)return;
  const flow=store.value.flows.find(f=>f.id===id);if(!flow)return;box.hidden=false;
  const template=TEMPLATES.find(t=>t.id===flow.template);
  put(box,put(node('div','card-head'),put(node('div'),node('h2','',flow.title),node('p','sub','각 도구에서 작업한 뒤 완료를 체크하세요. 다음에 와도 진행 상황이 남아 있어요.')),button('목록에서 삭제',()=>{removeItem('flows',flow.id);location.hash='flows';},'btn sm danger')));
  template.steps.forEach((step,index)=>{
    const row=node('div','workflow-step'+(flow.completed.includes(index)?' step-done':''));
    const check=node('input');check.type='checkbox';check.checked=flow.completed.includes(index);check.setAttribute('aria-label',step.title+' 완료');
    check.addEventListener('change',()=>{const next=store.value;const current=next.flows.find(f=>f.id===flow.id);current.completed=check.checked?[...new Set([...current.completed,index])]:current.completed.filter(i=>i!==index);save(next);});
    put(row,node('span','step-number',String(index+1)),put(node('div','step-content'),node('h3','',step.title),node('p','small muted',step.detail)),link(step.action+(step.href.startsWith('https://')?' ↗':' →'),step.href,'btn sm'),check);
    box.append(row);
  });
  box.append(node('p','small muted',progress(flow)+'% 완료 · 직접 체크한 진행 기록'));
}
function renderSearch(){
  const query=q('#global-query').value.trim().toLocaleLowerCase();const box=q('#search-results');box.replaceChildren();let hits=0;
  for(const [kind,label,href] of [['tasks','할 일','#home'],['resources','자료',null],['flows','업무 흐름',null]])
    for(const item of store.value[kind])if(query&&item.title.toLocaleLowerCase().includes(query)){
      const target=kind==='resources'?item.url:kind==='flows'?'#flows/'+item.id:href;
      put(box,put(node('div','search-result'),pill(label),link(item.title,target,'search-title')));hits++;
    }
  q('#search-summary').textContent=query?'“'+q('#global-query').value.trim()+'” · '+hits+'개 결과 · 이 브라우저에 저장한 내용':'할 일·자료·업무 흐름의 이름을 검색하세요.';
  if(!hits)box.append(empty(query?'일치하는 업무가 없어요':'찾고 싶은 업무를 입력하세요','상단 검색창에서 저장한 이름으로 찾아보세요.'));
}
function render(){renderTasks();renderResources();renderFlows();renderSearch();if(!noteDirty)q('#quick-note').value=store.value.note;}

// 바로가기 타일
function tile(href,iconNode,title,sub){const a=link('',href,'quick-tool');put(a,iconNode,node('strong','',title),node('small','',sub));return a;}
const officeIcon=(g)=>{const s=node('span','app-icon sky');s.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[g]}</svg>`;return s;};
q('#quick-tools').append(tile('#calendar',officeIcon('calendar'),'캘린더','일정 관리'),tile('#board',officeIcon('board'),'현황판','사무실 · 부서'));
for(const service of SERVICES)q('#quick-tools').append(tile(service.url,serviceIcon(service),service.short,'서비스 열기 ↗'));
q('#quick-tools').append(tile('#storage',officeIcon('storage'),'저장소','내 PC · Drive'),tile('#rental',officeIcon('rental'),'물품 관리','대여 · 반납'));
for(const service of SERVICES){
  const a=link('',service.url,'quick-tool');put(a,serviceIcon(service),node('strong','',service.name),node('small','',service.description));
  q('#google-services').append(a);
}
for(const template of TEMPLATES){
  const card=node('article','card template-card');
  put(card,put(node('span','app-icon sky'),node('b','',template.icon)),node('small','muted',template.category),node('h3','',template.title),node('p','small muted',template.description),node('p','small step-preview',template.steps.map(s=>s.title).join(' → ')),button('이 업무 시작하기 →',()=>startFlow(template.id),'btn sm'));
  q('#workflow-templates').append(card);
}
for(const [id,name] of [['all','전체'],...SERVICES.map(s=>[s.id,s.short])]){
  const b=button(name,()=>{resourceFilter=id;document.querySelectorAll('[data-resource-filter]').forEach(x=>x.classList.toggle('on',x.dataset.resourceFilter===id));renderResources();},'');
  b.dataset.resourceFilter=id;b.classList.toggle('on',id==='all');q('#resource-filters').append(b);
}

q('#task-form').addEventListener('submit',event=>{
  event.preventDefault();const title=q('#task-title').value.trim();if(!title)return;
  const next=store.value;next.tasks.unshift({id:crypto.randomUUID(),title,done:false});
  if(save(next,'할 일을 추가했습니다.')){q('#task-title').value='';taskFilter='open';document.querySelectorAll('[data-task-filter]').forEach(b=>b.classList.toggle('on',b.dataset.taskFilter==='open'));renderTasks();}
});
document.querySelectorAll('[data-add-task]').forEach(b=>b.addEventListener('click',()=>{location.hash='home';q('#task-title').focus();q('#task-form').scrollIntoView({block:'center',behavior:'smooth'});}));
document.querySelectorAll('[data-task-filter]').forEach(b=>b.addEventListener('click',()=>{taskFilter=b.dataset.taskFilter;document.querySelectorAll('[data-task-filter]').forEach(x=>x.classList.toggle('on',x===b));renderTasks();}));
q('#resource-form').addEventListener('submit',event=>{
  event.preventDefault();const error=q('#resource-error');error.hidden=true;
  try{
    const title=q('#resource-title').value.trim();if(!title)throw Error('자료 이름을 입력해 주세요.');
    const data=validateLink(q('#resource-url').value);const next=store.value;
    if(next.resources.some(r=>r.url===data.url))throw Error('이미 저장한 링크입니다.');
    next.resources.unshift({id:crypto.randomUUID(),title,...data,createdAt:new Date().toISOString()});
    if(save(next,'자료 링크를 저장했습니다.'))event.target.reset();
  }catch(e){error.textContent=e.message;error.hidden=false;}
});
q('#resource-query').addEventListener('input',e=>{resourceQuery=e.target.value;renderResources();});
q('#note-form').addEventListener('submit',event=>{
  event.preventDefault();const next=store.value;next.note=q('#quick-note').value;
  if(save(next,'메모를 저장했습니다.')){noteDirty=false;q('#note-status').textContent='저장됨 · '+new Intl.DateTimeFormat('ko-KR',{hour:'2-digit',minute:'2-digit'}).format(new Date());}
});
q('#quick-note').addEventListener('input',()=>{noteDirty=true;q('#note-status').textContent='아직 저장하지 않은 변경사항';});
q('#workspace-search').addEventListener('submit',event=>{event.preventDefault();if(location.hash==='#search')renderSearch();else location.hash='search';});
q('#global-query').addEventListener('input',()=>{if(location.hash==='#search')renderSearch();});
q('#undo-close').addEventListener('click',()=>{q('#undo-toast').hidden=true;undo=null;});
q('#undo-run').addEventListener('click',()=>{const restore=undo;undo=null;q('#undo-toast').hidden=true;if(restore)restore();});
window.addEventListener('storage',event=>{if(event.key===STORAGE_KEY){store=createWorkspaceStore(localStorage);showStorageWarning();render();}});

// ── 통합 서버 조회: 물품 재고 · 텔레그램 기록 ──
const state={telegram:null,stock:null,filter:'all',search:'',refreshing:false};
async function api(path,options={}){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),options.method==='POST'?190000:20000);
  try{
    const response=await fetch(path,{...options,signal:controller.signal,credentials:'same-origin'});
    const data=await response.json();
    if(!response.ok)throw new Error(errorText(data.error||data.message||'요청 실패 ('+response.status+')'));
    return data;
  }finally{clearTimeout(timer);}
}
function renderStock(overview){
  const box=q('#stock-list');box.replaceChildren();
  const ok=overview?.stock?.ok===true&&overview?.stock?.data?.ok!==false;
  const items=overview?.stock?.data?.items;
  if(!overview)return box.append(emptyLine('재고 상태를 불러오지 못했습니다. 새로고침으로 다시 시도하세요.'));
  if(!ok)return box.append(emptyLine('재고 연결 확인 필요 · '+errorText(overview.stock?.error)));
  if(!Array.isArray(items)||!items.length)return box.append(emptyLine('공개 재고 목록이 비어 있습니다.'));
  items.slice(0,6).forEach(item=>{
    const name=item.name||item.item_name||item.title||item.id||'이름 없는 물품';
    const available=item.available??item.available_qty??item.available_quantity??item.stock??item.quantity;
    put(box,put(node('div','stock-item'),put(node('div'),node('b','',name),node('small','muted',item.category||item.category_name||'대여 물품')),node('strong','',available==null?'수량 미제공':count(available)+'개')));
  });
  box.append(node('p','small muted','공개 목록 '+items.length+'개 중 '+Math.min(items.length,6)+'개 · 상세는 물품 대여에서 확인하세요.'));
}
const botNames={kao:'카오',lapis:'라피스'};
function messageRow(message,compact=false){
  const outgoing=['assistant','bot','outgoing','reply'].includes(message.role);
  const row=node('article',compact?'msg compact':'msg');
  put(row,put(node('div','msg-meta'),pill(botNames[message.botId]||message.botId||'봇',message.botId==='kao'?'accent':''),node('span','small muted',outgoing?'응답 기록':message.role==='user'||message.role==='incoming'?'수신':message.role||'기록'),node('time','',time(message.at))),
    node('p',compact?'msg-text clamp':'msg-text',message.text||'(텍스트 없음)'));
  if(!compact)row.append(node('p','small muted',[message.chatId?'방 '+message.chatId:'',message.threadId?'주제 '+message.threadId:'',message.source?'출처 '+message.source:''].filter(Boolean).join(' · ')));
  return row;
}
function renderInbox(){
  const list=q('#inbox-list');list.replaceChildren();
  const query=state.search.toLocaleLowerCase('ko-KR');
  const messages=(state.telegram?.messages||[]).filter(m=>(state.filter==='all'||m.botId===state.filter)&&(!query||String(m.text||'').toLocaleLowerCase('ko-KR').includes(query)));
  q('#inbox-count').textContent=messages.length+'개 기록';
  messages.forEach(m=>list.append(messageRow(m)));
  if(!messages.length)list.append(emptyLine(state.search?'검색어와 일치하는 메시지가 없습니다.':'표시할 메시지 기록이 없습니다.'));
}
function renderTelegram(){
  const data=state.telegram;if(!data)return;
  const cards=q('#bot-cards');cards.replaceChildren();
  (data.bots||[]).forEach(bot=>{
    const card=node('article','card');
    const times=node('dl','bot-times');
    [['마지막 수신 기록',bot.lastReceivedAt],['마지막 응답 기록',bot.lastRecordedReplyAt],['원본 갱신',bot.sourceUpdatedAt]].forEach(([name,value])=>put(times,node('dt','',name),node('dd','',time(value))));
    put(card,put(node('div','card-head'),put(node('div'),node('p','small muted',bot.id==='kao'?'CLAUDE OFFICE':'HERMES · LAPIS'),node('h2','',bot.name||botNames[bot.id]||bot.id)),pill(bot.running?'수신 중':'수신 확인 필요',bot.running?'ok':'warn')),
      node('p','small',bot.username?'@'+String(bot.username).replace(/^@/,''):'봇 정보 없음'),node('p','small muted',bot.detail||bot.status||'상태 정보 없음'),times);
    cards.append(card);
  });
  if(!(data.bots||[]).length)cards.append(emptyLine('봇 상태를 확인하지 못했습니다.'));
  const errors=q('#telegram-errors');errors.replaceChildren();
  (data.errors||[]).forEach(e=>errors.append(node('p','banner warn',errorText(e))));
  const recent=q('#recent-messages');recent.replaceChildren();
  const messages=Array.isArray(data.messages)?data.messages:[];
  messages.slice(0,3).forEach(m=>recent.append(messageRow(m,true)));
  if(!messages.length)recent.append(emptyLine('표시할 수신 기록이 없습니다.'));
  renderInbox();
}
async function refresh(){
  if(state.refreshing||document.hidden)return;
  state.refreshing=true;q('#refresh').disabled=true;
  const results=await Promise.allSettled([api('/api/overview'),api('/api/telegram')]);
  if(results[0].status==='fulfilled'){state.stock=results[0].value;renderStock(state.stock);}
  else if(!state.stock)renderStock(null);
  if(results[1].status==='fulfilled'){state.telegram=results[1].value;renderTelegram();}
  else{
    q('#telegram-errors').replaceChildren(node('p','banner warn','수신 기록 조회 실패 · '+errorText(results[1].reason)+(state.telegram?' · 아래는 마지막 조회 기록입니다.':'')));
    if(!state.telegram){q('#recent-messages').replaceChildren(emptyLine('수신 기록을 불러오지 못했습니다.'));q('#bot-cards').replaceChildren(emptyLine('봇 상태를 불러오지 못했습니다. 새로고침으로 다시 시도하세요.'));}
  }
  state.refreshing=false;q('#refresh').disabled=false;
}
document.querySelectorAll('[data-bot]').forEach(b=>b.addEventListener('click',()=>{state.filter=b.dataset.bot;document.querySelectorAll('[data-bot]').forEach(x=>x.classList.toggle('on',x===b));renderInbox();}));
q('#message-search').addEventListener('input',e=>{state.search=e.target.value;renderInbox();});
q('#refresh').addEventListener('click',()=>{refresh();window.__office?.refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});

// ── 라피스(Hermes) 대화 ──
q('#hermes-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const message=q('#hermes-message').value.trim();if(!message)return;
  const submit=q('#hermes-submit');submit.disabled=true;submit.textContent='응답 대기 중…';
  const output=q('#hermes-result');output.hidden=false;output.classList.remove('is-error');output.textContent='요청을 전송했습니다. 처리 결과를 기다리고 있습니다.';
  try{const data=await api('/api/hermes/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Lapis-Request':'1'},body:JSON.stringify({message})});output.textContent=data.text||'응답 본문이 없습니다. 실행 결과를 확인하세요.';}
  catch(error){output.classList.add('is-error');output.textContent='요청 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 않습니다. '+errorText(error);}
  finally{submit.disabled=false;submit.textContent='요청 보내기 →';}
});

// ── 물품 대여 화면에 현재 테마를 맞춘다 ──
function syncFrameTheme(){
  const frame=q('#rental-frame');
  try{const doc=frame.contentDocument;if(doc)doc.documentElement.setAttribute('data-theme',document.documentElement.getAttribute('data-theme')||'light');}catch{}
}
q('#rental-frame').addEventListener('load',syncFrameTheme);
new MutationObserver(syncFrameTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});

q('#today').textContent=new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',weekday:'short'}).format(new Date());
document.addEventListener('cloud:state',e=>{
  const box=q('#home-hint');box.replaceChildren();
  if(!e.detail.signedIn){const card=node('div','banner info');put(card,node('span','ic','✨'),put(node('div','txt'),node('b','','라피스 계정을 연결해 보세요'),node('span','muted','Google 드라이브·시트, 라피스의 기억과 학습을 함께 쓸 수 있어요.')),link('로그인 →','#account','btn sm primary'));box.append(card);}
});
applyNavPrefs();
if(!location.hash)location.replace('#'+startView());
showStorageWarning();render();route();refresh();setInterval(refresh,10000);
