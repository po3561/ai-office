// 방 현황: 봇들이 초대되어 있는 텔레그램 방과 주제를 한곳에서 자세히 본다(읽기 전용).
// 방 업무·연결을 바꾸는 곳은 각 봇의 설정 화면이고, 여기서는 「설정 열기」로 바로 갈 수 있다.
import {q,node,put,button,pill,link,registerPage,toast,errorText,friendly,fmtDate} from './ui.js';
import {eng} from './platform.js';

const STATUS={creator:['방장','ok'],administrator:['관리자','ok'],member:['참여 중','ok'],restricted:['제한됨','warn'],left:['나감','bad'],kicked:['강퇴됨','bad'],unknown:['확인 안 됨','']};
const TYPE={supergroup:'슈퍼그룹',group:'그룹',channel:'채널'};
const REPLY={mention:'봇을 부를 때만 답해요(@멘션·답장)',all:'모든 메시지에 답해요',unknown:'응답 방식 미정'};
const view={data:null,query:'',onlyConnected:false};

const when=v=>{if(!v)return '';const t=typeof v==='number'?(v<1e12?v*1000:v):v;return fmtDate(t);};
const agentLabel=a=>a?`${a.emoji?a.emoji+' ':''}${a.name}${a.inherited?' (봇 기본 역할)':''}`:'';
const text=r=>[r.title,r.id,...r.topics.map(t=>t.name)].join(' ').toLowerCase();

function line(label,value){return value?put(node('div','room-line'),node('span','muted',label),node('span','',value)):null;}

function topicRow(t){
  const row=node('div','room-topic');
  put(row,put(node('div','row wrap'),node('b','',t.name||'(이름 미확인)'),node('span','mono muted','#'+t.id),t.closed?pill('닫힘'):null,t.assignee?pill(agentLabel(t.assignee),'accent'):pill('방 설정 따름')),
    t.task?put(node('details','room-task'),node('summary','small','이 주제의 업무'),node('p','small',t.task)):null,
    t.lastSeen?node('p','small muted','마지막 대화 '+when(t.lastSeen)):null);
  return row;
}

function roomCard(r){
  const [stText,stCls]=STATUS[r.botStatus]||STATUS.unknown;
  const el=node('div','room-card');
  put(el,
    put(node('div','row wrap'),node('b','',r.title),pill(TYPE[r.type]||r.type||'방'),r.isForum?pill('주제 사용','accent'):null,pill('봇 '+stText,stCls),r.connected?pill('연결됨','ok'):pill('미연결','warn')),
    put(node('div','room-lines'),
      line('방 번호',r.id),
      line('초대한 사람',r.invitedBy?`${r.invitedBy.name||r.invitedBy.id}${r.invitedAt?' · '+when(r.invitedAt):''}`:''),
      line('마지막 대화',when(r.lastSeen)),
      line('참여 인원',r.memberCount!=null?r.memberCount+'명':''),
      line('응답 방식',r.connected?REPLY[r.replyMode]:'연결하면 응답해요'),
      line('허용된 계정',r.connected&&r.allowedCount?`${r.allowedCount}명만`:''),
      line('맡은 역할',agentLabel(r.assignee))),
    r.checkError?node('p','small warn-text','확인 메시지: '+r.checkError):null,
    r.task?put(node('details','room-task'),node('summary','small','이 방의 업무'),node('p','small',r.task)):null,
    r.topics.length?put(node('div','room-topics'),node('div','small muted',`주제 ${r.topics.length}개`),...r.topics.map(topicRow)):(r.isForum?node('p','small muted','아직 본 주제가 없어요. 주제 안에서 대화가 오가면 나타나요.'):null));
  return el;
}

function groupCard(g,filter){
  const rooms=g.rooms.filter(filter);
  const card=node('section','card');
  const settings=g.source==='lapis'?'#studio/'+encodeURIComponent(g.id):'#connect';
  put(card,put(node('div','card-head'),
    put(node('div'),node('h2','',g.name),node('p','sub',[g.source==='lapis'?'LAPIS 봇':'Claude 사무실',g.username?'@'+g.username:'',`방 ${g.total}개 · 연결 ${g.connected}개 · 주제 ${g.topics}개`].filter(Boolean).join(' · '))),
    put(node('div','row'),pill(g.running?'근무 중':'꺼짐',g.running?'ok':''),link('설정 열기',settings,'btn sm'))));
  if(!g.rooms.length)put(card,node('p','muted','아직 이 봇이 아는 방이 없어요. 봇을 그룹방에 초대한 뒤, 방에서 봇을 @멘션해 보세요.'));
  else if(!rooms.length)put(card,node('p','muted','조건에 맞는 방이 없어요.'));
  else put(card,put(node('div','room-list'),...rooms.map(roomCard)));
  return card;
}

function paint(){
  const body=q('#rooms-body');const d=view.data;
  const search=node('input');search.type='search';search.placeholder='방·주제 이름 찾기';search.value=view.query;search.setAttribute('aria-label','방 검색');
  search.addEventListener('input',()=>{view.query=search.value;paintList();});
  const only=node('input');only.type='checkbox';only.checked=view.onlyConnected;
  only.addEventListener('change',()=>{view.onlyConnected=only.checked;paintList();});
  const list=node('div','stack');
  function paintList(){
    const needle=view.query.trim().toLowerCase();
    const filter=r=>(!view.onlyConnected||r.connected)&&(!needle||text(r).includes(needle));
    list.replaceChildren(...d.groups.map(g=>groupCard(g,filter)));
  }
  paintList();
  const head=put(node('div','row between wrap'),
    put(node('div','row wrap'),pill(`봇 ${d.groups.length}개`),pill(`방 ${d.total}개`),pill(`연결된 방 ${d.connected}개`,'ok'),pill(`주제 ${d.topics}개`)),
    put(node('div','row wrap'),search,put(node('label','row nowrap small'),only,node('span','','연결된 방만')),button('새로고침',load,'btn sm')));
  body.replaceChildren(head,...(d.groups.length?[list]:[friendly('아직 봇이 없어요','봇을 만들고 텔레그램을 연결하면 초대된 방이 여기에 나타나요.',link('봇 스튜디오로 가기','#studio','btn primary'))]));
}

async function load(){
  try{view.data=await eng('/api/rooms');paint();}
  catch(e){q('#rooms-body').replaceChildren(node('p','banner bad',errorText(e)));toast(errorText(e),true);}
}

registerPage('rooms',{show(){load();}});
