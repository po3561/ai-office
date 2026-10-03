// 저장소: ① 사무실에 맡긴 이 PC 드라이브(읽기 전용) ② 라피스에 연결한 Google Drive(보기·검색·시트/문서 쓰기) ③ 라피스 라이브러리.
import {q,qa,node,put,button,pill,link,emptyLine,friendly,api,cloud,toast,doing,errorText,fmtDate,fmtBytes,openDialog,closeDialog,field,input,select,textarea,registerPage,safeHttps} from './ui.js';
import {session,refreshSession,loginPrompt,hasScope} from './account.js';

let tab='local',localPath=null,driveFolder=null,driveQuery='';
const body=()=>q('#storage-body');

function setTab(next){
  tab=next;qa('[data-storage-tab]').forEach(b=>b.classList.toggle('on',b.dataset.storageTab===next));
  render();
}
async function render(){
  const box=body();box.replaceChildren(emptyLine('불러오는 중…'));
  try{
    if(tab==='local')await renderLocal(box);
    else if(tab==='drive')await renderDrive(box);
    else await renderLibrary(box);
  }catch(error){box.replaceChildren(node('p','banner warn',errorText(error)));}
}

// ── ① 이 PC ──
async function renderLocal(box){
  const {roots}=await api('/api/storage/local');
  box.replaceChildren();
  if(!roots.length){
    box.append(friendly('사무실에 맡긴 드라이브가 없어요','「드라이브」에서 D 드라이브 같은 위치를 맡기면 여기서 폴더를 볼 수 있어요.',link('드라이브 열기 →','#drive','btn primary')));return;
  }
  if(!localPath||!roots.some(r=>localPath.toLowerCase().startsWith(r.replace(/\\/g,'/').toLowerCase().replace(/\/$/,''))))localPath=roots[0].replace(/\\/g,'/');
  const listing=await api('/api/storage/local/list?path='+encodeURIComponent(localPath));
  const crumbs=node('div','crumbs');
  roots.length>1&&put(box,put(node('div','row wrap'),node('span','small muted','맡긴 위치'),...roots.map(r=>button(r,()=>{localPath=r.replace(/\\/g,'/');render();},'btn sm'+(localPath.toLowerCase().startsWith(r.replace(/\\/g,'/').toLowerCase())?' primary':'')))));
  listing.breadcrumbs.forEach((c,i)=>{if(i)crumbs.append(node('span','muted','›'));crumbs.append(button(c.name,()=>{localPath=c.path;render();},'crumb'));});
  const card=node('div','card');
  put(card,crumbs,fileTable(listing.entries.map(e=>({name:e.name,folder:e.folder,size:e.size,modifiedAt:e.modifiedAt,open:()=>{localPath=listing.path.replace(/\/$/,'')+'/'+e.name;render();},extra:button('탐색기에서 보기',()=>doing(null,async()=>{await api('/api/storage/local/reveal',{method:'POST',body:{path:listing.path.replace(/\/$/,'')+'/'+e.name}});}),'btn sm ghost')}))),
    listing.truncated?node('p','small muted','항목이 많아 앞의 500개만 보여 줍니다.'):null);
  box.append(card);
}
function fileTable(rows){
  const table=node('div','file-table');
  if(!rows.length)return emptyLine('비어 있는 폴더입니다.');
  for(const row of rows){
    const item=node('div','file-row');
    const name=row.folder?button((row.icon||'📁')+' '+row.name,row.open,'file-name folder'):node('span','file-name',(row.icon||'📄')+' '+row.name);
    put(item,name,node('span','file-size small muted',row.folder?'':fmtBytes(row.size)),node('span','file-date small muted',row.modifiedAt?fmtDate(row.modifiedAt,{year:'2-digit',month:'numeric',day:'numeric'}):''),row.extra||node('span'));
    table.append(item);
  }
  return table;
}

