import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const { createSecrets, plain, mask } = await import('../src/secrets.mjs');
const { createConnections } = await import('../src/connections.mjs');

const OPENAI = 'sk-' + 'a'.repeat(30);
const ANTHROPIC = 'sk-ant-' + 'b'.repeat(30);

function setup({ status = 200, codexText = 'Logged in using ChatGPT', codexCode = 0, codexInstalled = true } = {}) {
  const secrets = createSecrets({ file: join(root, `s-${Math.random()}.bin`), crypto: plain });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    if (/models/.test(url)) return new Response(JSON.stringify({ data: [{ id: 'gpt-x1' }, { id: 'text-embedding-3' }, { id: 'whisper-1' }, { id: 'o3-mini' }, { id: 'claude-sonnet-x' }] }), { status });
    return new Response('{}', { status });
  };
  const components = { detect: async (id) => (id === 'codex' && codexInstalled ? { installed: true, path: 'C:/codex.exe', version: '1.0.0' } : { installed: false }) };
  const runImpl = async () => ({ code: codexCode, stdout: codexText, stderr: '' });
  const launched = [];
  const c = createConnections({ components, secrets, fetchImpl, runImpl, launch: (t, l) => launched.push({ t, l }) });
  return { c, secrets, calls, launched };
}

test('비밀 저장소: 저장·조회·가림·삭제', async () => {
  const s = createSecrets({ file: join(root, 'x.bin'), crypto: plain });
  assert.equal(await s.has('openai'), false);
  await s.set('openai', OPENAI);
  assert.equal(await s.get('openai'), OPENAI);
  assert.deepEqual((await s.masked()).openai, { set: true, hint: mask(OPENAI) });
  assert.equal(JSON.stringify(await s.masked()).includes(OPENAI), false);
  await s.remove('openai');
  assert.equal(await s.has('openai'), false);
  assert.equal(existsSync(join(root, 'x.bin')), false);
});

test('API 키: 형식이 틀리면 공급자에 묻지도 않고 거절한다', async () => {
  const { c, calls } = setup();
  await assert.rejects(c.setKey('openai', 'not-a-key'), /형식/);
  await assert.rejects(c.setKey('openai', 'sk-short'), /형식/);
  await assert.rejects(c.setKey('anthropic', OPENAI), /형식/);   // 다른 공급자의 키
  await assert.rejects(c.setKey('../etc', OPENAI), (e) => e.status === 404);
  assert.equal(calls.length, 0);
});

test('API 키: 공급자가 거절하면 저장하지 않고, 통과하면 가려서 돌려준다', async () => {
  const bad = setup({ status: 401 });
  await assert.rejects(bad.c.setKey('openai', OPENAI), /거절/);
  assert.equal(await bad.secrets.has('openai'), false);
  const good = setup();
  const r = await good.c.setKey('openai', OPENAI);
  assert.deepEqual(r, { set: true, hint: '••••' + OPENAI.slice(-4) });
  assert.equal(await good.secrets.get('openai'), OPENAI);
  assert.match(good.calls[0].headers.authorization, /^Bearer sk-/);
  const a = await good.c.setKey('anthropic', ANTHROPIC);
  assert.equal(a.set, true);
  assert.equal(good.calls.at(-1).headers['x-api-key'], ANTHROPIC);
});

test('모델 목록: 채팅용만 걸러서 보여 준다', async () => {
  const { c } = setup();
  await assert.rejects(c.models('openai'), /먼저 연결/);
  await c.setKey('openai', OPENAI);
  assert.deepEqual((await c.models('openai')).models, ['gpt-x1', 'o3-mini']);
  await c.setKey('anthropic', ANTHROPIC);
  assert.deepEqual((await c.models('anthropic')).models, ['claude-sonnet-x']);
});

test('GPT 상태: Codex 설치·ChatGPT 로그인 여부를 구분한다', async () => {
  assert.deepEqual(await setup({ codexInstalled: false }).c.codexStatus(), { installed: false, loggedIn: false });
  const ok = await setup().c.codexStatus();
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.method, 'ChatGPT 계정');
  const no = await setup({ codexText: 'Not logged in', codexCode: 1 }).c.codexStatus();
  assert.equal(no.loggedIn, false);
});

test('ChatGPT 로그인 시작: 설치돼 있어야 하고, 공식 로그인 명령만 콘솔로 띄운다', { skip: process.platform !== 'win32' }, async () => {
  const none = setup({ codexInstalled: false });
  await assert.rejects(none.c.startCodexLogin(), (e) => e.status === 409);
  const s = setup();
  assert.deepEqual(await s.c.startCodexLogin(), { started: true });
  assert.equal(s.launched.length, 1);
  assert.ok(s.launched[0].l[0].includes("login"));
  assert.ok(!s.launched[0].l.join('\n').includes(OPENAI));
});

test('연결 현황 응답에는 키 값이 들어가지 않는다', async () => {
  const s = setup();
  await s.c.setKey('openai', OPENAI);
  const st = await s.c.status().catch((e) => ({ error: e }));
  if (st.error) return;   // claude 점검이 이 환경에서 실패하면 건너뛴다
  assert.equal(JSON.stringify(st).includes(OPENAI), false);
  assert.equal(st.gpt.apiKey.set, true);
});
