import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const L = await import('../src/rooms-legacy.mjs');

const TEAMS = [{ key: 'event-planner', name: '행사기획팀' }, { key: 'rental-manager', name: '물품관리팀' }, { key: 'pr-marketer', name: '홍보마케팅팀' }];
const ROOM = '-555000111';
const json = (d, name) => JSON.parse(readFileSync(join(d, name), 'utf8'));

function legacyDir(name = 'tg') {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  const put = (f, v) => writeFileSync(join(d, f), JSON.stringify(v, null, 2));
  put('access.json', { dmPolicy: 'pairing', allowFrom: ['111222333'], groups: { [ROOM]: { requireMention: false, allowFrom: ['111222333'] } } });
  put('chats.json', { [ROOM]: { topics: { 149: { name: '월례회', last_seen: '2026-09-28T09:38:38Z' }, 863: { name: '네버랜드' }, 12036: {} } } });
  put('rooms.json', { [ROOM]: { topics: { 149: { name: '월례회', team: 'event-planner' } }, live: { title: '기획부', type: 'supergroup', is_forum: true, bot_status: 'administrator' } } });
  put('routines.json', { chat_id: ROOM, thread_id: '863', room: '기획부', topic: '네버랜드', morning: { time: '08:00', enabled: true }, evening: { time: '22:00', enabled: true } });
  writeFileSync(join(d, '.env'), 'TELEGRAM_BOT_TOKEN=123456:SECRETSECRETSECRET\n');
  return d;
}

test('예전 형식(방 ID 가 키)과 새 형식(rooms 래퍼)을 구분한다', () => {
  const d = legacyDir();
  assert.equal(L.isLegacy(d), true);
  const fresh = join(root, 'fresh'); mkdirSync(fresh);
  writeFileSync(join(fresh, 'rooms.json'), JSON.stringify({ rooms: {}, defaultTask: '' }));
  assert.equal(L.isLegacy(fresh), false);
  assert.equal(L.isLegacy(join(root, 'nope')), false);
});

test('방·주제 목록에 담당 팀 이름과 연결·호출어 기본값이 보인다', () => {
  const d = legacyDir('t1');
  const [room] = L.listRooms(d, TEAMS);
  assert.equal(room.title, '기획부');
  assert.equal(room.linked, true);
  assert.equal(room.isForum, true);
  assert.equal(room.trigger, '카오');
  assert.deepEqual(room.topics.map((t) => t.id), ['149', '863', '12036']);
  assert.equal(room.topics[0].teamName, '행사기획팀');
  assert.equal(room.topics[1].team, null);
});

test('주제 담당 팀을 바꾸고 해제하면 rooms.json 의 다른 내용은 그대로 둔다', () => {
  const d = legacyDir('t2');
  const r = L.assignTopic(d, TEAMS, ROOM, '863', '물품관리');
  assert.equal(r.team, 'rental-manager');
  assert.equal(json(d, 'rooms.json')[ROOM].topics['863'].team, 'rental-manager');
  assert.equal(json(d, 'rooms.json')[ROOM].live.title, '기획부', '확인 결과(live)가 보존되어야 한다');
  L.assignTopic(d, TEAMS, ROOM, '863', '없음');
  assert.equal(json(d, 'rooms.json')[ROOM].topics['863'].team, null);
  assert.throws(() => L.assignTopic(d, TEAMS, ROOM, '863', '없는팀'), /팀을 찾을 수/);
});

test('옵션: 멘션·승인·호출어는 각각 access.json / rooms.json 에 저장된다', () => {
  const d = legacyDir('t3');
  L.setRoomOptions(d, TEAMS, ROOM, { requireMention: true, confirmPosts: true, trigger: '비서' });
  assert.equal(json(d, 'access.json').groups[ROOM].requireMention, true);
  assert.deepEqual(json(d, 'access.json').groups[ROOM].allowFrom, ['111222333']);
  assert.equal(json(d, 'rooms.json')[ROOM].confirmPosts, true);
  assert.equal(json(d, 'rooms.json')[ROOM].trigger, '비서');
  L.setTrigger(d, TEAMS, ROOM, '149', '없음');
  assert.equal(json(d, 'rooms.json')[ROOM].topics['149'].trigger, '');
  L.setTrigger(d, TEAMS, ROOM, '149', '기본');
  assert.equal('trigger' in json(d, 'rooms.json')[ROOM].topics['149'], false);
});

test('방 연결·해제는 허용된 계정이 있어야 하고 허용 목록을 복사한다', () => {
  const d = legacyDir('t4');
  L.setLinked(d, TEAMS, ROOM, false);
  assert.equal(json(d, 'access.json').groups[ROOM], undefined);
  L.setLinked(d, TEAMS, ROOM, true);
  assert.deepEqual(json(d, 'access.json').groups[ROOM].allowFrom, ['111222333']);
  const none = legacyDir('t4b');
  writeFileSync(join(none, 'access.json'), JSON.stringify({ allowFrom: [], groups: {} }));
  assert.throws(() => L.setLinked(none, TEAMS, ROOM, true), /허용\(페어링\)/);
});

