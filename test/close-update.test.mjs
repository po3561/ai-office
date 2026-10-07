import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const O = await import('../src/offices.mjs');
const U = await import('../src/updater.mjs');
const P = await import('../src/paths.mjs');
const { startServer } = await import('../src/server.mjs');

// ── 버전 비교·릴리스 해석 ──
test('버전 비교', () => {
  assert.equal(U.compareVersions('v0.3.1', '0.3.0'), 1);
  assert.equal(U.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(U.compareVersions('v0.2.0', '0.3.0'), -1);
  assert.equal(U.compareVersions('0.3.0', 'v0.3.0'), 0);
  assert.equal(U.compareVersions('abc', '0.3.0'), 0, '알 수 없는 버전은 새 버전으로 보지 않는다');
});

const rel = (over = {}, asset = {}) => ({
  tag_name: 'v0.4.0', draft: false, prerelease: false, body: '변경', html_url: 'https://github.com/po3561/ai-office/releases/tag/v0.4.0',
  assets: [{ name: 'ai-office-app.zip', size: 1000, browser_download_url: 'https://github.com/po3561/ai-office/releases/download/v0.4.0/ai-office-app.zip', digest: `sha256:${'a'.repeat(64)}`, ...asset }], ...over,
});

test('릴리스: 이 저장소의 zip 만 받아들이고, 초안·사전 공개·남의 주소는 거른다', () => {
  assert.equal(U.parseRelease(rel()).version, '0.4.0');
  assert.equal(U.parseRelease(rel()).sha256, 'a'.repeat(64));
  assert.equal(U.parseRelease(rel({ draft: true })), null);
  assert.equal(U.parseRelease(rel({ prerelease: true })), null);
  assert.equal(U.parseRelease(rel({}, { browser_download_url: 'https://evil.example/ai-office-app.zip' })), null);
  assert.equal(U.parseRelease(rel({}, { browser_download_url: 'https://github.com/other/repo/releases/download/v0.4.0/ai-office-app.zip' })), null);
  assert.equal(U.parseRelease(rel({}, { size: 999_999_999 })), null);
  assert.equal(U.parseRelease(rel({ assets: [] })), null);
});

// ── 업데이트 적용(가짜 내려받기·압축 풀기) ──
function fakeInstall(version) {
  const data = join(root, `data-${Math.random().toString(36).slice(2)}`);
  const app = join(data, 'app');
  for (const [f, c] of [['package.json', `{"name":"ai-office","version":"${version}"}`], ['bin/ai-office.mjs', '// old'], ['src/server.mjs', '// old'], ['src/gone.mjs', '// 새 버전에는 없는 파일'], ['web/index.html', 'old'], ['web/app.js', '// old']]) {
    mkdirSync(join(app, f, '..'), { recursive: true }); writeFileSync(join(app, f), c);
  }
  writeFileSync(join(data, 'install.json'), JSON.stringify({ version }));
  return { data, app };
}
const fakeTools = ({ digest, version = '0.4.0', files, name = 'ai-office' } = {}) => {
  const calls = { restart: 0 };
  return {
    calls,
    fetchJson: async () => rel({}, { digest: digest ?? `sha256:${createHash('sha256').update('zip-bytes').digest('hex')}` }),
    download: async (_u, dest) => writeFileSync(dest, 'zip-bytes'),
    extract: async (_z, dir) => {
      const all = files || { 'package.json': `{"name":"${name}","version":"${version}"}`, 'bin/ai-office.mjs': '// new', 'src/server.mjs': '// new', 'web/index.html': 'new', 'web/app.js': '// new' };
      for (const [f, c] of Object.entries(all)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
    },
    restart: async () => { calls.restart++; },
  };
};

test('update snapshots external departments, registry, bot settings and verifies integrity before success', async () => {
  const { data, app } = fakeInstall('0.3.0');
  const office = join(root, 'external-update-office');
  mkdirSync(join(office, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(office, '.claude', 'agents', 'custom.md'), '---\nname: custom\n---\nPersonal department');
  writeFileSync(join(data, 'offices.json'), JSON.stringify({ offices: [{ id: 'stable-id', folder: office }, { id: 'offline', folder: join(root, 'unplugged') }] }));
  writeFileSync(join(data, 'config.json'), '{"honorific":"Owner"}');
  const tools = fakeTools();
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools });
  await up.check();
  const r = await up.apply();
  assert.equal(r.integrity.verified, true);
  const manifest = JSON.parse(readFileSync(join(r.dataSnapshot, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.offices.map(o => o.id), ['stable-id', 'offline']);
  assert.deepEqual(manifest.offices[0].teamKeys, ['custom']);
  assert.equal(manifest.offices[1].available, false);
  assert.ok(manifest.files.some(f => f.source === join(office, '.claude', 'agents', 'custom.md')));
  assert.ok(manifest.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256)));
});

test('업데이트: 새 파일로 바꾸고, 옛 파일은 지우고, 백업을 남기고, 서버를 다시 시작한다', async () => {
  const { data, app } = fakeInstall('0.3.0');
  const tools = fakeTools();
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools });
  const v = await up.check();
  assert.equal(v.available, true);
  assert.equal(v.latest.version, '0.4.0');
  const r = await up.apply();
  assert.equal(r.to, '0.4.0');
  assert.equal(readFileSync(join(app, 'src', 'server.mjs'), 'utf8'), '// new');
  assert.equal(existsSync(join(app, 'src', 'gone.mjs')), false, '새 버전에 없는 파일은 지운다');
  assert.equal(JSON.parse(readFileSync(join(data, 'install.json'), 'utf8')).version, '0.4.0');
  assert.equal(readFileSync(join(r.backup, 'src', 'server.mjs'), 'utf8'), '// old', '이전 버전이 백업된다');
  await new Promise((ok) => setTimeout(ok, 700));
  assert.equal(tools.calls.restart, 1);
});

