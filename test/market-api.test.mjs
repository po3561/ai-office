// 스킬 마켓 API: 대시보드 서버를 실제로 띄우고 HTTP 로 게시·설치까지 확인한다. (마켓은 로컬 bare 저장소)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const hasGit = spawnSync('git', ['--version']).status === 0;
// 이 테스트 전용 git 설정(사용자 이름·이메일)을 쓰게 해서, git 설정이 없는 PC 에서도 돌아가게 한다.
const gitcfg = join(root, 'gitconfig');
writeFileSync(gitcfg, '[user]\n\tname = API Tester\n\temail = api@example.com\n');
process.env.GIT_CONFIG_GLOBAL = gitcfg;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { startServer } = await import('../src/server.mjs');
const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900) });
after(() => server.close());
const base = `http://127.0.0.1:${port}`;
const H = { 'content-type': 'application/json', 'x-ai-office': '1' };
const call = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: method === 'GET' ? {} : H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const t = (name, fn) => test(name, { skip: !hasGit && 'git 이 없어서 건너뜀' }, fn);

let bare, one, two;
if (hasGit) { bare = join(root, 'market.git'); spawnSync('git', ['init', '--bare', '-q', bare]); }

t('연결 전에는 꺼져 있고, 화면이 아닌 곳의 변경 요청은 거부한다', async () => {
  const st = await call('GET', '/api/market/status');
  assert.equal(st.status, 200); assert.equal(st.json.enabled, false); assert.equal(st.json.git.available, true);
  const r = await fetch(`${base}/api/market/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/api/market/publish`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r2.status, 403);
  assert.equal((await call('GET', '/api/market/skills')).status, 409, '연결 전에는 목록을 볼 수 없다');
});

t('사무실 두 곳: 한 곳에서 게시한 스킬을 다른 곳에 설치한다', async () => {
  one = (await call('POST', '/api/offices', { name: 'Office One', presets: [] })).json;
  two = (await call('POST', '/api/offices', { name: 'Office Two', presets: [] })).json;
  const dir = join(one.folder, '.claude', 'skills', 'hello-skill');
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + '/SKILL.md', '---\nname: hello-skill\ndescription: 인사 스킬\nmetadata:\n  category: 테스트\n---\n\n# 인사\n');

  const bad = await call('POST', '/api/market/connect', { repo: join(root, 'nope.git'), alias: 'PC-1' });
  assert.equal(bad.status, 502);
  const c = await call('POST', '/api/market/connect', { repo: bare, alias: 'PC-1' });
  assert.equal(c.status, 200); assert.equal(c.json.status.enabled, true); assert.equal(c.json.status.alias, 'PC-1');
  assert.equal((await call('GET', '/api/overview')).json.config.market.enabled, true);

  const sh = await call('GET', '/api/market/shareable');
  const mine = sh.json.find((x) => x.office === one.id).skills.find((s) => s.id === 'hello-skill');
  assert.equal(mine.status, 'private');
  const ins = await call('POST', '/api/market/inspect', { office: one.id, skillId: 'hello-skill' });
  assert.equal(ins.json.publishable, true); assert.equal(ins.json.suggestedVersion, '1.0.0');

  assert.equal((await call('POST', '/api/market/publish', { office: one.id, skillId: '../hack', version: '1.0.0' })).status, 404, '화면이 보낸 이름으로 경로를 만들지 않는다');
  assert.equal((await call('POST', '/api/market/publish', { office: one.id, skillId: 'hello-skill', version: 'v1' })).status, 400);
  const pub = await call('POST', '/api/market/publish', { office: one.id, skillId: 'hello-skill', version: '1.0.0', notes: '첫 게시' });
  assert.equal(pub.status, 200); assert.equal(pub.json.publisher, 'API Tester');
  assert.equal((await call('GET', '/api/market/shareable')).json.find((x) => x.office === one.id).skills.find((s) => s.id === 'hello-skill').status, 'published');

  const list = await call('GET', '/api/market/skills');
  assert.equal(list.json.length, 1); assert.equal(list.json[0].id, 'hello-skill');
  const det = await call('GET', '/api/market/skills/hello-skill');
  assert.equal(det.json.verified, true); assert.match(det.json.skillMd, /인사/);

  assert.equal((await call('POST', '/api/market/install', { office: two.id, id: '../x' })).status, 400);
  assert.equal((await call('POST', '/api/market/install', { office: 'nope', id: 'hello-skill' })).status, 404);
  const inst = await call('POST', '/api/market/install', { office: two.id, id: 'hello-skill' });
  assert.equal(inst.status, 200); assert.equal(inst.json.needsRestart, false);
  assert.ok(existsSync(join(two.folder, '.claude', 'skills', 'hello-skill', 'SKILL.md')));

  const d = (await call('GET', `/api/offices/${two.id}`)).json;
  assert.equal(d.skills.find((s) => s.id === 'hello-skill').market.version, '1.0.0', '스킬트리에 마켓 출처가 표시된다');
  const csv = (await call('GET', `/api/offices/${two.id}`)).json.changes;
  assert.ok(csv.some((c) => c.type === '스킬 설치'), '변경 이력에 남는다');

  const un = await call('POST', '/api/market/uninstall', { office: two.id, id: 'hello-skill' });
  assert.equal(un.status, 200);
  assert.ok(!existsSync(join(two.folder, '.claude', 'skills', 'hello-skill')));
  const rv = await call('POST', '/api/market/revoke', { id: 'hello-skill', reason: '시험' });
  assert.equal(rv.status, 200);
  assert.equal((await call('POST', '/api/market/install', { office: two.id, id: 'hello-skill' })).status, 409);
});

t('연결 해제하면 다시 꺼진 상태가 된다', async () => {
  const r = await call('POST', '/api/market/disconnect', { purge: true });
  assert.equal(r.json.enabled, false);
  assert.equal((await call('POST', '/api/market/refresh')).status, 409);
});