test('정기 보고: 받을 곳·시각·켜기·시험 발송', () => {
  const d = legacyDir('t5');
  let rt = L.getRoutine(d);
  assert.equal(rt.threadId, '863');
  assert.equal(rt.morning.time, '08:00');
  rt = L.setRoutineTime(d, 'morning', '7:30');
  assert.equal(rt.morning.time, '07:30');
  rt = L.setRoutineTime(d, 'evening', null, false);
  assert.equal(rt.evening.enabled, false);
  assert.equal(rt.evening.time, '22:00');
  assert.throws(() => L.setRoutineTime(d, 'morning', '25:00'), /시각/);
  rt = L.setRoutineTarget(d, TEAMS, ROOM, '149');
  assert.equal(rt.threadId, '149');
  assert.equal(rt.topic, '월례회');
  rt = L.setRoutineTarget(d, TEAMS, '개인');
  assert.equal(rt.chatId, '111222333');
  assert.equal(rt.room, '개인 대화');
  L.testRoutine(d, 'morning');
  assert.equal(json(d, 'routines.json').test.id, 'morning');
  assert.throws(() => L.testRoutine(d, 'night'), /아침/);
});

test('주제 만들기와 상태 확인은 텔레그램을 호출하고, 토큰은 오류에 새지 않는다', async () => {
  const d = legacyDir('t6');
  const calls = [];
  const ok = (result) => ({ json: async () => ({ ok: true, result }) });
  const fetcher = async (url, init) => {
    const method = url.split('/').pop();
    calls.push(method);
    if (method === 'createForumTopic') return ok({ message_thread_id: 30700, name: JSON.parse(init.body).name });
    if (method === 'getChat') return ok({ title: '새 이름', type: 'supergroup', is_forum: true });
    if (method === 'getChatMember') return ok({ status: 'administrator', can_manage_topics: true });
    if (method === 'getChatMemberCount') return ok(3);
    throw new Error('unexpected ' + method);
  };
  const t = await L.createTopic(d, TEAMS, ROOM, '물품 대여', '물품관리팀', fetcher);
  assert.equal(t.threadId, '30700');
  assert.equal(json(d, 'rooms.json')[ROOM].topics['30700'].team, 'rental-manager');
  const rooms = await L.refreshRooms(d, TEAMS, fetcher);
  assert.equal(rooms[0].title, '새 이름');
  assert.equal(rooms[0].memberCount, 3);
  const leak = async () => { throw new Error('boom https://api.telegram.org/bot123456:SECRETSECRETSECRET/getChat'); };
  await assert.rejects(() => L.createTopic(d, TEAMS, ROOM, 'x', null, leak), (e) => !e.message.includes('SECRETSECRETSECRET'));
});

test('새 방식 코드가 끼워 넣은 빈 "rooms": {} 가 있어도 예전 형식으로 인식하고 정리한다', () => {
  const d = legacyDir('t7');
  const rooms = json(d, 'rooms.json');
  writeFileSync(join(d, 'rooms.json'), JSON.stringify({ ...rooms, rooms: {} }));
  assert.equal(L.isLegacy(d), true);
  assert.equal(L.listRooms(d, TEAMS).length, 1, '가짜 방 "rooms" 가 목록에 나오면 안 된다');
  assert.equal(L.repairLegacy(d), true);
  assert.equal('rooms' in json(d, 'rooms.json'), false);
  assert.equal(json(d, 'rooms.json')[ROOM].topics['149'].team, 'event-planner', '나머지 내용은 그대로');
  assert.ok(readFileSync(join(d, 'rooms.json.bak-ai-office'), 'utf8').includes('"rooms"'), '원본 백업');
  assert.equal(L.repairLegacy(d), false, '두 번째는 할 일 없음');
});

test('새 형식 파일은 정리 대상이 아니다', () => {
  const fresh = join(root, 'fresh2'); mkdirSync(fresh);
  writeFileSync(join(fresh, 'rooms.json'), JSON.stringify({ rooms: { '-100': { id: '-100', title: 'x' } }, defaultTask: '' }));
  assert.equal(L.isLegacy(fresh), false);
  assert.equal(L.repairLegacy(fresh), false);
});

test('방 ID 가 아닌 groups 키(가짜 방 "rooms" 연결 찌꺼기)는 목록에서 빼고 정리한다', () => {
  const d = legacyDir('t8');
  const a = json(d, 'access.json');
  a.groups.rooms = { requireMention: false, allowFrom: ['111222333'] };
  writeFileSync(join(d, 'access.json'), JSON.stringify(a));
  assert.equal(L.listRooms(d, TEAMS).length, 1);
  assert.equal(L.repairLegacy(d), true);
  assert.deepEqual(Object.keys(json(d, 'access.json').groups), [ROOM]);
  assert.ok(readFileSync(join(d, 'access.json.bak-ai-office'), 'utf8').includes('"rooms"'));
});
