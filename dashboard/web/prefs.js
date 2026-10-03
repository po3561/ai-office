// 화면 설정(테마·강조색·밀도·글자 크기·메뉴 구성·시작 화면)과 빠른 이동(Ctrl+K). 설정은 이 브라우저에 저장된다.
import {q,qa,node,put,button,pill,registerPage,toast,select,field} from './ui.js';

const KEY='lapis.prefs.v1';
const DEFAULTS={accent:'default',density:'normal',font:'normal',hidden:[],start:'home'};
const LOCKED=['home','appearance'];   // 숨길 수 없는 화면
export const THEMES=[['light','화이트 · 하늘색','밝은 배경에 하늘색 포인트'],['dark','블랙 · 그레이','완전한 블랙에 회색 면'],['auto','시스템 따라가기','Windows 설정에 맞춰 자동']];
export const ACCENTS=[['default','기본'],['blue','파랑'],['violet','보라'],['green','초록'],['rose','분홍'],['amber','주황']];

export function loadPrefs(){
  try{const p=JSON.parse(localStorage.getItem(KEY)||'{}');return {...DEFAULTS,...p,hidden:Array.isArray(p.hidden)?p.hidden.filter(x=>typeof x==='string'):[]};}
  catch{return {...DEFAULTS};}
}
function savePrefs(p){try{localStorage.setItem(KEY,JSON.stringify(p));}catch{toast('이 브라우저에 설정을 저장하지 못했어요.',true);}}
export function applyPrefs(p=loadPrefs()){
  const r=document.documentElement;
  r.setAttribute('data-accent',p.accent);r.setAttribute('data-density',p.density);r.setAttribute('data-font',p.font);
}
export function currentTheme(){try{return localStorage.getItem('theme')||'light';}catch{return 'light';}}
export function setTheme(pref){
  try{localStorage.setItem('theme',pref);}catch{}
  document.documentElement.setAttribute('data-theme',pref);
  const btn=q('#themeBtn');if(btn)btn.textContent={auto:'◐',light:'☀',dark:'☾'}[pref]||'☀';
}
export function applyNavPrefs(){
  const {hidden}=loadPrefs();
  qa('#nav .nav-item').forEach(a=>{a.hidden=hidden.includes(a.dataset.nav)&&!LOCKED.includes(a.dataset.nav);});
  // 항목이 모두 숨겨진 묶음의 제목도 숨긴다.
  qa('#nav .nav-group').forEach(g=>{let n=g.nextElementSibling,any=false;while(n&&!n.classList.contains('nav-group')){if(!n.hidden)any=true;n=n.nextElementSibling;}g.hidden=!any;});
}
export const startView=()=>{const s=loadPrefs().start;return qa('#nav .nav-item').some(a=>a.dataset.nav===s)?s:'home';};

function update(patch){const next={...loadPrefs(),...patch};savePrefs(next);applyPrefs(next);applyNavPrefs();return next;}

