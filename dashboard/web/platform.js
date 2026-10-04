// 시작 마법사·연결 허브·봇 스튜디오가 함께 쓰는 부품: 사무실 엔진 호출, 작업(설치·모델 받기) 진행 표시, 구성 요소 카드.
import {node,put,button,pill,api,toast,errorText,fmtBytes} from './ui.js';

// 사무실 엔진(127.0.0.1:5000)은 대시보드 서버가 허용 목록을 거쳐 대신 부른다.
export const eng=(path,opts)=>api('/office'+path,opts);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// 작업(job)이 끝날 때까지 1초마다 읽는다. onUpdate 로 진행 표시를 갱신한다.
export async function watchJob(id,onUpdate){
  for(;;){
    const job=await eng('/api/jobs/'+encodeURIComponent(id));
    onUpdate?.(job);
    if(job.state!=='running')return job;
    await sleep(1000);
  }
}

// 진행 막대와 마지막 기록을 보여 주는 작은 영역
export function progressBox(){
  const box=node('div','job-box');box.hidden=true;
  const label=node('div','job-label'),bar=node('div','meter'),fill=node('i'),detail=node('div','job-log small muted');
  bar.append(fill);put(box,label,bar,detail);
  return {box,update(job){
    box.hidden=false;
    const p=job.progress||{};
    const pct=p.total?Math.min(100,Math.round(p.done/p.total*100)):null;
    label.textContent=(job.step||job.label||'진행 중')+(pct!==null?` · ${pct}%${p.total>1e6?` (${fmtBytes(p.done)} / ${fmtBytes(p.total)})`:''}`:'');
    fill.style.width=(pct!==null?pct:job.state==='running'?35:100)+'%';
    bar.classList.toggle('indeterminate',pct===null&&job.state==='running');
    bar.classList.toggle('bad',job.state==='error');
    detail.textContent=job.state==='error'?job.error:(job.log||[]).slice(-1)[0]||'';
  }};
}

// 구성 요소 하나를 설치하고 진행 상황을 보여 준다. 끝나면 resolve(job).
export async function installComponent(id,ui){
  const job=await eng(`/api/components/${id}/install`,{method:'POST',body:{}});
  ui?.update(job);
  const done=await watchJob(job.id,j=>ui?.update(j));
  if(done.state==='error')throw new Error(done.error);
  return done;
}

export function componentRow(c,{onInstall,selectable=false,checked=false}={}){
  const row=node('div','comp-row'+(c.installed?' ok':''));
  let box=null;
  if(selectable&&!c.installed){box=node('input');box.type='checkbox';box.checked=checked;box.id='comp-'+c.id;box.setAttribute('aria-label',c.name+' 선택');}
  const text=put(node('div','comp-text'),
    put(node('div','row nowrap'),node('b','',c.name),c.installed?pill('설치됨 · v'+c.version,'ok'):pill('필요 '+c.size,'warn')),
    node('p','small muted',c.desc),c.needs?node('p','small faint','쓰는 곳: '+c.needs):null);
  const side=node('div','comp-side');
  const prog=progressBox();
  if(!c.installed&&onInstall){
    const b=button('설치',async()=>{b.disabled=true;try{await onInstall(c.id,prog);}catch(e){toast(errorText(e),true);}finally{b.disabled=false;}},'btn sm primary');
    side.append(b);
  }
  put(row,box,text,side,prog.box);
  row.dataset.comp=c.id;
  return {row,box,prog};
}

export const SETUP_KEY='lapis.setup.done.v1';
export const setupDone=()=>{try{return localStorage.getItem(SETUP_KEY)==='1';}catch{return true;}};
export const markSetupDone=()=>{try{localStorage.setItem(SETUP_KEY,'1');}catch{}};