// ── ② Google Drive ──
const FOLDER='application/vnd.google-apps.folder';
const iconFor=m=>m===FOLDER?'📁':m.includes('spreadsheet')?'📊':m.includes('document')?'📝':m.includes('presentation')?'📽️':m.startsWith('image/')?'🖼️':'📄';
async function renderDrive(box){
  if(!session.loaded)await refreshSession();
  box.replaceChildren();
  if(!session.signedIn){box.append(loginPrompt('Google Drive를 보려면 라피스 계정으로 로그인하세요.'));return;}
  const status=await cloud('GET','/integrations/google-drive/status').catch(()=>null);
  if(!status?.connected||!hasScope(status.connection?.scopes,'drive')){
    box.append(friendly('Google Drive가 아직 연결되지 않았어요','라피스 계정 화면에서 Drive를 연결하면 폴더를 보고 파일을 검색할 수 있어요.',link('Google 연결하기 →','#account','btn primary')));return;
  }
  const search=node('form','row nowrap');
  const query=input({type:'search',placeholder:'Drive에서 파일 검색 (예: 주간 보고)',value:driveQuery,maxLength:320});query.style.flex='1';
  put(search,query,button('검색',null,'btn primary'),button('＋ 시트에 쓰기',()=>sheetDialog(),'btn'),button('＋ 문서·슬라이드',()=>docDialog(),'btn'));
  search.children[1].type='submit';
  search.addEventListener('submit',e=>{e.preventDefault();driveQuery=query.value.trim();render();});
  const card=node('div','card');put(card,search);box.append(card);
  const results=node('div');card.append(results);
  results.append(emptyLine('불러오는 중…'));
  if(driveQuery){
    const data=await cloud('POST','/integrations/google-drive/tools/search',{query:driveQuery,limit:8});
    const items=data.result?.items||[];
    results.replaceChildren(put(node('div','group-title'),'“'+driveQuery+'” 검색 결과 '+items.length+'건 ',button('지우기',()=>{driveQuery='';render();},'btn sm ghost')),
      fileTable(items.map(i=>({name:i.title,folder:false,icon:iconFor(i.mimeType),size:null,modifiedAt:i.modifiedAt,extra:driveActions(i.id,i.title,i.url)}))));
    return;
  }
  const listing=await cloud('POST','/integrations/google-drive/browse',{folderId:driveFolder});
  const crumbs=node('div','crumbs');
  crumbs.append(button('내 드라이브',()=>{driveFolder=null;render();},'crumb'));
  for(const c of listing.breadcrumbs||[]){crumbs.append(node('span','muted','›'),button(c.name,()=>{driveFolder=c.id;render();},'crumb'));}
  results.replaceChildren(crumbs,fileTable((listing.entries||[]).map(e=>({name:e.name,folder:e.folder,icon:e.lapisOutput?'✨':iconFor(e.mimeType),size:e.size,modifiedAt:e.modifiedAt,open:()=>{driveFolder=e.id;render();},extra:e.folder?node('span'):driveActions(e.id,e.name,e.url)}))),
    listing.truncated?node('p','small muted','항목이 많아 앞의 200개만 보여 줍니다.'):null,
    listing.accountLabel?node('p','small muted','연결 계정: '+listing.accountLabel):null);
}
function driveActions(id,name,url){
  const box=node('span','row nowrap');
  const safe=safeHttps(url);
  put(box,button('내용 보기',function(){doing(this,async()=>{const r=await cloud('POST','/integrations/google-drive/tools/read',{file_id:id});showContent(name,r.content);});},'btn sm ghost'),safe?link('열기 ↗',safe,'btn sm ghost'):null);
  return box;
}
function showContent(name,content){
  const text=typeof content==='string'?content:content?.text??content?.content??JSON.stringify(content,null,2);
  openDialog((box,close)=>{
    put(box,put(node('div','dlg-head'),node('h2','',name),node('p','','읽기 전용 미리보기입니다. 긴 파일은 앞부분만 보일 수 있어요.')),
      put(node('div','dlg-body'),node('pre','mk-pre',String(text).slice(0,60000))),put(node('div','dlg-foot'),button('닫기',close,'btn primary')));
  },{wide:true});
}

