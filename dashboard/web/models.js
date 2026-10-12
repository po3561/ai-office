// 로컬 AI 모델 장터(연결 허브의 「로컬 AI」 카드): 실시간 모델 목록을 3D 카드 덱으로 보여 주고,
// 고르면 설치(Ollama 설치 → 엔진 켜기 → 모델 받기)·기본 모델 지정까지 한 번에 한다. 다시 설치·삭제·바꾸기도 여기서.
import {node,put,button,pill,input,select,toast,errorText,confirmDialog,doing} from './ui.js';
import {eng,watchJob,progressBox} from './platform.js';

// 용도별 색과 그림. 카드의 첫 용도가 색을 정한다.
const KIND={
  light:{icon:'⚡',name:'가볍고 빠름',a:'#22c55e',b:'#15803d'},
  work:{icon:'💬',name:'일상 업무',a:'#3b9bf0',b:'#1d4ed8'},
  vision:{icon:'🖼️',name:'사진 보기',a:'#14b8c4',b:'#0e7490'},
  code:{icon:'💻',name:'코딩',a:'#fb923c',b:'#c2410c'},
  think:{icon:'🧠',name:'깊이 생각',a:'#a855f7',b:'#6d28d9'},
  tools:{icon:'🛠️',name:'봇 도구',a:'#ec4899',b:'#be185d'},
};
const FILTERS=[['best','추천'],['light','가볍고 빠름'],['work','일상 업무'],['vision','사진 보기'],['code','코딩'],['think','깊이 생각'],['tools','봇 도구']];
const primary=c=>{const p=c.purposes||[];return p.includes('code')?'code':p.includes('vision')&&!p.includes('work')?'vision':p.includes('light')?'light':p.includes('think')&&c.quality>=4?'think':p.includes('work')?'work':p.includes('think')?'think':'tools';};
const bar=(n,max)=>{const b=node('span','bar');for(let i=0;i<max;i++)b.append(node('i',i<n?'on':''));return b;};
const FITSHORT={fast:'빠름',ok:'보통',slow:'느림',no:'무리'};
const gb=n=>(n?n.toFixed(1).replace(/\.0$/,''):'?')+'GB';
const ago=iso=>{if(!iso)return '';const m=Math.round((Date.now()-Date.parse(iso))/60000);return m<1?'방금':m<60?m+'분 전':m<1440?Math.round(m/60)+'시간 전':Math.round(m/1440)+'일 전';};
const FITCLS={fast:'ok',ok:'ok',slow:'warn',no:'bad'};

// 페이지를 다시 그려도 고른 것이 유지되도록 모듈에 둔다.
const ui={filter:'best',search:'',selected:'',mineSel:'',old:false,variant:{},deal:true,limit:24};

// 마우스 위치에 따라 카드가 입체로 기울어진다.
function tilt(el){
  el.addEventListener('pointermove',e=>{
    const r=el.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
    el.style.setProperty('--ry',(x*16).toFixed(1));el.style.setProperty('--rx',(-y*14).toFixed(1));
    el.style.setProperty('--gx',(x*100+50).toFixed(0)+'%');el.style.setProperty('--gy',(y*100+50).toFixed(0)+'%');
  });
  el.addEventListener('pointerleave',()=>{el.style.removeProperty('--ry');el.style.removeProperty('--rx');});
}

