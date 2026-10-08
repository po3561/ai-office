import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractItems,createTelegramSync} from '../src/telegram-sync.mjs';
import {createTaskStore} from '../src/tasks.mjs';
import {createCalendarStore} from '../src/calendar.mjs';
import {createDashboardServer} from '../src/server.mjs';

const WED=new Date(2026,9,7,9,0);   // 2026-10-07 수요일 오전 9시(이 PC 의 시간대)
const sum=(text,role='user')=>extractItems(text,{at:WED,role}).map(i=>[i.kind,i.date,i.allDay?'종일':i.time||'',i.title].join(' '));

test('내가 보낸 한 줄 일정: 날짜·시각·제목을 뽑는다', () => {
  assert.deepEqual(sum('내일 오후 3시 팀 회의'),['event 2026-10-08 15:00 팀 회의']);
  assert.deepEqual(sum('10월 9일 14:00~15:30 거래처 미팅 있어요'),['event 2026-10-09 14:00 거래처 미팅']);
  assert.deepEqual(sum('15일 오전 10시 치과'),['event 2026-10-15 10:00 치과']);
  assert.deepEqual(sum('2026-10-20 에어컨 점검'),['event 2026-10-20 종일 에어컨 점검']);
  assert.deepEqual(sum('다음주 월요일 휴가'),['event 2026-10-12 종일 휴가']);
  assert.deepEqual(sum('이번주 금요일 오후 4시 30분 발표'),['event 2026-10-09 16:30 발표']);
  const [range]=extractItems('내일 2시부터 4시까지 교육',{at:WED});
  assert.equal(new Date(range.end)-new Date(range.start),2*3600000);
});

test('마감·할 일 표현은 그날의 할 일이 된다', () => {
  assert.deepEqual(sum('금요일까지 보고서 제출'),['task 2026-10-09  보고서 제출']);
  assert.deepEqual(sum('할일: 세금계산서 발행'),['task 2026-10-07  세금계산서 발행']);
  assert.deepEqual(sum('내일 5시까지 견적서 보내기'),['task 2026-10-08 17:00 견적서 보내기']);
});

test('일반 대화·질문은 일정으로 만들지 않는다', () => {
  for(const text of ['안녕 오늘 날씨 어때?','3시에 알려줘','내일 비 온대','3/4 완료했어요','내일 3시간 정도 걸려','오늘은 좀 피곤하다'])
    assert.deepEqual(sum(text),[],text);
});

test('목록 머리말 아래 줄은 그 날짜의 일정·할 일이 된다', () => {
  assert.deepEqual(sum('오늘 일정\n- 10:00 주간회의\n- 오후 2시 고객 전화\n- 점심 약속\n할 일\n- 견적서 보내기\n- [x] 메일 확인'),[
    'event 2026-10-07 10:00 주간회의','event 2026-10-07 14:00 고객 전화','event 2026-10-07 종일 점심 약속','task 2026-10-07  견적서 보내기','task 2026-10-07  메일 확인']);
  assert.equal(extractItems('할 일\n- [x] 메일 확인',{at:WED})[0].done,true);
});

test('봇이 올린 일정 목록은 읽고, 대화 한 줄은 읽지 않는다', () => {
  assert.deepEqual(sum('📅 오늘의 일정 (10/8)\n1. 09:30 스탠드업\n2. 16:00 ~ 17:00 디자인 리뷰\n\n📋 할 일\n- 보고서 초안','assistant'),[
    'event 2026-10-08 09:30 스탠드업','event 2026-10-08 16:00 디자인 리뷰','task 2026-10-08  보고서 초안']);
  assert.deepEqual(sum('내일 3시에 알려드릴게요!','assistant'),[]);
  assert.deepEqual(sum('✅ 등록했어요: 내일 15:00 팀 회의','assistant'),[]);
});

test('줄바꿈 없이 한 줄로 저장된 봇의 업무보고도 "오늘 할 일" 만 읽는다', () => {
  const report='☀️ 오늘의 업무보고 · 2026. 10. 7.(수) 📋 오늘 할 일 1️⃣ 견적서 검토 — 영업팀 (고객사 요청 건, 오후까지) 2️⃣ 재고 실사 준비 — 창고팀 ⏳ 이어서 진행 중 • 신규 거래처 등록 — 검수 대기 📦 반납 예정 0건 · 연체 0건 🎪 7일 안 행사: 등록된 행사 없음 🔐 확인 필요: 방화벽 허용, 로그인 계정';
  assert.deepEqual(sum(report,'assistant'),['task 2026-10-07  견적서 검토 — 영업팀','task 2026-10-07  재고 실사 준비 — 창고팀']);
  assert.deepEqual(sum('오늘 일정 • 10:00 주간회의 • 14:00 고객 전화'),['event 2026-10-07 10:00 주간회의','event 2026-10-07 14:00 고객 전화']);
});

test('동기화: 같은 이름의 열린 할 일은 날마다 새로 만들지 않는다', async () => {
  const {tasks,messages,sync,at}=await fixture();
  messages.push({id:'a',botId:'kao',role:'assistant',text:'📋 어제 할 일 1️⃣ 재고 실사 준비 — 창고팀',at:at(60*20)});
  messages.push({id:'b',botId:'kao',role:'assistant',text:'📋 오늘 할 일 1️⃣ 재고 실사 준비 — 창고팀 2️⃣ 견적서 검토',at:at(5)});
  await sync.run();
  assert.deepEqual((await tasks.list()).map(t=>t.title).sort(),['견적서 검토','재고 실사 준비 — 창고팀']);
});

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'lapis-tgsync-'));
  const tasks=createTaskStore(join(dir,'tasks.json')),calendar=createCalendarStore(join(dir,'calendar.json'));
  const messages=[];
  const nowMs=WED.getTime()+3600000;
  const at=offsetMin=>new Date(nowMs-offsetMin*60000).toISOString();
  const sync=createTelegramSync({tasks,calendar,snapshot:async()=>({bots:[{id:'kao',name:'카오 · Claude Office'}],messages}),stateFile:async()=>join(dir,'sync.json'),now:()=>nowMs});
  return {dir,tasks,calendar,messages,sync,at};
}

