// 계정별 설정·기록 클라우드 동기화.
// 올리는 것: 화면 설정, 할 일·일정·메모(업무 저장소), 어떤 AI 서비스에 로그인했었는지(연결 여부만).
// 올리지 않는 것: Claude·GPT·Google 로그인 정보와 토큰, API 키 — 그것들은 이 PC 에만 있고, 다른 PC 에서는 다시 로그인해요.
import {api,cloud,node,put,button,openDialog,closeDialog,toast,errorText} from './ui.js';
import {eng} from './platform.js';

const KEY={prefs:'lapis.prefs.v1',workspace:'lapis.workspace.v1',theme:'theme'};
const STATE_KEY='lapis.sync.v1';
const BACKUP_KEY='lapis.sync.backup';
const CHECK_MS=90_000;

const read=k=>{try{return localStorage.getItem(k);}catch{return null;}};
const write=(k,v)=>{try{if(v===null||v===undefined)localStorage.removeItem(k);else localStorage.setItem(k,v);return true;}catch{return false;}};
const parse=raw=>{try{return raw?JSON.parse(raw):null;}catch{return null;}};
const hashOf=text=>{let h=5381;for(let i=0;i<text.length;i++)h=((h<<5)+h+text.charCodeAt(i))|0;return String(h>>>0);};
const readState=()=>parse(read(STATE_KEY))||{revision:0,syncedAt:null,hash:'',remoteConnections:null};
const saveState=patch=>write(STATE_KEY,JSON.stringify({...readState(),...patch}));

let busy=false,status={state:'idle',message:'',at:readState().syncedAt};
const emit=patch=>{status={...status,...patch};document.dispatchEvent(new CustomEvent('sync:state',{detail:status}));};

async function connectionsNow(){
  try{
    const s=await eng('/api/connections');
    return {claude:Boolean(s.claude?.loggedIn),gpt:Boolean(s.gpt?.codex?.loggedIn||s.gpt?.apiKey?.set)};
  }catch{return null;}
}
// 이 PC 의 현재 내용을 한 덩어리로 모은다.
export async function collect(){
  const exported=await api('/api/account/export');
  return {
    version:1,savedAt:new Date().toISOString(),
    prefs:parse(read(KEY.prefs)),theme:read(KEY.theme),workspace:parse(read(KEY.workspace)),
    tasks:exported.tasks||[],events:exported.events||[],
    connections:await connectionsNow(),
  };
}
const comparable=s=>JSON.stringify({prefs:s.prefs,theme:s.theme,workspace:s.workspace,tasks:s.tasks,events:s.events});
function isEmpty(s){
  const ws=s.workspace||{};
  return !s.prefs&&!s.theme&&!(s.tasks||[]).length&&!(s.events||[]).length&&!['tasks','resources','flows'].some(k=>(ws[k]||[]).length);
}
// 클라우드 내용을 이 PC 에 적용한다. 적용 전의 이 PC 내용은 한 칸 백업해 둔다.
async function applySnapshot(snap,revision){
  const current=await collect();
  write(BACKUP_KEY,JSON.stringify({at:new Date().toISOString(),snapshot:{...current,connections:undefined}}));
  const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
  write(KEY.prefs,obj(snap.prefs)?JSON.stringify(snap.prefs):null);
  write(KEY.theme,typeof snap.theme==='string'&&/^(light|dark|auto)$/.test(snap.theme)?snap.theme:null);
  write(KEY.workspace,obj(snap.workspace)?JSON.stringify(snap.workspace):null);
  await api('/api/account/import',{method:'POST',body:{tasks:snap.tasks||[],events:snap.events||[]}});
  saveState({revision,syncedAt:new Date().toISOString(),hash:hashOf(comparable(await collect())),remoteConnections:snap.connections||null});
}
async function push(local,expectedRevision){
  const r=await cloud('PUT','/sync',{snapshot:local,expectedRevision});
  saveState({revision:r.revision,syncedAt:r.updatedAt||new Date().toISOString(),hash:hashOf(comparable(local)),remoteConnections:local.connections||null});
  return r;
}

function askConflict(remote){
  return new Promise(resolve=>{
    const dlg=openDialog((box,close)=>{
      const pick=v=>()=>{resolve(v);close();};
      put(box,put(node('div','dlg-head'),node('h2','','클라우드에 저장된 설정이 있어요'),
          node('p','','이 계정으로 저장해 둔 설정·기록이 있고, 이 PC에도 다른 내용이 있어요. 어느 쪽을 쓸까요? 가져오기를 고르면 이 PC의 현재 내용은 백업해 둬요.')),
        put(node('div','dlg-foot'),button('나중에',pick('later')),button('이 PC 내용으로 덮어쓰기',pick('push')),button('클라우드 내용 가져오기',pick('pull'),'btn primary')));
    });
    dlg.addEventListener('close',()=>resolve('later'),{once:true});
  });
}

// 클라우드와 이 PC 를 맞춘다. 조용히 해도 되는 경우는 묻지 않고, 서로 다르게 바뀐 경우에만 묻는다.
export async function reconcile({ask=true}={}){
  if(busy)return status;
  busy=true;emit({state:'syncing',message:'동기화하는 중…'});
  try{
    const remote=await cloud('GET','/sync');
    const local=await collect();
    const here=hashOf(comparable(local)),state=readState();
    let result='같은 내용이에요';
    if(!remote.snapshot){
      if(!isEmpty(local)){await push(local,remote.revision);result='클라우드에 저장했어요';}
    }else if(remote.revision===state.revision){
      if(here!==state.hash){await push(local,remote.revision);result='클라우드에 저장했어요';}
      else saveState({remoteConnections:remote.snapshot.connections||state.remoteConnections});
    }else{
      const locallyChanged=state.revision?here!==state.hash:!isEmpty(local);
      let choice='pull';
      if(locallyChanged)choice=ask?await askConflict(remote):'later';
      if(choice==='pull'){await applySnapshot(remote.snapshot,remote.revision);result='클라우드 내용을 가져왔어요';emit({state:'idle',message:result,at:new Date().toISOString()});setTimeout(()=>location.reload(),600);return status;}
      if(choice==='push'){await push(local,remote.revision);result='이 PC 내용을 클라우드에 저장했어요';}
      else result='나중에 정하기로 했어요';
    }
    emit({state:'idle',message:result,at:readState().syncedAt});
  }catch(e){emit({state:'error',message:errorText(e)});}
  finally{busy=false;}
  return status;
}
// 클라우드 내용을 강제로 가져온다(프로필 화면의 버튼).
export async function pullNow(){
  const remote=await cloud('GET','/sync');
  if(!remote.snapshot)throw new Error('클라우드에 저장된 내용이 아직 없어요.');
  await applySnapshot(remote.snapshot,remote.revision);
  toast('클라우드 내용을 가져왔어요. 화면을 새로 고쳐요…');
  setTimeout(()=>location.reload(),600);
}
export const syncStatus=()=>status;
export const knownConnections=()=>readState().remoteConnections;
export {closeDialog};

// 시작할 때 한 번, 그다음엔 주기적으로 바뀐 것만 올린다. 창을 숨길 때도 한 번 시도한다.
async function periodic(){
  if(busy)return;
  try{
    const local=await collect();
    if(hashOf(comparable(local))!==readState().hash&&!isEmpty(local))await reconcile({ask:false});
  }catch{ /* 다음 주기에 다시 */ }
}
let started=false;
export function start(){
  if(started)return;started=true;
  window.__lapisSync={reconcile,pullNow,status:syncStatus};
  reconcile({ask:true});
  setInterval(periodic,CHECK_MS);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)periodic();});
}