function deckCard(c,i,{selected,onPick,badges=[]}){
  const k=KIND[primary(c)];
  const el=node('button','deck-card'+(selected?' sel':'')+(ui.deal?' deal':''));el.type='button';el.dataset.name=c.name;
  el.style.setProperty('--i',i);el.style.setProperty('--a',k.a);el.style.setProperty('--b',k.b);
  el.setAttribute('aria-pressed',selected?'true':'false');
  el.setAttribute('aria-label',`${c.headline}. ${c.fitLabel}`);el.title=c.custom?c.name:`${c.name}${c.best?':'+c.best:''}`;
  const top=put(node('div','dc-top'),node('span','dc-icon',k.icon),node('span','dc-kind',k.name),put(node('span','dc-badges'),...badges.map(t=>node('em','',t))));
  const row=(label,meter)=>put(node('div','dc-row'),node('span','',label),meter);
  put(el,top,put(node('div','dc-body'),node('h3','',c.headline),
    put(node('div','dc-meters'),row('성능',bar(c.quality,5)),row('속도',bar(c.speed,3))),
    put(node('div','dc-foot'),node('span','fit '+(FITCLS[c.fit]||''),'이 PC '+FITSHORT[c.fit]),node('small','dc-name',gb(c.sizeGB)))));
  el.append(node('span','dc-shine'));
  el.addEventListener('click',onPick);tilt(el);
  return el;
}

// 카드를 눌러도 덱을 새로 그리지 않고 표시만 바꿔서, 카드가 앞으로 부드럽게 나오는 모션이 끊기지 않게 한다.
function deck(cards,opts){
  const track=node('div','deck-track');
  const center=()=>{const s=track.querySelector('.sel');if(s)track.scrollTo({left:s.offsetLeft-track.clientWidth/2+s.offsetWidth/2,behavior:'smooth'});};
  const wrap=put(node('div','deck'),track,node('div','deck-floor'));
  wrap.choose=name=>{track.querySelectorAll('.deck-card').forEach(el=>{const on=el.dataset.name===name;el.classList.toggle('sel',on);el.setAttribute('aria-pressed',on?'true':'false');});center();};
  cards.forEach((c,i)=>{const o=opts(c);track.append(deckCard(c,i,{...o,onPick:()=>{wrap.choose(c.name);o.onPick(c);}}));});
  requestAnimationFrame(center);
  return wrap;
}

