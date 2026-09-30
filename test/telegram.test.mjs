import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const tg = await import('../src/telegram.mjs');
const state = join(root, 'tg');
mkdirSync(state, { recursive: true });

test('페어링 코드로 허용하면 allowFrom 에 추가되고 approved 파일이 생긴다', () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({
    dmPolicy: 'pairing', allowFrom: [], groups: {},
    pending: { abc123: { senderId: '111', chatId: '222', createdAt: Date.now(), expiresAt: Date.now() + 60000 } },
  }));
  assert.equal(tg.accessInfo(state).pending.length, 1);
  assert.equal(tg.pair(state, 'ABC123').senderId, '111');
  const a = JSON.parse(readFileSync(join(state, 'access.json'), 'utf8'));
  assert.deepEqual(a.allowFrom, ['111']);
  assert.deepEqual(a.pending, {});
  assert.equal(readFileSync(join(state, 'approved', '111'), 'utf8'), '222');
  assert.throws(() => tg.pair(state, 'abc123'), /만료/);
});

test('만료된 코드와 잘못된 형식은 거부한다', () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ pending: { old111: { senderId: '9', chatId: '9', createdAt: 1, expiresAt: 2 } } }));
  assert.throws(() => tg.pair(state, 'old111'), /만료/);
  assert.throws(() => tg.pair(state, '../x'), /코드/);
});

test('허용 해제와 정책 변경', () => {
  writeFileSync(join(state, 'access.json'), JSON.stringify({ allowFrom: ['1', '2'], dmPolicy: 'pairing' }));
  tg.removeSender(state, '1');
  tg.setPolicy(state, 'allowlist');
  const a = tg.accessInfo(state);
  assert.deepEqual(a.allowFrom, ['2']);
  assert.equal(a.dmPolicy, 'allowlist');
  assert.throws(() => tg.setPolicy(state, 'everyone'), /허용 방식/);
});

test('토큰은 형식이 틀리면 저장하지 않고, 상태에는 가려서만 보인다', async () => {
  await assert.rejects(() => tg.saveToken(state, 'not-a-token'), /형식/);
  assert.equal(tg.tokenStatus(state).set, false);
  writeFileSync(join(state, '.env'), 'TELEGRAM_BOT_TOKEN=123456789:AAH_abcdefghijklmnopqrstuvwxyz0123456\n');
  const s = tg.tokenStatus(state);
  assert.equal(s.set, true);
  assert.ok(!s.masked.includes('abcdefghijklmnop'), '토큰 본문이 노출되면 안 된다');
  tg.clearToken(state);
  assert.equal(tg.tokenStatus(state).set, false);
});
