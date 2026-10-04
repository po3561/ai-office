// 연결 허브: Claude · GPT · Google · 로컬 AI · Hermes · API 키를 한 화면에서 연결하고 상태를 본다.
import {q,node,put,button,pill,link,api,registerPage,toast,errorText,doing,confirmDialog,input} from './ui.js';
import {eng,watchJob,progressBox,installComponent} from './platform.js';

function card(title,sub,status,...body){
  const c=node('section','card hub-card');
  const head=put(node('div','card-head'),put(node('div'),node('h2','',title),sub?node('p','sub',sub):null),status);
  return put(c,head,...body);
}
const badge=(ok,yes='연결됨',no='연결 안 됨')=>ok?pill(yes,'ok'):pill(no);

// 설치 버튼(없으면) 또는 설치됨 표시
function installBar(id,name,detected,refresh){
  if(detected.installed)return null;
  const prog=progressBox();
  const b=button(name+' 설치',async()=>{b.disabled=true;try{await installComponent(id,prog);toast(name+' 설치를 마쳤어요.');refresh();}catch(e){toast(errorText(e),true);}finally{b.disabled=false;}},'btn primary');
  return put(node('div','stack'),put(node('div','row'),b),prog.box);
}

function keyForm(name,label,hint,state,refresh){
  const wrap=node('div','stack');
  if(state.set){
    wrap.append(put(node('div','row'),pill('저장됨 '+state.hint,'ok'),button('지우기',async function(){if(!await confirmDialog({title:label+'를 지울까요?',body:'이 PC에 저장된 키만 지워지고, 서비스 쪽 키는 그대로예요.',ok:'지우기',danger:true}))return;await doing(this,async()=>{await eng('/api/connections/keys/'+name,{method:'DELETE',body:{}});toast('지웠어요.');refresh();});},'btn sm danger')));
    return wrap;
  }
  const i=input({type:'password',placeholder:hint,autocomplete:'off',spellcheck:false,maxLength:220});i.setAttribute('aria-label',label);
  const save=button('확인하고 저장',async function(){await doing(this,async()=>{await eng('/api/connections/keys/'+name,{method:'PUT',body:{key:i.value.trim()}});i.value='';toast(label+'를 저장했어요.');refresh();});},'btn primary');
  put(wrap,put(node('div','row'),i,save),node('p','small muted','입력한 키는 이 PC의 Windows 계정으로 암호화해 저장하고, 화면에는 다시 보여주지 않아요.'));
  return wrap;
}

