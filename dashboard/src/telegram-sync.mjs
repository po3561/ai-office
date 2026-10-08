// 텔레그램 ↔ 일정·할 일 자동 반영.
// 봇과 나눈 대화(내가 보낸 일정, 봇이 올린 일정·할 일 목록)를 읽어 캘린더 일정과 그날의 할 일로 옮긴다.
// 읽기만 한다: 텔레그램을 직접 부르지 않고, 수신 프로그램이 남긴 기록(telegramSnapshot)만 본다.
// 같은 메시지는 한 번만 처리하고, 같은 내용(종류·날짜·시각·제목)은 한 번만 만든다. 지운 일정이 되살아나지 않도록 처리한 메시지 번호를 기억한다.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';

const pad=n=>String(n).padStart(2,'0');
export const dayKey=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const clock=d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
const shift=(base,n)=>new Date(base.getFullYear(),base.getMonth(),base.getDate()+n);
const ymd=(y,m,d)=>{const t=new Date(y,m-1,d);return t.getFullYear()===y&&t.getMonth()===m-1&&t.getDate()===d?t:null;};
// 연도 없는 날짜는 메시지를 보낸 해로 하되, 반년 넘게 지난 날짜면 다음 해로 본다(12월에 보낸 "1월 5일").
const monthDay=(m,d,base)=>{
  let t=ymd(base.getFullYear(),m,d);if(!t)return null;
  if(t.getTime()-shift(base,0).getTime()<-180*86400000)t=ymd(base.getFullYear()+1,m,d);
  return t;
};

// 조사는 바로 뒤에 한글이 이어지지 않을 때만 조사로 본다("에어컨" 의 "에" 를 떼지 않도록).
const SFX='((?:에서|에는|에|부터|까지|은|는|쯤|경|엔)(?![가-힣]))?';
const WEEK={일:0,월:1,화:2,수:3,목:4,금:5,토:6};
const DATE_RULES=[
  [new RegExp(`(\\d{4})\\s*[-./년]\\s*(\\d{1,2})\\s*[-./월]\\s*(\\d{1,2})\\s*일?${SFX}`),(m)=>ymd(+m[1],+m[2],+m[3]),4],
  [new RegExp(`(?<![\\d:/.])(\\d{1,2})\\s*월\\s*(\\d{1,2})\\s*일${SFX}`),(m,b)=>monthDay(+m[1],+m[2],b),3],
  [new RegExp(`(?<![\\d:/.])(\\d{1,2})\\s*[/.]\\s*(\\d{1,2})(?![\\d:/.]|\\s*(?:시|분|%|개|명|원|만|번))${SFX}`),(m,b)=>monthDay(+m[1],+m[2],b),3],
  [new RegExp(`(?<![가-힣])(내일모레|글피|모레|내일|명일|오늘|금일|당일)${SFX}`),(m,b)=>shift(b,{내일모레:2,글피:3,모레:2,내일:1,명일:1}[m[1]]??0),2],
  [new RegExp(`(다다음\\s*주|다음\\s*주|담주|차주|이번\\s*주)?\\s*([월화수목금토일])\\s*(?:요일|욜)${SFX}`),(m,b)=>{
    const target=WEEK[m[2]],prefix=(m[1]||'').replace(/\s/g,'');
    if(!prefix)return shift(b,(target-b.getDay()+7)%7);
    const monday=shift(b,-((b.getDay()+6)%7));
    return shift(monday,((target+6)%7)+(prefix==='이번주'?0:prefix==='다다음주'?14:7));
  },3],
  [new RegExp(`(?<![\\d월/.])(\\d{1,2})\\s*일(?!간|동안|치|씩|전|후|\\s*(?:안|이내|내))${SFX}`),(m,b)=>{
    const d=+m[1];if(d<1||d>31)return null;
    return ymd(b.getFullYear(),b.getMonth()+1,d)&&d>=b.getDate()?ymd(b.getFullYear(),b.getMonth()+1,d):ymd(b.getFullYear(),b.getMonth()+2,d);
  },2],
];
// 한 줄에서 날짜 표현 하나를 뽑는다. 뽑은 부분은 지워서 돌려준다.
function takeDate(line,base){
  for(const [re,make,sfxAt] of DATE_RULES){
    const m=re.exec(line);if(!m)continue;
    const date=make(m,base);if(!date)continue;
    return {date,deadline:m[sfxAt]==='까지',text:line.slice(0,m.index)+' '+line.slice(m.index+m[0].length)};
  }
  return {date:null,deadline:false,text:line};
}

