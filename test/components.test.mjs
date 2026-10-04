import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

const root = sandbox();
// 이 PC 에 실제로 설치된 도구가 감지 시험에 섞이지 않도록 홈 위치를 격리한다.
process.env.USERPROFILE = process.env.HOME = join(root, 'home');
process.env.LOCALAPPDATA = join(root, 'localapp');
process.env.APPDATA = join(root, 'roaming');
const { download, hostAllowed, ALLOWED_HOSTS } = await import('../src/download.mjs');
const { createJobs } = await import('../src/jobs.mjs');
const { createComponents } = await import('../src/components.mjs');
const { createOllama, validModel } = await import('../src/ollama.mjs');

const TAR = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
const serve = async (t, handler) => {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.closeAllConnections(); s.close(r); }));
  return 'http://127.0.0.1:' + s.address().port;
};
const local = { hosts: ['127.0.0.1'], allowHttp: true };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('시간 초과'); };

test('내려받기 허용 목록: 공식 호스트의 https 만 통과하고 나머지는 거절한다', () => {
  for (const ok of ['https://github.com/a/b', 'https://release-assets.githubusercontent.com/x', 'https://nodejs.org/dist/x.zip', 'https://ollama.com/download/OllamaSetup.exe', 'https://claude.ai/install.ps1']) assert.equal(hostAllowed(ok), true, ok);
  for (const bad of ['http://github.com/a', 'https://evil.example/github.com', 'https://github.com.evil.example/a', 'https://notgithub.com/a', 'file:///c:/x', 'ftp://nodejs.org/x', 'garbage']) assert.equal(hostAllowed(bad), false, bad);
  assert.ok(ALLOWED_HOSTS.includes('nodejs.org'));
});

test('download: 진행률을 알리고 해시를 검증하며, 틀리면 파일을 폐기한다', async (t) => {
  const body = Buffer.alloc(300000, 7);
  const base = await serve(t, (req, res) => { res.writeHead(200, { 'content-length': body.length }); res.end(body); });
  const dest = join(root, 'dl', 'a.bin');
  const seen = [];
  const ok = await download(base + '/a', dest, { ...local, onProgress: (d, tot) => seen.push([d, tot]) });
  assert.equal(ok.bytes, body.length);
  assert.equal(readFileSync(dest).length, body.length);
  assert.equal(seen.at(-1)[0], body.length);
  assert.equal(seen.at(-1)[1], body.length);
  await assert.rejects(download(base + '/a', join(root, 'dl', 'b.bin'), { ...local, sha256: '0'.repeat(64) }), /해시/);
  assert.equal(existsSync(join(root, 'dl', 'b.bin')), false);
  assert.equal(existsSync(join(root, 'dl', 'b.bin.part')), false);
});

test('download: 허용되지 않은 호스트나 리다이렉트는 받지 않는다', async (t) => {
  const base = await serve(t, (req, res) => { res.writeHead(302, { location: 'https://evil.example/x' }); res.end(); });
  await assert.rejects(download(base + '/a', join(root, 'dl', 'c.bin'), { ...local }), /허용되지 않은/);
  await assert.rejects(download('https://evil.example/a', join(root, 'dl', 'd.bin')), /허용되지 않은/);
});

test('download: 끊긴 파일은 .part 에서 이어받는다', async (t) => {
  const body = Buffer.from(Array.from({ length: 200000 }, (_, i) => i % 251));
  let calls = 0;
  const base = await serve(t, (req, res) => {
    calls++;
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) { const from = Number(m[1]); res.writeHead(206, { 'content-length': body.length - from }); return res.end(body.subarray(from)); }
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  const dest = join(root, 'dl', 'resume.bin');
  mkdirSync(join(root, 'dl'), { recursive: true });
  writeFileSync(dest + '.part', body.subarray(0, 50000));
  await download(base + '/r', dest, { ...local });
  assert.deepEqual(readFileSync(dest), body);
  assert.equal(calls, 1);
});

test('작업 기록: 진행·성공·실패를 남기고 같은 작업은 동시에 두 번 돌지 않는다', async () => {
  const jobs = createJobs();
  let release;
  const gate = new Promise((r) => { release = r; });
  const j = jobs.start('k', '테스트', async (ctx) => { ctx.step('하나'); ctx.progress(1, 4); await gate; return { n: 1 }; });
  assert.equal(j.state, 'running');
  assert.throws(() => jobs.start('k', '또', async () => {}), /이미 진행 중/);
  release();
  const done = await until(() => { const v = jobs.get(j.id); return v.state === 'done' ? v : null; });
  assert.deepEqual(done.result, { n: 1 });
  const bad = jobs.start('k', '실패', async () => { throw new Error('망함'); });
  const failed = await until(() => { const v = jobs.get(bad.id); return v.state === 'error' ? v : null; });
  assert.match(failed.error, /망함/);
  assert.ok(failed.log.some((l) => l.includes('망함')));
});

function fakeZip(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), text); }
  const zip = join(dir, '..', 'fake.zip');
  const r = spawnSync(TAR, ['-a', '-c', '-f', zip, '-C', dir, '.']);
  assert.equal(r.status, 0, String(r.stderr));
  return zip;
}

