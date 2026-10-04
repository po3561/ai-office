import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';

sandbox();
const { startServer } = await import('../src/server.mjs');
const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900), updateCheck: false });
after(() => server.close());
const base = `http://127.0.0.1:${port}`;
const h = { 'content-type': 'application/json', 'x-ai-office': '1' };
const call = (p, b, method = 'POST') => fetch(`${base}${p}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, json: await r.json() }));

test('컴포넌트 목록: 다섯 가지 도구의 설치 여부와 설명을 돌려준다', async () => {
  const r = await get('/api/components');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.components.map((c) => c.id), ['claude', 'bun', 'codex', 'ollama', 'hermes']);
  for (const c of r.json.components) { assert.equal(typeof c.installed, 'boolean'); assert.ok(c.name && c.desc && c.size); }
});

test('알 수 없는 구성 요소 설치와 없는 작업은 404, 화면 밖 요청은 403', async () => {
  assert.equal((await call('/api/components/rm-rf/install')).status, 404);
  assert.equal((await get('/api/jobs/nope')).status, 404);
  const noHeader = await fetch(`${base}/api/components/bun/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
});

test('연결 현황: API 키 값이 응답에 섞이지 않는다', async () => {
  const r = await get('/api/connections');
  assert.equal(r.status, 200);
  assert.ok('claude' in r.json && 'gpt' in r.json && 'ollama' in r.json);
  assert.equal((await call('/api/connections/keys/openai', { key: 'bad' }, 'PUT')).status, 400);
  assert.equal((await call('/api/connections/keys/evil', { key: 'x' }, 'PUT')).status, 404);
});

test('봇 스튜디오: 만들고, 에이전트를 붙이고, 방·주제를 설정하고, 폐쇄한다', async () => {
  const c = await call('/api/bots', { name: 'API 봇', engine: { type: 'ollama', model: 'm1' }, presets: ['planner'] });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const id = c.json.id;
  const list = await get('/api/bots');
  assert.equal(list.json.bots.length, 1);
  assert.ok(list.json.engineTypes.ollama && list.json.agentPresets.length > 5 && list.json.readiness.openai);
  const a = await call(`/api/bots/${id}/agents`, { name: '번역팀', role: '번역', engine: { type: 'openai', model: 'gpt-x' } });
  assert.equal(a.status, 200);
  assert.equal((await call(`/api/bots/${id}/agents/${a.json.key}`, { instructions: '정확하게' }, 'PATCH')).status, 200);
  assert.equal((await call(`/api/bots/${id}`, { defaultAgent: a.json.key }, 'PATCH')).json.defaultAgent, a.json.key);
  assert.equal((await call(`/api/bots/${id}/telegram/rooms/-1001`, { mode: 'all' })).status, 404);   // 봇이 아직 그 방을 본 적 없다
  assert.equal((await call(`/api/bots/${id}/telegram/token`, { token: 'nope' })).status, 400);
  assert.equal((await call(`/api/bots/${id}/start`)).status, 409);   // 토큰 없이는 켤 수 없다
  const d = await get(`/api/bots/${id}`);
  assert.equal(d.json.agents.length, 2);
  assert.equal(d.json.runtime.running, false);
  assert.equal((await call(`/api/bots/${id}/close`, { confirmName: '틀림' })).status, 400);
  assert.equal((await call(`/api/bots/${id}/close`, { confirmName: 'API 봇' })).status, 200);
  assert.equal((await get('/api/bots')).json.bots.length, 0);
});

test('스킬 마켓의 설치 대상에 LAPIS 봇이 들어간다', async () => {
  const c = await call('/api/bots', { name: '마켓 봇', engine: { type: 'ollama', model: 'm' } });
  const r = await get('/api/market/installed');
  assert.equal(r.status, 200);
  assert.ok(r.json.some((o) => o.office === `bot-${c.json.id}`));
});

test('봇 스킬: 직접 만들고 목록에서 보고, 지우면 보관함으로 옮기고 역할에서도 뗀다', async () => {
  const c = await call('/api/bots', { name: '스킬 봇', engine: { type: 'ollama', model: 'm' }, presets: ['planner'] });
  const id = c.json.id;
  const made = await call(`/api/bots/${id}/skills`, { name: '보고서 문체', description: '개조식', body: '□ ○ - 순서로 쓴다.' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal((await call(`/api/bots/${id}/skills`, { name: '', body: 'x' })).status, 400);
  assert.equal((await call(`/api/bots/${id}/skills`, { name: '빈 내용', body: '' })).status, 400);
  const list = await get(`/api/bots/${id}/skills`);
  assert.deepEqual(list.json.skills.map((s) => s.name), ['보고서 문체']);
  await call(`/api/bots/${id}/agents/planner`, { skills: [made.json.id] }, 'PATCH');
  assert.equal((await call(`/api/bots/${id}/skills/${made.json.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await get(`/api/bots/${id}/skills`)).json.skills.length, 0);
  assert.deepEqual((await get(`/api/bots/${id}`)).json.agents[0].skills, []);
  assert.equal((await call(`/api/bots/${id}/skills/..%2F..`, {}, 'DELETE')).status, 404);
});

test('방 현황: 봇이 초대된 방을 모아 주고, 화면 밖에서도 읽기만 되며 보안 헤더가 붙는다', async () => {
  const c = await call('/api/bots', { name: '방 봇', engine: { type: 'ollama', model: 'm' } });
  const r = await get('/api/rooms');
  assert.equal(r.status, 200);
  const g = r.json.groups.find((x) => x.id === c.json.id);
  assert.ok(g && g.source === 'lapis' && Array.isArray(g.rooms) && g.total === 0);
  assert.equal(typeof r.json.total, 'number');
  const res = await fetch(`${base}/api/ping`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/`)).headers.get('x-frame-options'), 'DENY');
});
