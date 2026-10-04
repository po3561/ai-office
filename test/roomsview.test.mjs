import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lapisRooms, officeRooms, legacyOfficeRooms, tally } from '../src/roomsview.mjs';

test('LAPIS 봇의 방: 맡은 역할(봇 기본 역할 포함)·주제·응답 방식·허용 인원을 풀어 준다', () => {
  const bot = {
    agents: [{ key: 'a', name: '영업팀', emoji: '💼' }, { key: 'n', name: '기록', emoji: '📝' }], defaultAgent: 'n',
    telegram: { allowFrom: ['1', '2'], rooms: {
      '-100': { title: '운영방', type: 'supergroup', mode: 'all', connected: true, agent: 'a', instructions: '친절하게', seenAt: '2026-10-04T00:00:00Z', topics: { 7: { name: '문의', agent: 'a', instructions: 'x' }, 8: { name: '잡담' } } },
      '-200': { mode: 'mention', connected: false, topics: {} },
    } },
  };
  const [a, b] = lapisRooms(bot);
  assert.equal(a.title, '운영방'); assert.equal(a.replyMode, 'all'); assert.equal(a.assignee.name, '영업팀'); assert.equal(a.allowedCount, 2);
  assert.deepEqual(a.topics.map((t) => [t.id, t.name, t.assignee?.name ?? null]), [['7', '문의', '영업팀'], ['8', '잡담', null]]);
  assert.equal(b.title, '(이름 모름) -200'); assert.equal(b.connected, false);
  assert.equal(b.assignee.name, '기록'); assert.equal(b.assignee.inherited, true);
  assert.deepEqual(tally([a, b]), { total: 2, connected: 1, topics: 2 });
});

test('Claude 사무실의 방(새 방식·예전 방식)을 같은 모양으로 맞춘다', () => {
  const [n] = officeRooms({ rooms: [{ id: '-1', title: '방', type: 'supergroup', isForum: true, botStatus: 'administrator', connected: true, requireMention: false, allowFromCount: 3, invitedBy: { id: '9', name: '김대리' }, invitedAt: 1700000000, task: '일', checkError: '', topics: [{ id: '5', name: '주제', closed: true, task: 't' }] }] });
  assert.equal(n.replyMode, 'all'); assert.equal(n.invitedBy.name, '김대리'); assert.equal(n.topics[0].closed, true); assert.equal(n.allowedCount, 3);
  const [l] = legacyOfficeRooms([{ id: '-2', title: '예전', type: 'group', isForum: true, botStatus: 'member', linked: true, requireMention: true, memberCount: 12, topics: [{ id: '3', name: '물품', team: 'rental', teamName: '대여팀' }] }]);
  assert.equal(l.replyMode, 'mention'); assert.equal(l.memberCount, 12); assert.equal(l.topics[0].assignee.name, '대여팀');
  assert.deepEqual(officeRooms(null), []);
});
