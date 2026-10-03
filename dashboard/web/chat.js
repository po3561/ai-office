// 라피스(클라우드) 대화: 지난 대화 목록과 이어 말하기. 대화한 내용은 라피스가 기억·학습하는 재료가 된다.
import {q,qa,node,put,button,pill,emptyLine,cloud,toast,doing,errorText,fmtDate,registerPage} from './ui.js';
import {session,refreshSession,loginPrompt} from './account.js';

let conversationId=null,transcript=[],busy=false;

function bubble(role,text){
  const b=node('div','bubble '+(role==='user'?'me':'bot'));b.append(node('div','bubble-text',text));return b;
}
function paintTranscript(){
  const box=q('#lapis-transcript');box.replaceChildren();
  if(!transcript.length){box.append(node('p','empty-line','무엇이든 물어보거나, 오늘 할 일을 정리해 달라고 해 보세요. 라피스가 대화 내용을 기억하고 배웁니다.'));return;}
  transcript.forEach(m=>box.append(bubble(m.role,m.text)));
  box.scrollTop=box.scrollHeight;
}
async function loadList(){
  const list=q('#lapis-conversations');list.replaceChildren(emptyLine('불러오는 중…'));
  try{
    const data=await cloud('GET','/conversations');
    list.replaceChildren();
    const rows=(data.conversations||[]).slice(0,30);
    if(!rows.length)list.append(node('p','small muted','지난 대화가 없어요.'));
    for(const c of rows){
      const item=button('',()=>openConversation(c.id),'conv'+(c.id===conversationId?' on':''));
      put(item,node('b','',c.title||'제목 없는 대화'),node('small','muted',fmtDate(c.updated_at||c.last_message_at,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' · '+(c.message_count??0)+'개'));
      list.append(item);
    }
  }catch(error){list.replaceChildren(node('p','small muted','대화 목록을 읽지 못했습니다: '+errorText(error)));}
}
async function openConversation(id){
  await doing(null,async()=>{
    const data=await cloud('GET','/conversations/'+encodeURIComponent(id));
    conversationId=id;
    transcript=(data.messages||[]).filter(m=>String(m.content||'').trim()).map(m=>({role:m.role==='user'?'user':'assistant',text:String(m.content)}));
    paintTranscript();loadList();
  });
}
async function send(event){
  event.preventDefault();
  const input=q('#lapis-message'),message=input.value.trim();
  if(!message||busy)return;
  busy=true;const submit=q('#lapis-send');submit.disabled=true;submit.textContent='답을 쓰는 중…';
  transcript.push({role:'user',text:message});input.value='';paintTranscript();
  try{
    const data=await cloud('POST','/chat',{message,mode_hint:'',origin:'web',...(conversationId?{conversation_id:conversationId}:{})});
    if(typeof data.response!=='string')throw new Error('라피스 응답 형식이 올바르지 않습니다.');
    if(typeof data.conversation_id==='string')conversationId=data.conversation_id;
    transcript.push({role:'assistant',text:data.response});paintTranscript();loadList();
  }catch(error){
    transcript.push({role:'assistant',text:'⚠️ '+errorText(error)});paintTranscript();toast(errorText(error),true);
  }finally{busy=false;submit.disabled=false;submit.textContent='보내기';}
}
async function renderLapis(){
  const box=q('#chat-lapis');
  if(!session.loaded)await refreshSession();
  if(!session.signedIn){box.replaceChildren(loginPrompt('라피스와 대화하려면 라피스 계정으로 로그인하세요. (Hermes 탭은 로그인 없이 쓸 수 있어요)'));return;}
  if(!q('#lapis-transcript')){
    box.replaceChildren();
    box.innerHTML=`<div class="chat-layout"><aside class="chat-side card"><div class="row between"><b>지난 대화</b></div><div id="lapis-conversations" class="conv-list"></div></aside>
      <section class="chat-main card"><div class="card-head"><div><h2>라피스</h2><p class="sub">대화는 라피스 계정에 저장되고, 라피스가 기억·학습하는 재료가 돼요.</p></div></div>
      <div id="lapis-transcript" class="transcript" aria-live="polite"></div>
      <form id="lapis-form"><label class="sr-only" for="lapis-message">메시지</label><textarea id="lapis-message" rows="3" maxlength="4000" placeholder="라피스에게 말해 보세요. (Ctrl+Enter로 보내기)"></textarea>
      <div class="row between" style="margin-top:10px"><span class="small muted">서버의 라피스가 답합니다.</span><span class="row"><button type="button" id="lapis-new" class="btn">새 대화</button><button id="lapis-send" class="btn primary" type="submit">보내기</button></span></div></form></section></div>`;
    q('#lapis-form').addEventListener('submit',send);
    q('#lapis-message').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();q('#lapis-form').requestSubmit();}});
    q('#lapis-new').addEventListener('click',()=>{conversationId=null;transcript=[];paintTranscript();loadList();q('#lapis-message').focus();});
  }
  paintTranscript();loadList();
}
function setTab(tab){
  qa('[data-chat-tab]').forEach(b=>b.classList.toggle('on',b.dataset.chatTab===tab));
  q('#chat-lapis').hidden=tab!=='lapis';q('#chat-hermes').hidden=tab!=='hermes';
  if(tab==='lapis')renderLapis();
}
q('#chat-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-chat-tab]');if(b)setTab(b.dataset.chatTab);});
document.addEventListener('cloud:state',()=>{if(!q('#chat-lapis').hidden&&q('#view-chat')&&!q('#view-chat').hidden){q('#lapis-transcript')?.closest('.chat-layout')?.remove();renderLapis();}});
registerPage('chat',{show(){setTab(q('#chat-hermes').hidden?'lapis':'hermes');}});