async function render(){
  const root=q('#hub-body');
  let s,comps,cloud,om;
  try{[s,comps]=await Promise.all([eng('/api/connections'),eng('/api/components')]);}
  catch(e){root.replaceChildren(node('p','banner bad','앱 엔진에 연결하지 못했어요: '+errorText(e)));return;}
  cloud=await api('/api/cloud/state').catch(()=>({signedIn:false}));
  om=await eng('/api/ollama').catch(()=>({installed:false,models:[],recommended:[]}));
  const det=id=>comps.components.find(c=>c.id===id)||{installed:false};
  const refresh=()=>render();
  const grid=node('div','grid cols-2');

  // Claude
  const cl=s.claude;
  grid.append(card('Claude','구독 계정으로 일하는 Claude Code. 파일·도구까지 쓰는 가장 강력한 엔진이에요.',badge(cl.loggedIn,cl.email||'로그인됨','로그인 필요'),
    installBar('claude','Claude Code',det('claude'),refresh)||put(node('div','row'),
      cl.loggedIn?node('span','small muted',(cl.plan?cl.plan+' · ':'')+'v'+cl.version):button('Claude 로그인',async function(){await doing(this,async()=>{await eng('/api/claude/login',{method:'POST',body:{method:'claudeai'}});toast('열린 창에서 로그인을 끝낸 뒤 「다시 확인」을 누르세요.');});},'btn primary'),
      button('다시 확인',async function(){await doing(this,async()=>{await eng('/api/claude/refresh',{method:'POST',body:{}});refresh();});},'btn sm')),
    installBar('bun','Bun (텔레그램 연결 부품)',det('bun'),refresh)));

  // GPT
  const g=s.gpt,cx=g.codex;
  const gptBody=[installBar('codex','Codex',det('codex'),refresh)||put(node('div','row'),
      cx.loggedIn?node('span','small muted',cx.method+' · v'+cx.version):cx.error?node('span','small muted','상태: '+cx.error):null,cx.loggedIn?null:button('ChatGPT 로그인',async function(){await doing(this,async()=>{await eng('/api/connections/codex/login',{method:'POST',body:{}});toast('열린 창에서 ChatGPT 로그인을 끝낸 뒤 「다시 확인」을 누르세요.');});},'btn primary'),
      button('다시 확인',()=>refresh(),'btn sm')),
    node('div','group-title','OpenAI API 키 (선택)'),keyForm('openai','OpenAI API 키','sk-… 로 시작하는 키',g.apiKey,refresh)];
  grid.append(card('GPT','ChatGPT 계정으로 로그인하거나, OpenAI API 키로 GPT를 봇의 두뇌로 씁니다.',badge(cx.loggedIn||g.apiKey.set,cx.loggedIn?'ChatGPT 로그인됨':'API 키 연결됨','연결 안 됨'),...gptBody));

  // Claude API 키
  grid.append(card('Claude API 키 (선택)','구독 대신 API 키로 Claude 를 쓰고 싶거나, 웹 배포용 봇에 Claude 를 쓸 때 필요해요.',badge(s.anthropic.apiKey.set,'API 키 연결됨'),keyForm('anthropic','Anthropic API 키','sk-ant-… 로 시작하는 키',s.anthropic.apiKey,refresh)));

  // Google
  grid.append(card('Google (라피스 계정)','캘린더·드라이브·문서·시트·메일을 연결해요. 파일을 바꾸는 작업은 항상 미리보기와 승인을 거쳐요.',badge(cloud.signedIn,cloud.user?.email||'로그인됨','로그인 필요'),
    put(node('div','row'),link(cloud.signedIn?'Google 서비스 설정 →':'라피스 계정 로그인 →','#account','btn primary'),link('캘린더 연동 →','#calendar','btn sm'))));

  // 로컬 AI
  const ob=[];
  if(!om.installed)ob.push(installBar('ollama','Ollama',det('ollama'),refresh));
  else{
    ob.push(node('p','small muted',om.running?`실행 중 · v${om.version}`:`설치됨 · v${om.version} (쓸 때 자동으로 켜져요)`));
    const list=node('div','chips');
    for(const m of om.models)list.append(put(node('span','chip on'),node('b','',m.name)));
    if(!om.models.length)list.append(node('p','small muted','내려받은 모델이 아직 없어요.'));
    ob.push(list);
    const prog=progressBox(),sel=node('select');
    for(const r of om.recommended){const o=node('option','',`${r.name} — ${r.label} (${r.size})`);o.value=r.name;sel.append(o);}
    const custom=input({placeholder:'다른 모델 이름 (선택)',maxLength:60});
    const pull=button('받기',async()=>{const name=custom.value.trim()||sel.value;pull.disabled=true;try{const job=await eng('/api/ollama/pull',{method:'POST',body:{name}});prog.update(job);const done=await watchJob(job.id,j=>prog.update(j));if(done.state==='error')throw new Error(done.error);toast('모델을 받았어요: '+name);refresh();}catch(e){toast(errorText(e),true);}finally{pull.disabled=false;}},'btn primary');
    ob.push(put(node('div','row wrap'),sel,custom,pull),prog.box);
  }
  grid.append(card('로컬 AI (Ollama)','내 PC에서 직접 돌리는 무료 AI. 인터넷 없이도, 요금 없이도 써요.',badge(om.installed&&om.models.length>0,`모델 ${om.models.length}개`,om.installed?'모델 필요':'설치 필요'),...ob));

  // Hermes
  grid.append(card('Hermes','스스로 배우는 개인 비서 에이전트.',badge(s.hermes.installed,'v'+s.hermes.version,'설치 필요'),
    installBar('hermes','Hermes',det('hermes'),refresh)||node('p','small muted','설치돼 있어요. 봇 스튜디오에서 Hermes 를 엔진으로 고를 수 있어요. Hermes 자체 설정은 `hermes setup` 으로 하거나 Hermes 앱에서 해요.')));

  // Cloudflare
  grid.append(card('Cloudflare (웹 배포용)','봇을 웹 주소로 배포할 때 쓰는 내 Cloudflare 계정 토큰이에요. 배포할 때만 필요해요.',badge(s.cloudflare.apiToken.set,'토큰 연결됨'),
    keyForm('cloudflare','Cloudflare API 토큰','API 토큰 붙여넣기',s.cloudflare.apiToken,refresh),
    node('p','small muted','토큰 만들기: Cloudflare 대시보드 → 프로필 → API 토큰 → 「Workers 편집」 템플릿.')));

  root.replaceChildren(grid);
}

registerPage('hub',{show(){render();}});