const TIME_RE=/(?<![\d:])(?:(오전|오후|아침|점심|저녁|밤|새벽)\s*)?(\d{1,2})\s*(?::\s*(\d{2})(?!\d)|시(?!간)\s*(?:(\d{1,2})\s*분|(반))?)((?:에서|에는|에|부터|까지|쯤|경)(?![가-힣]))?/g;
function hourOf(h,mer,colon){
  if(h>24)return null;
  if(mer==='오후'||mer==='저녁'||mer==='밤')return h<12?h+12:(mer==='밤'&&h===12?0:h);
  if(mer==='점심')return h<=4?h+12:h;
  if(mer==='오전'||mer==='새벽'||mer==='아침')return h===12?0:h;
  // 시간대를 안 적은 "3시 회의"는 낮 시간으로 본다. "15:00" 같은 24시간 표기는 그대로 둔다.
  return !colon&&h>=1&&h<=6?h+12:h;
}
// 한 줄에서 시각(또는 "2시~4시" 범위)을 뽑는다.
function takeTime(line){
  const found=[];
  // "7시 저녁 약속" 처럼 시간대 말이 시각 뒤에 오면 그것을 따른다.
  const lineMer=/(저녁|야간|퇴근)/.test(line)?'저녁':/(새벽|출근)/.test(line)?'새벽':/(점심|오후)/.test(line)?'오후':/(아침|오전)/.test(line)?'오전':'';
  for(const m of line.matchAll(TIME_RE)){
    const colon=m[3]!==undefined,min=colon?+m[3]:m[5]?30:m[4]?+m[4]:0;
    const hour=hourOf(+m[2],m[1]||lineMer,colon);
    if(hour===null||min>59||(hour===24&&min>0))continue;
    found.push({index:m.index,len:m[0].length,hour:hour%24,min,suffix:m[6]||''});
    if(found.length===2)break;
  }
  if(!found.length)return {time:null,text:line};
  const [a,b]=found;let end=null,cut=a.index+a.len;
  if(b){
    const between=line.slice(a.index+a.len,b.index);
    if(/^\s*[~\-–∼]\s*$/.test(between)||(a.suffix==='부터'&&/^\s*$/.test(between))){end={hour:b.hour,min:b.min};cut=b.index+b.len;}
  }
  return {time:{hour:a.hour,min:a.min,end,deadline:!end&&a.suffix==='까지'},text:line.slice(0,a.index)+' '+line.slice(cut)};
}

const HEADER_WORD=/(일정|스케줄|할\s?일|브리핑|업무\s?보고|todo|to-?do|계획|agenda|리스트|목록|체크리스트)/i;
const TASK_WORD=/(할\s?일|todo|to-?do|체크리스트)/i;
const TASKY=/(까지|마감|제출|해야|하기|준비|보내|작성|확인|정리|예약|신청|결제|연락|전화|구매|납부|송금|수정|검토|발송|보고서)/;
const EVENTY=/(회의|미팅|약속|생일|휴가|출장|방문|면접|행사|예약|점검|수업|강의|모임|파티|여행|시험|세미나|워크숍|워크샵|검진|진료|병원|치과|수술|발표|공연|결혼|기념일|휴무|연차|반차|당직|회식|상담|인터뷰|교육|훈련|납품|입고|출고|견학|촬영|대여|반납)/;
const ASKING=/(알려\s?줘|알려\s?주세요|알려\s?줄래|가르쳐\s?줘|보여\s?줘|뭐야|뭐예요|뭐지|언제야|언제예요|검색)/;
const TAIL=/\s+(있어요?|있음|있습니다|있대|있네|잡혔[다어요]*|예정(?:이야|입니다|이에요)?|이야|입니다|이에요|이다)\s*[.!~]*$/;
const BULLET=/^(?:[-*•·▪▫◦‣▶▷➤>→]\s*|\d{1,2}[.)]\s+|[①-⑩]\s*|\d{1,2}️?⃣\s*)/;
const NEGATIVE=/(없음|없습니다|없어요|해당\s?없|0\s?건)\s*[.!]*$/;
const FORCE=/^\[?(?:(일정|약속|스케줄|캘린더)|(할\s?일|todo|to-?do|해야\s?할\s?일))\]?(?=\s|[:：\-–]|$)\s*[:：\-–]?\s*/i;