export function mountLocalAi(host,{onData}={}){
  const prog=progressBox();
  let data=null,loading=true,busy=false;

  async function load(force=false){
    loading=true;paint();
    try{data=await eng('/api/ollama/catalog'+(force?'?refresh=1':''));}
    catch(e){data=null;host.replaceChildren(node('p','banner bad','모델 목록을 가져오지 못했어요: '+errorText(e)));loading=false;return;}
    loading=false;ui.deal=true;paint();onData?.(data);
  }

  // 작업을 시작하고 끝날 때까지 진행을 보여 준다.
  async function runJob(path,body,doneMsg){
    busy=true;paint();
    try{
      const job=await eng(path,{method:'POST',body});prog.update(job);
      const done=await watchJob(job.id,j=>prog.update(j));
      if(done.state==='error')throw new Error(done.error);
      toast(doneMsg);
    }catch(e){toast(errorText(e),true);}
    finally{busy=false;await load();}
  }

  async function install(card,tag,{reinstall=false}={}){
    const name=card.custom?card.name:`${card.name}:${tag}`;
    let pre={};
    try{pre=await eng('/api/ollama/preflight?name='+encodeURIComponent(name));}catch(e){toast(errorText(e),true);return;}
    if(!pre.ok){toast(pre.warnings.join(' '),true);return;}
    const size=pre.sizeBytes?`약 ${(pre.sizeBytes/1e9).toFixed(1)}GB`:'수 GB';
    const parts=[`${size} 내려받아요 (남은 공간 ${pre.diskFreeBytes!=null?(pre.diskFreeBytes/1e9).toFixed(0)+'GB':'?'}).`];
    if(pre.needsOllamaInstall)parts.push('Ollama(약 1.5GB)도 함께 설치돼요.');
    if(reinstall)parts.push('기존 모델은 지우고 새로 받아요.');
    const ok=await confirmDialog({title:reinstall?'다시 설치할까요?':'설치할까요?',body:parts.join(' '),ok:reinstall?'다시 설치':'설치하고 사용하기'});
    if(!ok)return;
    await runJob('/api/ollama/install',{name,reinstall,makeActive:true},'설치가 끝났어요. 이 모델을 사용 중이에요.');
  }

  const mineHost=()=>{
    const mine=data.mine||[];
    const sec=node('div','lai-sec');
    put(sec,put(node('div','lai-head'),node('h3','','내 모델'),node('span','small muted',mine.length?`${mine.length}개`:'아직 없어요. 아래에서 골라 보세요.')));
    if(!mine.length)return sec;
    const first=mine.find(m=>m.name===ui.mineSel)||mine.find(m=>m.active)||mine[0];
    const slot=node('div');
    const show=m=>{ui.mineSel=m.name;slot.replaceChildren(mineAct(m));};
    put(sec,deck(mine.map(m=>({...m,id:m.name,purposes:m.purposes||['work'],best:''})),c=>({selected:c.name===first.name,onPick:()=>show(c),badges:c.active?['사용 중']:[]})),slot);
    show(first);
    return sec;
  };
  // 고른 내 모델의 조작: 바꾸기·다시 설치·삭제
  function mineAct(m){
    return put(node('div','lai-act'),
      put(node('div','lai-act-t'),node('b','',m.headline),node('span','small muted',`${m.name} · ${gb(m.sizeGB)}`)),
      put(node('div','row wrap'),
        m.active?pill('사용 중','ok'):button('이 모델로 바꾸기',async function(){await doing(this,async()=>{await eng('/api/ollama/active',{method:'POST',body:{name:m.name}});toast('기본 모델을 바꿨어요.');await load();});},'btn primary'),
        button('다시 설치',()=>install({...m,custom:true},'',{reinstall:true}),'btn sm'),
        button('삭제',async function(){
          if(!await confirmDialog({title:'모델을 지울까요?',body:`${m.name} (${gb(m.sizeGB)})이 이 PC에서 지워져요. 나중에 다시 설치할 수 있어요.`,ok:'지우기',danger:true}))return;
          await doing(this,async()=>{await eng('/api/ollama/remove',{method:'POST',body:{name:m.name}});toast('지웠어요.');await load();});
        },'btn sm danger')));
  }

  const shopHost=()=>{
    const sec=node('div','lai-sec');
    put(sec,put(node('div','lai-head'),node('h3','','새 모델 고르기'),
      node('span','small muted',data.source==='builtin'?'기본 목록 (오프라인)':`최신 목록 · ${ago(data.fetchedAt)}`),
      button('↻',async function(){await doing(this,async()=>{await load(true);toast(data.source==='live'?'최신 목록으로 바꿨어요.':'새 목록을 받지 못했어요.',data.source!=='live');});},'btn sm ghost')));
    const chips=put(node('div','lai-filters'),...FILTERS.map(([id,label])=>{const b=button(label,()=>{ui.filter=id;ui.limit=24;ui.deal=true;paint();},'lai-chip'+(ui.filter===id?' on':''));b.setAttribute('aria-pressed',ui.filter===id);return b;}));
    const search=input({placeholder:'검색',maxLength:40,value:ui.search});search.className='lai-search';search.setAttribute('aria-label','모델 찾기');
    let t;search.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(()=>{ui.search=search.value.trim();ui.limit=24;ui.deal=true;paint(true);},250);});
    put(sec,put(node('div','lai-tools'),chips,search));
    const q=ui.search.toLowerCase();
    let list=data.items.filter(c=>ui.old||!c.outdated);
    if(ui.filter!=='best')list=list.filter(c=>c.purposes.includes(ui.filter));
    if(q)list=list.filter(c=>(c.name+' '+c.headline+' '+c.can.join(' ')+' '+(KIND[primary(c)].name)).toLowerCase().includes(q));
    if(ui.filter==='best'&&!q)list=list.filter(c=>c.featured);
    if(!list.length){put(sec,node('p','empty-line','맞는 모델이 없어요.'));}
    else{
      const total=list.length;list=list.slice(0,ui.limit);
      const sel=list.find(c=>c.name===ui.selected)||list[0];
      const slot=node('div');
      const show=c=>{ui.selected=c.name;slot.replaceChildren(detail(c));};
      put(sec,deck(list,c=>({selected:c.name===sel.name,onPick:()=>show(c),badges:[c.isNew?'NEW':'',c.installed?'설치됨':''].filter(Boolean)})),slot);
      show(sel);
      if(total>list.length)put(sec,button(`더 보기 (${total-list.length})`,()=>{ui.limit+=24;paint(true);},'btn sm ghost'));
    }
    const old=node('label','row small muted');const cb=input({type:'checkbox'});cb.checked=ui.old;cb.addEventListener('change',()=>{ui.old=cb.checked;ui.limit=24;ui.deal=true;paint(true);});
    put(old,cb,node('span','','이전 세대도 보기'));
    const adv=node('details','lai-adv');
    const custom=input({placeholder:'예: llama3.2:3b',maxLength:60});
    put(adv,node('summary','small muted','이름으로 직접 받기'),put(node('div','row wrap'),custom,button('설치',()=>{const n=custom.value.trim();if(!n)return;install({name:n,custom:true,headline:n},'');},'btn sm primary')));
    put(sec,put(node('div','row wrap lai-foot'),old),adv);
    return sec;
  };

  // 고른 카드의 자세한 설명과 설치 버튼
  function detail(c){
    const box=node('div','lai-detail');
    const k=KIND[primary(c)];
    const vsel=select(c.variants.map(v=>[v.tag,`${v.tag==='latest'?'기본':v.tag} · ${gb(v.sizeGB)} · ${FITSHORT[v.fit]}${v.installed?' · 설치됨':''}`]),ui.variant[c.name]&&c.variants.some(v=>v.tag===ui.variant[c.name])?ui.variant[c.name]:c.best);
    vsel.setAttribute('aria-label','크기 선택');vsel.addEventListener('change',()=>{ui.variant[c.name]=vsel.value;});
    const have=c.variants.find(v=>v.installed);
    put(box,
      put(node('div','lai-d-head'),node('span','dc-icon big',k.icon),put(node('div'),node('h3','',c.headline),node('p','small muted',c.family||c.expect))),
      put(node('div','lai-tags'),...c.can.map(t=>node('span','lai-tag',t))),
      put(node('div','row wrap lai-d-act'),vsel,
        button(have?'다시 설치':'설치하고 사용하기',async function(){await install({...c},vsel.value,{reinstall:!!c.variants.find(v=>v.tag===vsel.value&&v.installed)});},'btn primary'),
        node('span','small muted',`${c.name}${c.updatedAt?' · '+ago(c.updatedAt)+' 업데이트':''}`)));
    return box;
  }

  function paint(keepScroll){
    if(loading&&!data){host.replaceChildren(put(node('div','lai-loading'),node('span','spin'),node('span','','최신 로컬 AI 목록을 확인하는 중…')));return;}
    if(!data)return;
    const pc=data.pc;
    const head=put(node('div','lai-pc small muted'),`이 PC ${pc.tier}급 · 메모리 ${pc.ramGB}GB${pc.vramGB?` · ${pc.gpu.replace(/NVIDIA GeForce /,'').replace(/ Laptop GPU/,'')} ${pc.vramGB}GB`:' · CPU로 실행'}`);
    head.title='등급은 그래픽 메모리 기준이에요. S: 8GB 미만(또는 그래픽카드 없음) · M: 8~32GB · L: 32GB 이상';
    const shield=busy?node('div','lai-busy small','설치 중이에요…'):null;
    const body=put(node('div','lai-root'+(busy?' busy':'')),head,prog.box,shield,mineHost(),shopHost());
    const y=keepScroll?window.scrollY:null;
    const typing=document.activeElement?.classList?.contains('lai-search');
    host.replaceChildren(body);ui.deal=false;
    if(typing){const s=host.querySelector('.lai-search');if(s){s.focus();s.setSelectionRange(s.value.length,s.value.length);}}
    if(y!=null)window.scrollTo(0,y);
  }

  load();
  return {reload:()=>load()};
}
