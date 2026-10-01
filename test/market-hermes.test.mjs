// 스킬 마켓: 읽기 전용 외부 봇(Hermes, 라피스 등)에도 스킬을 설치할 수 있지만, 그 봇의 skills 폴더 밖에는 아무것도 쓰지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const hasGit = spawnSync('git', ['--version']).status === 0;
const gitcfg = join(root, 'gitconfig');
writeFileSync(gitcfg, '[user]\n\tname = Hermes Tester\n\temail = h@example.com\n');
process.env.GIT_CONFIG_GLOBAL = gitcfg;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { startServer } = await import('../src/server.mjs');
const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900), updateCheck: false });
after(() => server.close());
const base = `http://127.0.0.1:${port}`;
const H = { 'content-type': 'application/json', 'x-ai-office': '1' };
const call = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: method === 'GET' ? {} : H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const t = (name, fn) => test(name, { skip: !hasGit && 'git 이 없어서 건너뜀' }, fn);

// 폴더 안 모든 파일 경로(상대) 목록
const walk = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1).replace(/\\/g, '/')]));

t('라피스(Hermes)에 마켓 스킬을 설치·업데이트·제거해도 그 봇의 skills 폴더 밖은 건드리지 않는다', async () => {
  const bare = join(root, 'market.git'); spawnSync('git', ['init', '--bare', '-q', bare]);
  const office = (await call('POST', '/api/offices', { name: 'Source Office', presets: [] })).json;
  const sdir = join(office.folder, '.claude', 'skills', 'share-me');
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, 'SKILL.md'), '---\nname: share-me\ndescription: 라피스도 배울 스킬\n---\n\n# 내용 v1\n');
  assert.equal((await call('POST', '/api/market/connect', { repo: bare, alias: 'PC-1' })).status, 200);
  assert.equal((await call('POST', '/api/market/publish', { office: office.id, skillId: 'share-me', version: '1.0.0' })).status, 200);

  // 라피스 프로필(읽기 전용으로 등록)
  const hdir = join(root, 'lapis');
  mkdirSync(join(hdir, 'skills', 'existing'), { recursive: true });
  writeFileSync(join(hdir, 'config.yaml'), 'x: 1\n');
  writeFileSync(join(hdir, 'skills', 'existing', 'SKILL.md'), '---\nname: existing\ndescription: 원래 있던 스킬\n---\n');
  const hermes = (await call('POST', '/api/offices/import', { folder: hdir, name: '라피스' })).json;
  assert.equal(hermes.kind, 'hermes');
  const before = new Set(walk(hdir));

  // 설치 현황·스킬 목록에 라피스가 대상으로 보인다
  const inst = (await call('GET', '/api/market/installed')).json;
  const row = inst.find((x) => x.office === hermes.id);
  assert.ok(row && row.external === true);

  // 설치
  const r = await call('POST', '/api/market/install', { id: 'share-me', office: hermes.id });
  assert.equal(r.status, 200); assert.equal(r.json.external, true); assert.equal(r.json.needsRestart, false);
  assert.ok(existsSync(join(hdir, 'skills', 'share-me', 'SKILL.md')));
  const added = walk(hdir).filter((f) => !before.has(f));
  assert.ok(added.length && added.every((f) => f.startsWith('skills/share-me/')), `skills/share-me/ 밖에 쓰면 안 된다: ${added.join(', ')}`);
  assert.equal(existsSync(join(hdir, '업무데이터')), false, '변경 이력 파일 같은 것을 라피스 폴더에 만들지 않는다');
  assert.equal(existsSync(join(hdir, '보관함')), false);
  const list = (await call('GET', '/api/market/skills')).json.find((e) => e.id === 'share-me');
  assert.ok(list.installs.some((i) => i.office === hermes.id));

  // 라피스가 마켓에서 받은 스킬이 설치된 스킬 목록에 from-market 으로 보인다
  const row2 = (await call('GET', '/api/market/installed')).json.find((x) => x.office === hermes.id);
  assert.equal(row2.skills.find((s) => s.id === 'share-me').status, 'from-market');
  assert.equal(row2.skills.find((s) => s.id === 'existing').status, 'private', '원래 있던 스킬은 그대로');

  // 새 버전 → 업데이트(직접 고친 내용이 없으면 확인 없이). 이전 내용은 라피스 폴더가 아니라 이 프로그램 데이터 폴더로 백업된다.
  writeFileSync(join(sdir, 'SKILL.md'), '---\nname: share-me\ndescription: 라피스도 배울 스킬\n---\n\n# 내용 v2\n');
  assert.equal((await call('POST', '/api/market/publish', { office: office.id, skillId: 'share-me', version: '1.0.1' })).status, 200);
  const up = await call('POST', '/api/market/install', { id: 'share-me', office: hermes.id });
  assert.equal(up.status, 200); assert.equal(up.json.updated, true);
  assert.match(readFileSync(join(hdir, 'skills', 'share-me', 'SKILL.md'), 'utf8'), /v2/);
  assert.equal(existsSync(join(hdir, '보관함')), false);

  // 제거: 지우지 않고 이 프로그램 데이터 폴더로 옮긴다
  const rm = await call('POST', '/api/market/uninstall', { id: 'share-me', office: hermes.id });
  assert.equal(rm.status, 200);
  assert.equal(existsSync(join(hdir, 'skills', 'share-me')), false);
  assert.ok(existsSync(join(hdir, 'skills', 'existing', 'SKILL.md')), '원래 있던 스킬은 남아 있다');
  assert.equal(existsSync(join(hdir, '보관함')), false);
  assert.ok(existsSync(rm.json.movedTo));
  assert.ok(!rm.json.movedTo.startsWith(hdir));
});

t('라피스는 설치만 예외다: 게시·부서·실행·설정은 여전히 거부하고, 이름이 틀리면 설치하지 않는다', async () => {
  const hermes = (await call('GET', '/api/overview')).json.offices.find((o) => o.kind === 'hermes');
  assert.ok(hermes);
  assert.equal((await call('POST', '/api/market/publish', { office: hermes.id, skillId: 'existing', version: '1.0.0' })).status, 404, '라피스의 스킬은 게시 대상이 아니다');
  assert.equal((await call('POST', `/api/offices/${hermes.id}/teams`, { preset: 'hr' })).status, 403);
  assert.equal((await call('PATCH', `/api/offices/${hermes.id}`, { autoStart: true })).status, 403);
  assert.equal((await call('POST', `/api/offices/${hermes.id}/close`, { confirmName: hermes.name })).status, 403);
  assert.equal((await call('POST', '/api/market/install', { id: 'share-me', office: 'nope' })).status, 404);
  assert.equal((await call('POST', '/api/market/install', { id: '../hack', office: hermes.id })).status, 400);
});