test('업데이트: install.json 이 없어도 표준 설치 위치면 적용하고, 적용하면 install.json 을 만든다', async () => {
  const { data, app } = fakeInstall('0.3.0');
  rmSync(join(data, 'install.json'));
  const tools = fakeTools();
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools });
  assert.equal((await up.check()).canApply, true);
  await up.apply();
  assert.equal(JSON.parse(readFileSync(join(data, 'install.json'), 'utf8')).version, '0.4.0');
  await new Promise((ok) => setTimeout(ok, 700));
  assert.equal(tools.calls.restart, 1);
});

test('업데이트: 검증값이 다르면 아무것도 바꾸지 않는다', async () => {
  const { data, app } = fakeInstall('0.3.0');
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools: fakeTools({ digest: `sha256:${'b'.repeat(64)}` }) });
  await up.check();
  await assert.rejects(() => up.apply(), /검증값/);
  assert.equal(readFileSync(join(app, 'src', 'server.mjs'), 'utf8'), '// old');
});

test('업데이트: 릴리스에 검증값이 없으면 적용하지 않는다', async () => {
  const { data, app } = fakeInstall('0.3.0');
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools: fakeTools({ digest: '' }) });
  await up.check();
  await assert.rejects(() => up.apply(), /검증값/);
  assert.equal(readFileSync(join(app, 'src', 'server.mjs'), 'utf8'), '// old');
});

test('업데이트: 다른 프로그램이거나 버전이 올라가지 않은 파일은 거부한다', async () => {
  for (const opts of [{ name: 'other' }, { version: '0.3.0' }, { files: { 'package.json': '{"name":"ai-office","version":"0.4.0"}' } }]) {
    const { data, app } = fakeInstall('0.3.0');
    const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools: fakeTools(opts) });
    await up.check();
    await assert.rejects(() => up.apply());
    assert.equal(readFileSync(join(app, 'bin', 'ai-office.mjs'), 'utf8'), '// old');
  }
});

test('업데이트: 새 코드에 문법 오류가 있으면 교체하지 않는다', async () => {
  const { data, app } = fakeInstall('0.3.0');
  const files = { 'package.json': '{"name":"ai-office","version":"0.4.0"}', 'bin/ai-office.mjs': 'const = ;', 'src/server.mjs': '// ok', 'web/index.html': 'x', 'web/app.js': '//' };
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools: fakeTools({ files }) });
  await up.check();
  await assert.rejects(() => up.apply(), /점검/);
  assert.equal(readFileSync(join(app, 'bin', 'ai-office.mjs'), 'utf8'), '// old');
});