const norm=s=>String(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
function tidy(s){
  return s.replace(/\(\s*[월화수목금토일]\s*\)/g,' ').replace(/[\p{Extended_Pictographic}\uFE0F\u200d]/gu,' ')
    .replace(/\s+/g,' ').replace(/^[\s,.:：;\-–—~·•|/]+|[\s,.:：;\-–—~·•|/]+$/g,'').replace(TAIL,'').trim();
}

// 줄바꿈 없이 한 덩어리로 저장된 글(Claude 텔레그램 플러그인 기록 등)은 번호(1️⃣)·목록 기호(•)·이모지 머리말 앞에서 줄을 나눈다.
const segment=text=>/\n/.test(text)?text:text.replace(/\s+(?=(?:\d️?⃣|•|\p{Extended_Pictographic}(?!️?⃣)))/gu,'\n');

// 메시지 한 통에서 일정·할 일 후보를 뽑는다.
//  · 날짜나 시각이 있는 줄, "일정/할일" 머리말이 붙은 줄, 목록 머리말(📅 오늘 일정, 📋 할 일) 아래의 목록 줄만 본다. 일반 대화는 건드리지 않는다.
//  · 봇이 쓴 글(role=assistant)은 일정·할 일 목록처럼 보일 때만 읽는다.
export function extractItems(text,{at=new Date(),role='user'}={}){
  const base=new Date(at);if(Number.isNaN(base.getTime()))return [];
  const lines=segment(String(text??'').replace(/\r/g,'')).split('\n').map(s=>s.trim()).filter(Boolean).slice(0,60);
  const items=[];let ctx={date:null,mode:null},listed=false;
  for(const raw of lines){
    if(items.length>=20)break;
    let line=raw.replace(/\*\*|`/g,''),bullet=false,done=/^\s*(?:✅|☑|✔|\[x\])/i.test(raw);
    for(let i=0;i<4;i++){
      const before=line;
      line=line.replace(/^[\s\p{Extended_Pictographic}\uFE0F\u200d\u20e3]+/u,'');
      const b=BULLET.exec(line);if(b){bullet=true;line=line.slice(b[0].length);}
      const c=/^\[([ xX]?)\]\s*/.exec(line);if(c){bullet=true;if(/x/i.test(c[1]))done=true;line=line.slice(c[0].length);}
      if(line===before)break;
    }
    line=line.replace(/^\/(?=일정|할)/,'');
    let forced=null;
    const f=FORCE.exec(line);
    if(f){forced=f[1]?'event':'task';line=line.slice(f[0].length);}
    const question=/[?？]\s*$/.test(line)||ASKING.test(line);
    if(question&&!forced)continue;

    const d=takeDate(line,base),t=takeTime(d.text);
    const title=tidy(t.text);
    const wordOnly=title.replace(HEADER_WORD,'').replace(/(오늘의|오늘|내일|모레|이번|다음|주간|일간|금일)/g,'').replace(/[의은는입니다이에요]/g,'').replace(/[\s\p{P}]+/gu,'');
    // 머리말: "📅 오늘 일정", "할 일:", "일정" … 아래 목록 줄의 기본 날짜·종류가 된다.
    if(!t.time&&((forced&&!title)||(HEADER_WORD.test(title)&&wordOnly.length<=2)||(HEADER_WORD.test(raw)&&/[:：]\s*$/.test(line)&&title.length<=14))){
      ctx={date:d.date??ctx.date,mode:forced??(TASK_WORD.test(raw)?'task':'event')};listed=true;continue;
    }
    // 날짜만 적힌 줄("10/8 (수)")은 아래 줄들의 날짜가 된다.
    if(d.date&&!t.time&&title.length<2){ctx={...ctx,date:d.date};listed=true;continue;}
    if(title.length<2)continue;
    if(NEGATIVE.test(title)&&!forced)continue;
    // 날짜·시각 없는 일반 문장은 목록을 끝낸다("⏳ 이어서 진행 중 • …" 처럼 다른 구역의 목록이 일정으로 섞이지 않게).
    if(!d.date&&!t.time&&!forced&&!bullet){ctx={...ctx,mode:null};listed=false;continue;}

    const inList=listed&&bullet;
    if(!d.date&&!t.time&&!forced&&!inList)continue;
    if(role==='assistant'&&!d.date&&!t.time&&!inList)continue;
    const date=d.date??ctx.date??shift(base,0);
    const deadline=d.deadline||Boolean(t.time?.deadline);
    let kind;
    if(forced)kind=forced;
    else if(deadline)kind='task';
    else if(t.time)kind='event';
    else if(inList)kind=ctx.mode==='task'?'task':'event';
    else if(TASKY.test(title))kind='task';
    else if(EVENTY.test(title))kind='event';
    else continue;   // 날짜만 들어간 평범한 말("내일 비 온대")은 일정으로 보지 않는다
    const item={kind,title:title.replace(/\s*\([^)]{12,}\)\s*$/,'').slice(0,200),date:dayKey(date),done,line:raw.slice(0,300)};
    if(t.time&&kind==='event'){
      const start=new Date(date.getFullYear(),date.getMonth(),date.getDate(),t.time.hour,t.time.min);
      let end=t.time.end?new Date(date.getFullYear(),date.getMonth(),date.getDate(),t.time.end.hour,t.time.end.min):new Date(start.getTime()+3600000);
      if(end<=start)end=new Date(end.getTime()+(t.time.end?86400000:3600000));
      Object.assign(item,{allDay:false,start:start.toISOString(),end:end.toISOString(),time:clock(start)});
    }else{
      if(t.time)item.time=`${pad(t.time.hour)}:${pad(t.time.min)}`;
      if(kind==='event')Object.assign(item,{allDay:true,start:item.date,end:item.date});
    }
    items.push(item);
  }
  // 봇이 쓴 글은 목록·머리말이 있는 것만 일정으로 본다. ("내일 3시에 알려드릴게요" 같은 대화 한 줄은 제외)
  if(role==='assistant'&&!(listed||items.length>=2))return [];
  return items;
}

const keyOf=(kind,date,time,title)=>`${kind}|${date}|${time||''}|${norm(title)}`;
const fingerprint=(...parts)=>createHash('sha1').update(keyOf(...parts)).digest('hex').slice(0,20);
const MAX_PROCESSED=3000,MAX_CREATED=3000,MAX_LOG=30,FIRST_RUN_LOOKBACK_MS=24*3600000;

export function createTelegramSync({tasks,calendar,snapshot,stateFile,now=()=>Date.now()}){
  let running=null;
  const blank=()=>({version:1,enabled:true,makeTasks:true,since:null,processed:[],created:{},changes:0,lastRunAt:null,lastError:'',log:[]});
  async function load(){
    try{
      const parsed=JSON.parse(await readFile(await stateFile(),'utf8'));
      if(parsed?.version!==1||!Array.isArray(parsed.processed))throw new Error('format');
      return {...blank(),...parsed};
    }catch(error){
      if(error?.code==='ENOENT')return blank();
      // 깨진 기록은 버리고 새로 시작한다(처리한 메시지를 잊어도 같은 내용은 중복 검사로 걸러진다).
      return blank();
    }
  }
  async function save(state){
    const file=await stateFile();
    await mkdir(dirname(file),{recursive:true});
    const temp=file+'.'+process.pid+'.tmp';
    await writeFile(temp,JSON.stringify(state));await rename(temp,file);
  }
  const view=state=>({enabled:state.enabled,makeTasks:state.makeTasks,lastRunAt:state.lastRunAt,lastError:state.lastError,changes:state.changes,recent:state.log.slice(0,8)});

  async function existingKeys(){
    const keys=new Set();
    try{
      for(const e of await calendar.all())keys.add(e.allDay?keyOf('event',e.start,'',e.title):keyOf('event',dayKey(new Date(e.start)),clock(new Date(e.start)),e.title));
    }catch{ /* 일정을 못 읽어도 기록된 지문으로 중복을 막는다 */ }
    try{for(const t of await tasks.list()){if(t.due)keys.add(keyOf('task',t.due,'',t.title));if(!t.done)keys.add(keyOf('open','','',t.title));}}catch{ /* 위와 같다 */ }
    return keys;
  }

  async function execute(source){
    const state=await load();
    if(!state.enabled)return {scanned:0,added:{events:0,tasks:0},skipped:'off',...view(state)};
    const data=source??await snapshot();
    const messages=[...(data?.messages??[])].filter(m=>m&&typeof m.id==='string'&&typeof m.text==='string'&&m.at).sort((a,b)=>a.at.localeCompare(b.at));
    const firstRun=!state.since;
    if(firstRun)state.since=new Date(now()-FIRST_RUN_LOOKBACK_MS).toISOString();
    const seen=new Set(state.processed),known=new Set(Object.keys(state.created));
    const botName=id=>(data?.bots??[]).find(b=>b.id===id)?.name??'텔레그램 봇';
    const result={scanned:0,added:{events:0,tasks:0}};
    let existing=null;
    for(const m of messages){
      if(seen.has(m.id))continue;
      seen.add(m.id);state.processed.push(m.id);
      if(m.at<state.since)continue;
      if(m.role!=='user'&&m.role!=='assistant')continue;
      result.scanned++;
      const who=m.role==='user'?'내 메시지':botName(m.botId)+' 메시지';
      for(const item of extractItems(m.text,{at:new Date(m.at),role:m.role})){
        const wants=[];
        if(item.kind==='event'){
          wants.push({type:'event',fp:fingerprint('event',item.date,item.allDay?'':item.time,item.title),key:keyOf('event',item.date,item.allDay?'':item.time,item.title),item});
          if(state.makeTasks){const title=item.time?`${item.time} ${item.title}`:item.title;wants.push({type:'task',fp:fingerprint('task',item.date,'',title),key:keyOf('task',item.date,'',title),item,title});}
        }else wants.push({type:'task',fp:fingerprint('task',item.date,'',item.title),key:keyOf('task',item.date,'',item.title),item,title:item.title});
        for(const w of wants){
          if(known.has(w.fp))continue;
          existing??=await existingKeys();
          // 같은 이름의 할 일이 아직 안 끝나 있으면 매일 새로 만들지 않는다(봇이 "이어서 진행 중" 일을 날마다 올려도 한 개로 유지).
          if(existing.has(w.key)||(w.type==='task'&&existing.has(keyOf('open','','',w.title)))){known.add(w.fp);continue;}
          const note=`텔레그램에서 자동 등록 · ${who}`;
          let created;
          try{
            created=w.type==='event'
              ?await calendar.create({title:w.item.title,allDay:w.item.allDay,start:w.item.start,end:w.item.end,notes:`${note}\n원문: ${w.item.line}`,color:'sky'})
              :await tasks.create({title:w.title,due:w.item.date,owner:'me',notes:w.item.kind==='event'?`${note} · 일정`:`${note}${w.item.time?' · '+w.item.time:''}`,done:w.item.done});
          }catch{continue;}   // 한도 초과 등으로 못 만든 항목은 건너뛰고 다음 항목을 계속 본다
          known.add(w.fp);existing.add(w.key);if(w.type==='task'&&!w.item.done)existing.add(keyOf('open','','',w.title));
          state.created[w.fp]={type:w.type,id:created.id,at:new Date(now()).toISOString()};
          result.added[w.type==='event'?'events':'tasks']++;state.changes++;
          if(w.type==='event'||w.item.kind==='task')state.log.unshift({at:new Date(now()).toISOString(),kind:w.item.kind,title:w.item.title,date:w.item.date,time:w.item.time||'',from:who});
        }
      }
    }
    state.processed=state.processed.slice(-MAX_PROCESSED);
    const keys=Object.keys(state.created);
    if(keys.length>MAX_CREATED)for(const k of keys.slice(0,keys.length-MAX_CREATED))delete state.created[k];
    state.log=state.log.slice(0,MAX_LOG);
    state.lastRunAt=new Date(now()).toISOString();state.lastError='';
    await save(state);
    return {...result,...view(state)};
  }

  return {
    // 한 번에 하나만 돈다. 동시에 불리면 돌고 있는 결과를 함께 받는다.
    run(source){
      running??=execute(source).finally(()=>{running=null;});
      return running;
    },
    async status(){return view(await load());},
    async configure({enabled,makeTasks}={}){
      const state=await load();
      if(typeof enabled==='boolean')state.enabled=enabled;
      if(typeof makeTasks==='boolean')state.makeTasks=makeTasks;
      await save(state);return view(state);
    },
  };
}
