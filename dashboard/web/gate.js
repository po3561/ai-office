// 회원제 입구: 로그인하지 않았으면 로그인·회원가입 화면만 보여 주고, 로그인했으면 앱을 불러온다.
// 초기 설정 마법사는 없다 — 가입하거나 로그인하면 바로 앱으로 들어간다.
// 계정마다 설정·기록이 섞이지 않도록, 앱을 불러오기 전에 이 브라우저 저장소의 키를 계정별 이름표로 나눈다.
import {node,put,button,field,input,errorText} from './ui.js';

const KEYS=/^(lapis\.|theme$|office$|marketTab$)/;
function namespaceStorage(userId){
  const ns='acct:'+userId+':';
  const proto=Storage.prototype,get=proto.getItem,set=proto.setItem,del=proto.removeItem;
  const key=(self,k)=>self===window.localStorage&&KEYS.test(String(k))?ns+k:k;
  proto.getItem=function(k){return get.call(this,key(this,k));};
  proto.setItem=function(k,v){return set.call(this,key(this,k),v);};
  proto.removeItem=function(k){return del.call(this,key(this,k));};
}

const root=document.getElementById('gate');
let docs=[],decisions={};

async function call(method,path,body){
  const response=await fetch('/api/cloud'+path,{method,credentials:'same-origin',headers:method==='GET'?{}:{'content-type':'application/json','x-lapis-request':'1'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'요청을 처리하지 못했습니다 ('+response.status+')');
  return data;
}

function shell(title,sub,...body){
  const card=put(node('section','gate-card'),
    put(node('div','gate-brand'),node('span','brand-mark','◈'),put(node('div'),node('b','','LAPIS'),node('small','','나의 업무 공간'))),
    node('h1','',title),node('p','sub',sub),...body);
  root.replaceChildren(put(node('div','gate-wrap'),card));
  return card;
}
function tabs(active){
  const row=put(node('div','tabs gate-tabs'),button('로그인',()=>showLogin(),active==='login'?'on':''),button('회원가입',()=>showConsents(),active==='register'?'on':''));
  row.setAttribute('role','tablist');return row;
}
const errorBox=()=>{const e=node('p','banner bad');e.hidden=true;e.setAttribute('role','alert');return e;};
const showError=(box,e)=>{box.textContent=errorText(e);box.hidden=false;};

function showLogin(){
  const id=input({autocomplete:'username',maxLength:254,placeholder:'아이디 또는 이메일'});id.setAttribute('aria-label','아이디 또는 이메일');
  const pw=input({type:'password',autocomplete:'current-password',maxLength:128,placeholder:'비밀번호'});pw.setAttribute('aria-label','비밀번호');
  const err=errorBox();
  const go=button('로그인',null,'btn primary');go.type='submit';
  const form=put(node('form','stack'),field('아이디 또는 이메일',id),field('비밀번호',pw),err,go);
  form.addEventListener('submit',async e=>{
    e.preventDefault();go.disabled=true;err.hidden=true;
    try{await call('POST','/login',{identifier:id.value.trim(),password:pw.value});location.reload();}
    catch(ex){showError(err,ex);go.disabled=false;}
  });
  const google=button('Google로 계속',async()=>{
    google.disabled=true;err.hidden=true;
    try{
      const {waitForAuth}=await import('./account.js');
      const status=node('p','small muted');form.append(status);
      const ok=await waitForAuth({start:()=>call('POST','/login/start',{}),poll:attemptId=>call('POST','/login/poll',{attemptId}),status,onDone:async()=>{}});
      if(ok)location.reload();else google.disabled=false;
    }catch(ex){showError(err,ex);google.disabled=false;}
  },'btn');
  shell('다시 오신 것을 환영해요','라피스 계정으로 로그인하면 설정과 기록이 그대로 이어져요.',tabs('login'),form,
    node('div','gate-divider','또는'),google,
    node('p','small muted','Google 로그인은 계정이 없으면 새로 만들어 줘요. 로그인 정보는 이 PC의 Windows 계정으로 암호화해 보관돼요.'));
  id.focus();
}

async function showConsents(){
  const err=errorBox();
  try{
    if(!docs.length){docs=(await call('GET','/consents')).documents;decisions=Object.fromEntries(docs.map(d=>[d.consentType,false]));}
  }catch(ex){shell('회원가입','',tabs('register'),(showError(err,ex),err));return;}
  const next=button('다음',()=>showRegister(),'btn primary');
  const refresh=()=>{next.disabled=!docs.every(d=>!d.required||decisions[d.consentType]);};
  const boxes=docs.map(d=>{
    const cb=node('input');cb.type='checkbox';cb.checked=decisions[d.consentType];
    cb.addEventListener('change',()=>{decisions[d.consentType]=cb.checked;refresh();});
    return put(node('label','gate-consent'),cb,put(node('span'),node('b','',(d.required?'[필수] ':'[선택] ')+d.title),node('small','muted',d.bodyMarkdown),node('small','muted','문서 버전 '+d.version)));
  });
  refresh();
  shell('회원가입 1 / 2','서비스 이용에 필요한 약관에 동의해 주세요. 선택 항목은 거부해도 쓸 수 있어요.',tabs('register'),...boxes,next);
}

function showRegister(){
  const f={
    username:input({autocomplete:'username',minLength:4,maxLength:30,placeholder:'영문 소문자·숫자 4~30자'}),
    email:input({type:'email',autocomplete:'email',maxLength:254,placeholder:'name@example.com'}),
    displayName:input({autocomplete:'nickname',maxLength:80,placeholder:'앱에서 보일 이름'}),
    phone:input({type:'tel',autocomplete:'tel',maxLength:24,placeholder:'010-0000-0000 (선택)'}),
    password:input({type:'password',autocomplete:'new-password',maxLength:128,placeholder:'12자 이상'}),
    again:input({type:'password',autocomplete:'new-password',maxLength:128,placeholder:'비밀번호 한 번 더'}),
  };
  f.username.addEventListener('input',()=>{f.username.value=f.username.value.toLowerCase();});
  const err=errorBox();
  const go=button('가입하고 시작하기',null,'btn primary');go.type='submit';
  const back=button('이전',()=>showConsents(),'btn');
  const form=put(node('form','stack'),field('아이디',f.username),field('이메일',f.email),field('닉네임 (표시 이름)',f.displayName),
    field('전화번호 (선택)',f.phone,'한국 번호는 암호화해 저장돼요.'),field('비밀번호',f.password,'12자 이상으로 정해 주세요.'),field('비밀번호 확인',f.again),err,put(node('div','row'),back,go));
  form.addEventListener('submit',async e=>{
    e.preventDefault();err.hidden=true;
    if(f.password.value!==f.again.value){showError(err,'비밀번호가 서로 달라요.');return;}
    go.disabled=true;
    try{
      await call('POST','/register',{username:f.username.value,email:f.email.value,displayName:f.displayName.value,phone:f.phone.value,password:f.password.value,
        consents:docs.map(d=>({consentType:d.consentType,version:d.version,documentHash:d.documentHash,granted:decisions[d.consentType]===true}))});
      location.reload();
    }catch(ex){showError(err,ex);go.disabled=false;}
  });
  shell('회원가입 2 / 2','라피스 계정을 만들어요.',tabs('register'),form);
  f.username.focus();
}

async function boot(){
  let state=null;
  try{state=await (await fetch('/api/cloud/state',{credentials:'same-origin'})).json();}catch{ /* 서버가 아직 안 떴으면 아래에서 로그인 화면을 보여 준다 */ }
  if(state?.signedIn){
    namespaceStorage(state.user.id);
    document.body.classList.remove('gated');
    root.hidden=true;
    await import('/office.js');      // 사무실 화면(먼저)
    await import('/lapis.js');       // 나머지 화면과 이동
    import('/sync.js').then(m=>m.start());   // 설정·기록 클라우드 동기화
  }else{
    root.hidden=false;
    showLogin();
  }
}
boot();
