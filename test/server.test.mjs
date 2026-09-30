import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sandbox } from './helpers.mjs';

sandbox();
const { startServer } = await import('../src/server.mjs');
const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900) });
after(() => server.close());
const base = `http://127.0.0.1:${port}`;

const raw = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end(method === 'GET' ? undefined : '{}');
});

test('화면과 API 가 응답한다', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  const ov = await (await fetch(`${base}/api/overview`)).json();
  assert.ok(Array.isArray(ov.offices));
  assert.ok('claude' in ov && 'diag' in ov);
});

test('대시보드 화면이 아닌 곳에서 온 변경 요청은 거부한다', async () => {
  const noHeader = await raw('/api/offices', { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(noHeader.status, 403);
  const evil = await raw('/api/offices', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ai-office': '1', origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('다른 호스트 이름(DNS 리바인딩)은 거부한다', async () => {
  const r = await raw('/api/overview', { headers: { host: 'evil.example' } });
  assert.equal(r.status, 421);
});

test('화면 폴더 밖의 파일은 읽을 수 없다', async () => {
  const r = await raw('/%2e%2e/package.json');
  assert.ok([403, 404].includes(r.status));
  assert.doesNotMatch(r.body, /"name": "ai-office"/);
});

test('화면에서 사무실을 만들고 부서를 늘리고 줄일 수 있다', async () => {
  const h = { 'content-type': 'application/json', 'x-ai-office': '1' };
  const post = (p, b, method = 'POST') => fetch(`${base}${p}`, { method, headers: h, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const c = await post('/api/offices', { name: 'API Office', presets: ['planner'] });
  assert.equal(c.status, 200);
  const id = c.json.id;
  const add = await post(`/api/offices/${id}/teams`, { preset: 'hr' });
  assert.equal(add.status, 200);
  const dup = await post(`/api/offices/${id}/teams`, { preset: 'hr' });
  assert.equal(dup.status, 400);
  const rm = await post(`/api/offices/${id}/teams/hr`, undefined, 'DELETE');
  assert.equal(rm.status, 200);
  const d = await (await fetch(`${base}/api/offices/${id}`)).json();
  assert.deepEqual(d.teams.map((t) => t.key), ['planner']);
});