// ── Google 시트·문서 쓰기: 미리보기 → 사용자 승인 → 적용 ──
function parseGrid(text){return text.replace(/\r/g,'').split('\n').filter(l=>l.length).map(line=>(line.includes('\t')?line.split('\t'):line.split(',')).map(c=>{const t=c.trim();return t===''?null:/^-?\d+(\.\d+)?$/.test(t)?Number(t):t;}));}
function sheetDialog(){
  openDialog((box,close)=>{
    const kind=select([['CREATE','새 시트 만들기'],['UPDATE_VALUES','기존 시트의 값 바꾸기'],['APPEND_VALUES','기존 시트 끝에 행 추가']],'APPEND_VALUES');
    const title=input({maxLength:120,placeholder:'새 시트 이름'}),url=input({placeholder:'https://docs.google.com/spreadsheets/d/…'}),range=input({value:'Sheet1!A1',maxLength:80});
    const values=textarea({rows:6,placeholder:'한 줄이 한 행입니다. 칸은 쉼표나 탭으로 나누세요.\n이름,수량\n마이크,3'});
    const formula=node('input');formula.type='checkbox';
    const preview=node('div');
    const apply=button('승인하고 적용',null,'btn primary');apply.hidden=true;
    const run=button('미리보기',null,'btn');
    const sync=()=>{title.closest('.field').hidden=kind.value!=='CREATE';url.closest('.field').hidden=kind.value==='CREATE';};
    kind.addEventListener('change',sync);
    let operation=null;
    run.addEventListener('click',()=>doing(run,async()=>{
      const grid=parseGrid(values.value);if(!grid.length)throw new Error('쓸 값을 입력해 주세요.');
      const data=await cloud('POST','/integrations/google-sheets/operations/preview',{kind:kind.value,...(kind.value==='CREATE'?{title:title.value}:{spreadsheet_url:url.value}),range:range.value,values:grid,allow_formulas:formula.checked});
      operation=data.operation;preview.replaceChildren();
      put(preview,node('div','group-title','미리보기 — 아직 아무것도 바뀌지 않았어요'),node('p','small',(operation.spreadsheet_title||'새 시트')+' · '+operation.range),gridTable('쓸 값',operation.proposed_values),operation.current_values?.length?gridTable('지금 값',operation.current_values):null,operation.escaped_formula_cells?node('p','small muted','수식으로 읽힐 수 있는 칸 '+operation.escaped_formula_cells+'개는 글자로 안전하게 바꿨어요.'):null);
      apply.hidden=false;
    }));
    apply.addEventListener('click',()=>doing(apply,async()=>{
      const done=await cloud('POST','/integrations/google-sheets/operations/'+encodeURIComponent(operation.id)+'/commit',{approval_token:operation.approval_token});
      const op=done.operation||{};preview.replaceChildren(put(node('p','banner info'),'✓ 적용했어요 · '+(op.updated_cells??0)+'칸 ',op.spreadsheet_url&&safeHttps(op.spreadsheet_url)?link('시트 열기 ↗',op.spreadsheet_url):null));
      apply.hidden=true;toast('시트에 적용했습니다.');
    }));
    put(box,put(node('div','dlg-head'),node('h2','','Google 시트에 쓰기'),node('p','','먼저 미리보기를 보고, 확인한 뒤에만 적용돼요.')),
      put(node('div','dlg-body'),put(node('div','stack'),field('작업',kind),field('시트 이름',title),field('시트 주소',url),field('범위',range,'예: Sheet1!A1'),field('값',values),(()=>{const l=node('label','row small');put(l,formula,'수식도 허용 (기본은 글자로 안전하게 저장)');return l;})(),preview)),
      put(node('div','dlg-foot'),button('닫기',close),run,apply));
    sync();
  },{wide:true});
}
function gridTable(label,rows){
  const t=node('table','tbl');const head=node('caption','small muted',label);t.append(head);
  for(const row of (rows||[]).slice(0,30)){const tr=node('tr');for(const cell of row)tr.append(node('td','',cell===null?'':cell));t.append(tr);}
  const wrap=node('div','grid-scroll');wrap.append(t);return wrap;
}
function docDialog(){
  openDialog((box,close)=>{
    const kind=select([['CREATE_DOCUMENT','새 문서 만들기'],['APPEND_DOCUMENT','문서 끝에 내용 추가'],['REPLACE_DOCUMENT_TEXT','문서의 글 바꾸기'],['CREATE_PRESENTATION','새 슬라이드 만들기'],['APPEND_SLIDE','슬라이드 한 장 추가']],'CREATE_DOCUMENT');
    const title=input({maxLength:120,placeholder:'제목'}),url=input({placeholder:'https://docs.google.com/document/d/…'}),find=input({maxLength:500,placeholder:'바꿀 글'});
    const content=textarea({rows:7,placeholder:'내용'});
    const preview=node('div'),apply=button('승인하고 적용',null,'btn primary');apply.hidden=true;const run=button('미리보기',null,'btn');
    const sync=()=>{const create=kind.value.startsWith('CREATE');title.closest('.field').hidden=!create;url.closest('.field').hidden=create;find.closest('.field').hidden=kind.value!=='REPLACE_DOCUMENT_TEXT';};
    kind.addEventListener('change',sync);let operation=null;
    run.addEventListener('click',()=>doing(run,async()=>{
      const create=kind.value.startsWith('CREATE');
      const data=await cloud('POST','/integrations/google-workspace/operations/preview',{kind:kind.value,content:content.value,...(create?{title:title.value}:{resource_url:url.value}),...(kind.value==='REPLACE_DOCUMENT_TEXT'?{find_text:find.value}:{})});
      operation=data.operation;preview.replaceChildren();
      put(preview,node('div','group-title','미리보기 — 아직 아무것도 바뀌지 않았어요'),operation.title?node('p','small','대상: '+operation.title):null,operation.current_excerpt?put(node('div'),node('div','small muted','지금 내용'),node('pre','mk-pre',operation.current_excerpt)):null,put(node('div'),node('div','small muted','추가·변경할 내용'),node('pre','mk-pre',operation.proposed_content||content.value)));
      apply.hidden=false;
    }));
    apply.addEventListener('click',()=>doing(apply,async()=>{
      const done=await cloud('POST','/integrations/google-workspace/operations/'+encodeURIComponent(operation.id)+'/commit',{approval_token:operation.approval_token});
      const op=done.operation||{};preview.replaceChildren(put(node('p','banner info'),'✓ 적용했어요 ',op.resource_url&&safeHttps(op.resource_url)?link('열기 ↗',op.resource_url):null));apply.hidden=true;toast('적용했습니다.');
    }));
    put(box,put(node('div','dlg-head'),node('h2','','Google 문서·슬라이드 작업'),node('p','','미리보기를 확인한 뒤에만 적용돼요.')),
      put(node('div','dlg-body'),put(node('div','stack'),field('작업',kind),field('제목',title),field('문서 주소',url),field('바꿀 글',find),field('내용',content),preview)),
      put(node('div','dlg-foot'),button('닫기',close),run,apply));
    sync();
  },{wide:true});
}

