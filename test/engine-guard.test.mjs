import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

sandbox();
const G = await import('../src/engine-guard.mjs');

test('디스크 버전을 읽는다(없거나 깨지면 빈 값)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  assert.equal(G.diskVersion(dir), '');
  writeFileSync(join(dir, 'package.json'), '{ 깨짐');
  assert.equal(G.diskVersion(dir), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.equal(G.diskVersion(dir), '1.2.3');
});

test('켜진 엔진 버전이 디스크와 다르면 옛 엔진이다', () => {
  assert.equal(G.isStale({ app: 'ai-office', version: '0.3.5' }, '0.5.3'), true);
  assert.equal(G.isStale({ app: 'ai-office' }, '0.5.3'), true);   // 버전을 못 알리는 아주 옛 엔진
  assert.equal(G.isStale({ app: 'ai-office', version: '0.5.3' }, '0.5.3'), false);
  assert.equal(G.isStale(null, '0.5.3'), false);
  assert.equal(G.isStale({ app: 'ai-office', version: '0.3.5' }, ''), false);   // 디스크 버전을 모르면 건드리지 않는다
});

test('ping: 우리 엔진만 인정하고, 다른 프로그램·무응답은 null', async () => {
  const ok = async () => ({ json: async () => ({ app: 'ai-office', version: '1.0.0' }) });
  assert.deepEqual(await G.pingEngine(5000, ok), { app: 'ai-office', version: '1.0.0' });
  assert.equal(await G.pingEngine(5000, async () => ({ json: async () => ({ app: 'other' }) })), null);
  assert.equal(await G.pingEngine(5000, async () => { throw new Error('refused'); }), null);
});

test('엔진 내리기: 포트가 비워질 때까지 기다리고, 우리 엔진이 아니면 건드리지 않는다', { skip: process.platform !== 'win32' }, async () => {
  const calls = [];
  let alive = 3;   // 세 번째 확인부터 응답 없음
  const ping = async () => (alive-- > 0 ? { app: 'ai-office', version: '0.3.5' } : null);
  const exec = async (...a) => { calls.push(a); return { code: 0 }; };
  assert.equal(await G.stopEngine(5000, { ping, exec, wait: async () => {} }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].join(' '), /Get-NetTCPConnection -LocalPort 5000/);

  calls.length = 0;
  assert.equal(await G.stopEngine(5000, { ping: async () => null, exec, wait: async () => {} }), false);
  assert.equal(calls.length, 0);   // 우리 엔진이 아니면 아무것도 끄지 않는다
});

test('낡음 감시: 디스크가 더 새 버전이면 한 번만 다시 시작을 요청한다', () => {
  let disk = '0.5.0', restarts = 0, busy = false;
  const check = G.createStaleWatcher({ loaded: '0.5.0', readDisk: () => disk, restart: () => { restarts++; }, busy: () => busy });
  assert.equal(check(), false);
  disk = '0.5.3';
  busy = true;   // 업데이트 파일을 바꾸는 중에는 기다린다
  assert.equal(check(), false);
  busy = false;
  assert.equal(check(), true);
  assert.equal(check(), false);
  assert.equal(restarts, 1);
});

test('낡음 감시: 읽다가 실패(빈 값)해도 다시 시작하지 않는다', () => {
  let restarts = 0;
  const check = G.createStaleWatcher({ loaded: '0.5.0', readDisk: () => '', restart: () => { restarts++; } });
  assert.equal(check(), false);
  assert.equal(restarts, 0);
});