test('동기화: 일정은 캘린더에, 그날의 할 일에도 함께 올라가고 한 번만 만든다', async () => {
  const {tasks,calendar,messages,sync,at}=await fixture();
  messages.push({id:'kao:1',botId:'kao',role:'user',text:'내일 오후 3시 팀 회의',at:at(30)});
  messages.push({id:'kao:2',botId:'kao',role:'assistant',text:'📋 할 일\n- 보고서 초안\n- 오늘 7시 저녁 약속',at:at(20)});
  messages.push({id:'kao:3',botId:'kao',role:'user',text:'그냥 잡담이에요',at:at(10)});
  const first=await sync.run();
  assert.deepEqual(first.added,{events:2,tasks:3});
  const events=await calendar.all();
  assert.deepEqual(events.map(e=>e.title).sort(),['저녁 약속','팀 회의']);
  assert.ok(events.every(e=>e.source==='local'&&/텔레그램에서 자동 등록/.test(e.notes)));
  assert.deepEqual((await tasks.list()).map(t=>[t.title,t.due,t.owner]).sort(),[['15:00 팀 회의','2026-10-08','me'],['19:00 저녁 약속','2026-10-07','me'],['보고서 초안','2026-10-07','me']]);
  const again=await sync.run();
  assert.deepEqual(again.added,{events:0,tasks:0});
  assert.equal((await calendar.all()).length,2);
});

test('동기화: 같은 내용을 다시 말해도, 이미 있는 일정은 중복으로 만들지 않는다', async () => {
  const {calendar,messages,sync,at}=await fixture();
  await calendar.create({title:'팀 회의',allDay:false,start:new Date(2026,9,8,15,0).toISOString(),end:new Date(2026,9,8,16,0).toISOString()});
  messages.push({id:'kao:1',botId:'kao',role:'user',text:'내일 오후 3시 팀 회의',at:at(30)});
  messages.push({id:'kao:2',botId:'kao',role:'assistant',text:'📅 일정\n- 내일 15:00 팀 회의',at:at(20)});
  const result=await sync.run();
  assert.equal(result.added.events,0);
  assert.equal((await calendar.all()).length,1);
});

test('동기화: 지운 항목은 되살아나지 않고, 첫 실행은 하루보다 묵은 대화를 읽지 않는다', async () => {
  const {tasks,messages,sync,at}=await fixture();
  messages.push({id:'old',botId:'kao',role:'user',text:'할일: 오래된 일',at:at(60*30)});
  messages.push({id:'new',botId:'kao',role:'user',text:'할일: 새 일',at:at(5)});
  await sync.run();
  const [made]=await tasks.list();
  assert.equal(made.title,'새 일');
  await tasks.remove(made.id);
  await sync.run();
  assert.deepEqual(await tasks.list(),[]);
});

test('동기화: 끄면 아무것도 만들지 않고, 다시 켜면 그 사이 대화도 이어서 반영한다', async () => {
  const {tasks,messages,sync,at}=await fixture();
  await sync.configure({enabled:false});
  messages.push({id:'a',botId:'kao',role:'user',text:'할일: 전화하기',at:at(5)});
  assert.equal((await sync.run()).skipped,'off');
  assert.deepEqual(await tasks.list(),[]);
  await sync.configure({enabled:true,makeTasks:false});
  await sync.run();
  assert.equal((await tasks.list()).length,1);
});

test('서버: /api/telegram 이 새 일정·할 일을 반영하고 /api/telegram/sync 로 켜고 끈다', async t => {
  const dir=await mkdtemp(join(tmpdir(),'lapis-tgsync-'));
  const at=new Date(Date.now()-60000).toISOString();
  const server=createDashboardServer({requireLogin:false,dataDir:dir,officeUrl:'http://127.0.0.1:9',rentalUrl:'http://127.0.0.1:9',cloudBase:'https://cloud.test/api/v1',
    telegramSnapshot:async()=>({bots:[{id:'kao',name:'카오'}],messages:[{id:'kao:1',botId:'kao',role:'user',text:'내일 오후 3시 팀 회의',at}]})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port,write={'content-type':'application/json','x-lapis-request':'1'};
  const data=await (await fetch(base+'/api/telegram')).json();
  assert.equal(data.messages.length,1);
  assert.deepEqual(data.sync.added,{events:1,tasks:1});
  const {tasks}=await (await fetch(base+'/api/tasks')).json();
  assert.equal(tasks[0].title,'15:00 팀 회의');
  const off=await fetch(base+'/api/telegram/sync',{method:'PUT',headers:write,body:JSON.stringify({enabled:false})});
  assert.equal((await off.json()).enabled,false);
  assert.equal((await fetch(base+'/api/telegram/sync',{method:'PUT',body:'{}'})).status,403);
  const saved=JSON.parse(await readFile(join(dir,'telegram-sync.json'),'utf8'));
  assert.equal(saved.enabled,false);
});