test('업데이트: 소스에서 직접 실행 중이면 감지만 하고 교체하지 않는다', async () => {
  const up = U.createUpdater({ current: '0.3.0', appHome: join(root, 'somewhere'), dataHome: join(root, 'elsewhere'), tools: fakeTools() });
  const v = await up.check();
  assert.equal(v.available, true);
  assert.equal(v.canApply, false);
  await assert.rejects(() => up.apply(), (e) => e.status === 409);
});

test('업데이트: 이미 최신이거나 확인에 실패해도 조용히 알려 준다', async () => {
  const { data, app } = fakeInstall('0.4.0');
  const up = U.createUpdater({ current: '0.4.0', appHome: app, dataHome: data, tools: fakeTools() });
  assert.equal((await up.check()).available, false);
  const bad = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, tools: { fetchJson: async () => { throw new Error('offline'); } } });
  const v = await bad.check();
  assert.equal(v.available, false);
  assert.match(v.error, /offline/);
});

// ── 사무실 폐쇄 ──
test('사무실 폐쇄: 이름 확인이 맞아야 하고, 폴더는 지우지 않고 옮긴다', () => {
  const o = O.createOffice({ name: 'To Close', presets: ['planner'] });
  assert.equal(O.isClosable(o), true);
  assert.throws(() => O.closeOffice(o.id, { confirmName: '다른 이름' }), (e) => e.status === 400);
  assert.ok(existsSync(o.folder), '이름이 틀리면 아무 일도 없다');
  const r = O.closeOffice(o.id, { confirmName: 'To Close' });
  assert.equal(existsSync(o.folder), false);
  assert.ok(existsSync(join(r.archived, 'CLAUDE.md')), '보관 위치에 그대로 있다');
  assert.ok(r.archived.startsWith(P.CLOSED_DIR));
  assert.equal(O.listOffices().some((x) => x.id === o.id), false);
});

test('사무실 폐쇄: 직접 불러온 폴더와 읽기 전용 봇은 폐쇄할 수 없다(등록 해제만)', () => {
  const dir = join(root, 'my-own-folder');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# mine');
  const o = O.importOffice({ folder: dir, name: 'Mine' });
  assert.equal(O.isClosable(o), false);
  assert.throws(() => O.closeOffice(o.id, { confirmName: 'Mine' }), (e) => e.status === 400);
  assert.ok(existsSync(join(dir, 'CLAUDE.md')), '내 폴더는 그대로');
  const h = join(root, 'hermes-x');
  mkdirSync(join(h, 'skills'), { recursive: true }); writeFileSync(join(h, 'config.yaml'), 'x: 1\n');
  const ho = O.importOffice({ folder: h, name: 'Hermes X' });
  assert.throws(() => O.closeOffice(ho.id, { confirmName: 'Hermes X' }), (e) => e.status === 403);
});

// ── 화면 API ──
test('API: 폐쇄·업데이트가 대시보드 화면에서만 동작한다', async () => {
  const tools = fakeTools();
  const { data, app } = fakeInstall('0.3.0');
  const up = U.createUpdater({ current: '0.3.0', appHome: app, dataHome: data, updateDir: join(data, 'update'), tools });
  const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900), updater: up, updateCheck: false });
  after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const h = { 'content-type': 'application/json', 'x-ai-office': '1' };
  const post = (p, b, headers = h) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));

  assert.equal((await post('/api/update/apply', {}, { 'content-type': 'application/json' })).status, 403, '화면이 아닌 곳의 요청은 거부');
  const chk = await post('/api/update/check');
  assert.equal(chk.json.available, true);
  const ov = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(ov.update.latest.version, '0.4.0');

  const c = await post('/api/offices', { name: 'Api Close', presets: [] });
  const id = c.json.id;
  assert.equal((await (await fetch(`${base}/api/offices/${id}`)).json()).closable, true);
  assert.equal((await post(`/api/offices/${id}/close`, { confirmName: 'x' })).status, 400);
  const ok = await post(`/api/offices/${id}/close`, { confirmName: 'Api Close' });
  assert.equal(ok.status, 200);
  assert.equal((await fetch(`${base}/api/offices/${id}`)).status, 404);
  assert.ok(readdirSync(P.CLOSED_DIR).some((n) => n.startsWith(id)));
});