function segmented(options,current,onPick,label){
  const row=node('div','tabs');row.setAttribute('role','group');row.setAttribute('aria-label',label);
  for(const [id,name] of options)row.append(button(name,()=>{onPick(id);qa('button',row).forEach(b=>b.classList.toggle('on',b.dataset.id===id));},current===id?'on':'')),row.lastChild.dataset.id=id;
  return row;
}
function render(){
  const box=q('#appearance-body');box.replaceChildren();
  const p=loadPrefs();

  const themeCard=node('div','card');
  put(themeCard,put(node('div','card-head'),put(node('div'),node('h2','','테마'),node('p','sub','화면의 기본 색을 고르세요. 바로 적용되고 이 브라우저에 기억돼요.'))));
  const picks=node('div','theme-picks');
  for(const [id,name,desc] of THEMES){
    const card=node('button','theme-card'+(currentTheme()===id?' on':''));card.type='button';card.dataset.themePick=id;
    card.innerHTML=`<span class="theme-preview t-${id}"><i></i><i></i><i></i></span>`;
    put(card,node('b','',name),node('small','muted',desc));
    card.addEventListener('click',()=>{setTheme(id);qa('.theme-card',picks).forEach(c=>c.classList.toggle('on',c===card));});
    picks.append(card);
  }
  themeCard.append(picks);

  const lookCard=node('div','card');
  put(lookCard,put(node('div','card-head'),put(node('div'),node('h2','','나에게 맞게'),node('p','sub','색, 간격, 글자 크기를 내 눈에 편하게 맞추세요.'))));
  const accents=node('div','swatches big');
  for(const [id,name] of ACCENTS){const b=button('',()=>{update({accent:id});qa('.swatch',accents).forEach(x=>x.classList.toggle('on',x===b));},'swatch a-'+id+(p.accent===id?' on':''));b.title=name;b.setAttribute('aria-label',name+' 강조색');accents.append(b);}
  put(lookCard,put(node('div','setting'),put(node('div'),node('b','','강조색'),node('span','sub','버튼과 선택 표시에 쓰는 색')),accents),
    put(node('div','setting'),put(node('div'),node('b','','화면 밀도'),node('span','sub','촘촘하게 하면 한 화면에 더 많이 보여요')),segmented([['comfortable','넉넉하게'],['normal','보통'],['compact','촘촘하게']],p.density,id=>update({density:id}),'화면 밀도')),
    put(node('div','setting'),put(node('div'),node('b','','글자 크기'),node('span','sub','화면 전체의 크기를 조절해요')),segmented([['small','작게'],['normal','보통'],['large','크게']],p.font,id=>update({font:id}),'글자 크기')));

  const navCard=node('div','card');
  put(navCard,put(node('div','card-head'),put(node('div'),node('h2','','메뉴 구성'),node('p','sub','자주 안 쓰는 메뉴는 숨겨서 왼쪽 메뉴를 간단하게 만드세요. 숨겨도 Ctrl+K로 언제든 열 수 있어요.')),button('모두 보이기',()=>{update({hidden:[]});render();},'btn sm')));
  const list=node('div','nav-toggles');
  qa('#nav .nav-item').forEach(a=>{
    const id=a.dataset.nav,name=a.querySelector('span:not(.nav-extra)')?.textContent||id,locked=LOCKED.includes(id);
    const label=node('label','toggle'+(locked?' locked':''));
    const cb=node('input');cb.type='checkbox';cb.checked=!loadPrefs().hidden.includes(id);cb.disabled=locked;
    cb.addEventListener('change',()=>{const hidden=new Set(loadPrefs().hidden);if(cb.checked)hidden.delete(id);else hidden.add(id);update({hidden:[...hidden]});});
    put(label,cb,node('span','',name),locked?pill('고정'):null);list.append(label);
  });
  navCard.append(list);
  const start=select(qa('#nav .nav-item').filter(a=>!a.hidden).map(a=>[a.dataset.nav,a.querySelector('span:not(.nav-extra)')?.textContent||a.dataset.nav]),p.start);
  start.addEventListener('change',()=>update({start:start.value}));
  put(navCard,put(node('div','setting'),put(node('div'),node('b','','시작 화면'),node('span','sub','대시보드를 처음 열 때 보이는 화면')),start));

  const keys=node('div','card');
  put(keys,node('h2','','단축키'),put(node('table','tbl'),...[['Ctrl + K','빠른 이동 · 명령 찾기'],['/','검색창으로 이동'],['Esc','열린 창 닫기']].map(([k,d])=>put(node('tr'),put(node('td'),node('span','code',k)),node('td','',d)))));
  box.append(themeCard,lookCard,navCard,keys);
}

// ── 빠른 이동(Ctrl+K) ──
const ACTIONS=[
  ['새 일정 만들기',()=>{location.hash='#calendar';setTimeout(()=>q('#cal-add')?.click(),250);}],
  ['할 일 추가하기',()=>{location.hash='#home';setTimeout(()=>q('#task-title')?.focus(),250);}],
  ['테마 바꾸기 (화이트 ↔ 블랙)',()=>setTheme(currentTheme()==='dark'?'light':'dark')],
  ['전체 새로고침',()=>q('#refresh')?.click()],
];
function openPalette(){
  const dlg=q('#palette');if(dlg.open)return;
  const input=q('#palette-input'),list=q('#palette-list');input.value='';let items=[],index=0;
  const build=()=>{
    const term=input.value.trim().toLowerCase();
    items=[...qa('#nav .nav-item').map(a=>({label:a.querySelector('span:not(.nav-extra)')?.textContent||a.dataset.nav,hint:'이동',run:()=>{location.hash='#'+a.dataset.nav;}})),...ACTIONS.map(([label,run])=>({label,hint:'실행',run}))]
      .filter(i=>!term||i.label.toLowerCase().includes(term));
    index=Math.min(index,Math.max(items.length-1,0));list.replaceChildren();
    items.forEach((item,i)=>{const row=node('li',i===index?'on':'');put(row,node('span','',item.label),node('small','muted',item.hint));row.addEventListener('click',()=>{dlg.close();item.run();});list.append(row);});
    if(!items.length)list.append(node('li','muted','찾는 항목이 없어요.'));
  };
  input.oninput=()=>{index=0;build();};
  input.onkeydown=e=>{
    if(e.key==='ArrowDown'){e.preventDefault();index=Math.min(index+1,items.length-1);build();}
    else if(e.key==='ArrowUp'){e.preventDefault();index=Math.max(index-1,0);build();}
    else if(e.key==='Enter'&&items[index]){e.preventDefault();dlg.close();items[index].run();}
  };
  build();dlg.showModal();input.focus();
}
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();return;}
  const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
  if(e.key==='/'&&!typing&&!e.ctrlKey&&!e.metaKey&&!document.querySelector('dialog[open]')){e.preventDefault();q('#global-query')?.focus();}
});

applyPrefs();
registerPage('appearance',{show:render});
export {render as renderAppearance};