// ── ③ 라이브러리 ──
async function renderLibrary(box){
  if(!session.loaded)await refreshSession();
  box.replaceChildren();
  if(!session.signedIn){box.append(loginPrompt('라피스 라이브러리를 보려면 라피스 계정으로 로그인하세요.'));return;}
  const data=await cloud('GET','/files?limit=100');
  const files=data.files||[];
  const card=node('div','card');
  put(card,put(node('div','card-head'),put(node('div'),node('h2','','라피스 라이브러리'),node('p','sub','에디터와 Google Drive에서 라피스가 알고 있는 파일 목록입니다. 읽기 전용이에요.'))));
  if(!files.length)card.append(friendly('아직 등록된 파일이 없어요','에디터에서 파일을 라이브러리에 등록하면 이곳에 나타나요.'));
  else card.append(fileTable(files.map(f=>({name:f.logical_name,folder:false,icon:f.storage_provider==='GOOGLE_DRIVE'?'☁️':'💻',size:f.size_bytes,modifiedAt:f.updated_at,extra:put(node('span','row nowrap'),pill(f.storage_provider==='GOOGLE_DRIVE'?'Drive':'내 PC'),f.availability&&f.availability!=='AVAILABLE'?pill(f.availability,'warn'):null)}))));
  box.append(card);
}

q('#storage-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-storage-tab]');if(b)setTab(b.dataset.storageTab);});
registerPage('storage',{show(){refreshSession().then(render);}});