test('Bun 설치: 공식 주소에서 받아 도구 폴더에 풀고, 설치 여부를 감지한다', { skip: process.platform !== 'win32' }, async (t) => {
  // 가짜 bun.exe: --version 에 응답하는 .cmd 를 .exe 이름으로는 못 만들므로, 감지 시험은 실행 함수를 바꿔 낀다.
  const zip = fakeZip(join(root, 'zipsrc-bun', 'bun-windows-x64'), { 'bun.exe': 'MZ-fake' });
  const zipBytes = readFileSync(zip);
  const base = await serve(t, (req, res) => { res.writeHead(200, { 'content-length': zipBytes.length }); res.end(zipBytes); });
  const toolsDir = join(root, 'tools');
  const runImpl = async (cmd, args) => {
    if (/tar(\.exe)?$/.test(cmd)) { const r = spawnSync(cmd, args); return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) }; }
    if (/bun\.exe$/.test(cmd)) return { code: 0, stdout: '1.2.3\n', stderr: '' };
    if (/where/.test(cmd)) return { code: 1, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected ' + cmd };
  };
  const jobs = createJobs();
  const c = createComponents({ jobs, toolsDir, urls: { bun: base + '/bun.zip' }, downloadOpts: local, runImpl });
  const before = await c.detect('bun', { fresh: true });
  assert.equal(before.installed, false);
  const job = c.install('bun');
  const done = await until(() => { const v = jobs.get(job.id); return v.state !== 'running' ? v : null; }, 20000);
  assert.equal(done.state, 'done', done.error + '\n' + done.log.join('\n'));
  assert.ok(existsSync(join(toolsDir, 'bun', 'bun.exe')));
  assert.equal((await c.detect('bun', { fresh: true })).version, '1.2.3');
  // 이미 설치돼 있으면 다시 받지 않는다
  const again = c.install('bun');
  const d2 = await until(() => { const v = jobs.get(again.id); return v.state !== 'running' ? v : null; });
  assert.ok(d2.log.some((l) => l.includes('이미 설치')));
});

test('Codex 설치: zip 안의 실행 파일을 codex.exe 로 둔다', { skip: process.platform !== 'win32' }, async (t) => {
  const zip = fakeZip(join(root, 'zipsrc-codex'), { 'codex-x86_64-pc-windows-msvc.exe': 'MZ-fake' });
  const zipBytes = readFileSync(zip);
  const base = await serve(t, (req, res) => { res.writeHead(200, { 'content-length': zipBytes.length }); res.end(zipBytes); });
  const toolsDir = join(root, 'tools2');
  const runImpl = async (cmd, args) => {
    if (/tar(\.exe)?$/.test(cmd)) { const r = spawnSync(cmd, args); return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) }; }
    if (/codex\.exe$/.test(cmd)) return { code: 0, stdout: 'codex-cli 0.9.9\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const jobs = createJobs();
  const c = createComponents({ jobs, toolsDir, urls: { codex: base + '/c.zip' }, downloadOpts: local, runImpl });
  const job = c.install('codex');
  const done = await until(() => { const v = jobs.get(job.id); return v.state !== 'running' ? v : null; }, 20000);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.version, '0.9.9');
});

test('알 수 없는 구성 요소는 404', async () => {
  const c = createComponents({ jobs: createJobs() });
  assert.throws(() => c.install('rm-rf'), (e) => e.status === 404);
  await assert.rejects(c.detect('nope'), (e) => e.status === 404);
});

test('Ollama: 모델 이름 검증, 목록, 내려받기 진행률', async (t) => {
  assert.equal(validModel('llama3.2:3b'), true);
  assert.equal(validModel('hf.co/user/model:Q4'), true);
  for (const bad of ['', 'a b', 'x;rm', '../x', '-bad']) assert.equal(validModel(bad), false, bad);
  const base = await serve(t, (req, res) => {
    if (req.url === '/api/version') return res.end('{"version":"0.0.1"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'a:1b', size: 5 }] }));
    if (req.url === '/api/pull') {
      res.write('{"status":"pulling manifest"}\n');
      res.write('{"status":"pulling abc","total":100,"completed":40}\n');
      res.write('{"status":"pulling abc","total":100,"completed":100}\n');
      return res.end('{"status":"success"}\n');
    }
    res.statusCode = 404; res.end();
  });
  const o = createOllama({ baseUrl: base });
  assert.deepEqual((await o.models()).models.map((m) => m.name), ['a:1b']);
  const jobs = createJobs();
  const j = jobs.start('pull', 'p', (ctx) => o.pull('a:1b', ctx));
  const done = await until(() => { const v = jobs.get(j.id); return v.state !== 'running' ? v : null; });
  assert.equal(done.state, 'done');
  assert.equal(done.progress.done, 100);
  assert.ok(done.log.some((l) => l.includes('pulling manifest')));
  await assert.rejects(o.pull('bad name', { step() {}, progress() {}, log() {} }), /모델 이름/);
});
