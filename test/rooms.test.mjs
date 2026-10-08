// 그룹방·주제별 업무(telegram.mjs): 목록, 업무 지정, 연결·해제, 정리, 텔레그램 상태 확인(가짜 응답)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tg from '../src/telegram.mjs';

function setup({ allowFrom = ['111'], groups = {}, rooms = {}, defaultTask } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-rooms-'));
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom, groups, pending: {}, ackReaction: '👀' }));
  writeFileSync(join(dir, 'rooms.json'), JSON.stringify({ defaultTask, rooms, extra: 'keep' }));
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n');
  return dir;
}
const room = (id, extra = {}) => ({ id, title: `방${id}`, type: 'supergroup', firstSeen: Math.abs(Number(id)), lastSeen: 1, topics: {}, ...extra });
const readRooms = (d) => JSON.parse(readFileSync(join(d, 'rooms.json'), 'utf8'));
const readAccess = (d) => JSON.parse(readFileSync(join(d, 'access.json'), 'utf8'));

test('roomsInfo: 연결 여부·주제·수동 등록 방을 합쳐서 보여 준다', () => {
  const d = setup({
    groups: { '-1001': { requireMention: true, allowFrom: ['111'] }, '-9999': { requireMention: false, allowFrom: [] } },
    rooms: { '-1001': room('-1001', { isForum: true, botStatus: 'administrator', task: 'A', topics: { 55: { name: '상담', task: 'B', lastSeen: 1 } }, invitedBy: { id: '111', name: '세은' } }), '-1002': room('-1002', { botStatus: 'member' }) },
    defaultTask: '기본',
  });
  const r = tg.roomsInfo(d);
  assert.equal(r.defaultTask, '기본');
  assert.equal(r.rooms.length, 3);
  const a = r.rooms.find((x) => x.id === '-1001');
  assert.deepEqual([a.connected, a.requireMention, a.allowFromCount, a.task, a.isForum], [true, true, 1, 'A', true]);
  assert.deepEqual(a.topics, [{ id: '55', name: '상담', closed: false, task: 'B' }]);
  assert.equal(r.rooms.find((x) => x.id === '-1002').connected, false);
  const manual = r.rooms.find((x) => x.id === '-9999');
  assert.deepEqual([manual.connected, manual.requireMention], [true, false]);
  rmSync(d, { recursive: true });
});

test('roomsInfo: 파일이 없어도 빈 목록', () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-rooms-'));
  assert.deepEqual(tg.roomsInfo(d), { defaultTask: '', rooms: [] });
  rmSync(d, { recursive: true });
});

test('setRoomTask: 방·주제 업무 저장, 해제, 길이 제한, 모르는 대상 거부, 다른 필드 보존', () => {
  const d = setup({ rooms: { '-1001': room('-1001', { topics: { 55: { name: '상담', lastSeen: 1 } } }) } });
  tg.setRoomTask(d, '-1001', null, '  학원   문의 \n 답변  ');
  assert.equal(readRooms(d).rooms['-1001'].task, '학원 문의 답변');
  tg.setRoomTask(d, '-1001', '55', '예약만');
  assert.equal(readRooms(d).rooms['-1001'].topics['55'].task, '예약만');
  assert.equal(readRooms(d).extra, 'keep');
  assert.equal(tg.setRoomTask(d, '-1001', '', 'x'.repeat(2000)).task.length, 800);
  tg.setRoomTask(d, '-1001', '55', '');
  assert.equal('task' in readRooms(d).rooms['-1001'].topics['55'], false);
  assert.throws(() => tg.setRoomTask(d, '-5555', null, 'a'), /모르는 방/);
  assert.throws(() => tg.setRoomTask(d, '-1001', '99', 'a'), /모르는 주제/);
  assert.throws(() => tg.setRoomTask(d, '../x', null, 'a'), /올바르지/);
  assert.throws(() => tg.setRoomTask(d, '-1001', 'abc', 'a'), /올바르지/);
  rmSync(d, { recursive: true });
});

test('setDefaultTask', () => {
  const d = setup();
  tg.setDefaultTask(d, ' 안내 도우미 ');
  assert.equal(readRooms(d).defaultTask, '안내 도우미');
  tg.setDefaultTask(d, '');
  assert.equal('defaultTask' in readRooms(d), false);
  rmSync(d, { recursive: true });
});

test('connectRoom: 허용된 계정을 방 발언자로(멘션 없이 응답), 기본 업무 적용, 다른 설정 보존', () => {
  const d = setup({ allowFrom: ['111', '222'], rooms: { '-1002': room('-1002') }, defaultTask: '기본' });
  tg.connectRoom(d, '-1002');
  const a = readAccess(d);
  assert.deepEqual(a.groups['-1002'], { requireMention: false, allowFrom: ['111', '222'] });
  assert.equal(a.ackReaction, '👀');
  assert.equal(readRooms(d).rooms['-1002'].task, '기본');
  tg.connectRoom(d, '-1002');   // 두 번 눌러도 안전
  assert.deepEqual(readAccess(d).groups['-1002'].allowFrom, ['111', '222']);
  assert.throws(() => tg.connectRoom(d, '-7777'), /모르는 방/);
  rmSync(d, { recursive: true });
});

test('connectRoom: 허용된 계정이 없으면 거부', () => {
  const d = setup({ allowFrom: [], rooms: { '-1002': room('-1002') } });
  assert.throws(() => tg.connectRoom(d, '-1002'), /페어링/);
  rmSync(d, { recursive: true });
});

test('disconnectRoom / forgetRoom', () => {
  const d = setup({ groups: { '-1001': { requireMention: true, allowFrom: ['111'] } }, rooms: { '-1001': room('-1001', { botStatus: 'left' }), '-1002': room('-1002', { botStatus: 'member' }), '-1003': room('-1003', { botStatus: 'kicked' }) } });
  assert.throws(() => tg.forgetRoom(d, '-1001'), /연결된 방/);
  assert.throws(() => tg.forgetRoom(d, '-1002'), /아직 이 방에 있거나/);
  tg.forgetRoom(d, '-1003');
  assert.equal('-1003' in readRooms(d).rooms, false);
  tg.disconnectRoom(d, '-1001');
  assert.equal('-1001' in readAccess(d).groups, false);
  tg.forgetRoom(d, '-1001');
  assert.equal('-1001' in readRooms(d).rooms, false);
  rmSync(d, { recursive: true });
});

test('refreshRooms: 텔레그램 응답으로 이름·상태 갱신, 나감/강퇴/전환 처리 (토큰은 응답에 없음)', async () => {
  const d = setup({
    groups: { '-1004': { requireMention: true, allowFrom: ['111'] } },
    rooms: { '-1001': room('-1001'), '-1002': room('-1002', { botStatus: 'member' }), '-1003': room('-1003'), '-1004': room('-1004', { task: '옛업무' }) },
  });
  const calls = [];
  const fake = async (token, method, p) => {
    calls.push([method, p && p.chat_id]);
    if (method === 'getMe') return { ok: true, result: { id: 999 } };
    if (method === 'getChat') {
      if (p.chat_id === '-1001') return { ok: true, result: { id: -1001, type: 'supergroup', title: '새 이름', is_forum: true } };
      if (p.chat_id === '-1002') return { ok: false, description: 'Bad Request: chat not found' };
      if (p.chat_id === '-1003') return { ok: true, result: { id: -1003, type: 'supergroup', title: '강퇴방' } };
      if (p.chat_id === '-1004') return { ok: false, description: 'migrated', parameters: { migrate_to_chat_id: -100777 } };
    }
    if (method === 'getChatMember') return { ok: true, result: { status: p.chat_id === '-1003' ? 'kicked' : 'administrator' } };
    return { ok: false, description: 'x' };
  };
  const res = await tg.refreshRooms(d, fake);
  assert.equal(res.checked, 4);
  assert.equal(JSON.stringify(res).includes('AAAA'), false);
  const rr = readRooms(d).rooms;
  assert.deepEqual([rr['-1001'].title, rr['-1001'].isForum, rr['-1001'].botStatus], ['새 이름', true, 'administrator']);
  assert.equal(rr['-1002'].botStatus, 'left');
  assert.match(rr['-1002'].checkError, /chat not found/);
  assert.equal(rr['-1003'].botStatus, 'kicked');
  assert.equal('-1004' in rr, false);
  assert.equal(rr['-100777'].task, '옛업무');
  const a = readAccess(d);
  assert.equal('-1004' in a.groups, false);
  assert.deepEqual(a.groups['-100777'].allowFrom, ['111']);
  rmSync(d, { recursive: true });
});

test('refreshRooms: 토큰이 없으면 거부', async () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-rooms-'));
  await assert.rejects(() => tg.refreshRooms(d, async () => ({ ok: true })), /토큰/);
  rmSync(d, { recursive: true });
});

test('setRoomMention: 연결된 방의 응답 방식을 바꾸고, 발언자 제한·다른 설정은 그대로 둔다', () => {
  const d = setup({ allowFrom: ['111', '222'], rooms: { '-1002': room('-1002') } });
  assert.throws(() => tg.setRoomMention(d, '-1002', true), /연결된 방이 아닙니다/);
  tg.connectRoom(d, '-1002');
  assert.equal(tg.setRoomMention(d, '-1002', true).requireMention, true);
  assert.deepEqual(readAccess(d).groups['-1002'], { requireMention: true, allowFrom: ['111', '222'] });
  assert.equal(tg.roomsInfo(d).rooms.find((r) => r.id === '-1002').requireMention, true);
  tg.setRoomMention(d, '-1002', false);
  assert.equal(readAccess(d).groups['-1002'].requireMention, false);
  assert.equal(readAccess(d).ackReaction, '👀');
  assert.throws(() => tg.setRoomMention(d, 'abc', false), /방 ID/);
  rmSync(d, { recursive: true });
});
