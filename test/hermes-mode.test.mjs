import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const O = await import('../src/offices.mjs');
const R = await import('../src/runner.mjs');
const { startServer } = await import('../src/server.mjs');
const { RUN_DIR } = await import('../src/paths.mjs');

// <root>/hermes/profiles/lapis-test (프로필) + <root>/hermes/hermes-agent/venv/Scripts/python.exe (가짜)
function fakeHermes(name = 'lapis-test', { withPython = true } = {}) {
  const home = join(root, `hermes-${name}`);
  const dir = join(home, 'profiles', name);
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), 'x: 1\n');
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 테스트\n---\n');
  if (withPython) {
    mkdirSync(join(home, 'hermes-agent', 'venv', 'Scripts'), { recursive: true });
    writeFileSync(join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe'), '');
  }
  return { home, dir };
}

test('Hermes 는 처음엔 읽기 전용이고, 모드만 바꿀 수 있다', () => {
  const { dir } = fakeHermes('mode1');
  const o = O.importOffice({ folder: dir, name: '모드1' });
  assert.equal(o.mode, 'readonly');
  assert.equal(O.isReadonly(o), true);
  assert.throws(() => O.updateOffice(o.id, { autoStart: true }), (e) => e.status === 403, '읽기 전용에서는 모드 말고 바꿀 수 없다');
  assert.throws(() => O.updateOffice(o.id, { mode: 'nope' }), (e) => e.status === 400);

  const on = O.updateOffice(o.id, { mode: 'office' });
  assert.equal(on.mode, 'office');
  assert.equal(on.readonly, false);
  assert.equal(O.isReadonly(on), false);
  assert.equal(O.controllable(o.id).id, o.id);
  assert.throws(() => O.mutable(o.id), (e) => e.status === 403 && /Hermes/.test(e.message), '부서·텔레그램·드라이브는 사무실용이어도 막는다');
  assert.equal(O.updateOffice(o.id, { autoStart: true }).autoStart, true);

  const off = O.updateOffice(o.id, { mode: 'readonly' });
  assert.equal(O.isReadonly(off), true);
  assert.equal(off.autoStart, false, '읽기 전용으로 돌아가면 자동 출근도 꺼진다');
  assert.throws(() => O.controllable(o.id), (e) => e.status === 403);
});

test('옛 등록(mode 없음)과 Claude 사무실은 모드를 바꿀 수 없다', () => {
  const dir = join(root, 'claude-x');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# x');
  const c = O.importOffice({ folder: dir, name: '클로드X' });
  assert.throws(() => O.updateOffice(c.id, { mode: 'readonly' }), (e) => e.status === 400);
  assert.equal(O.isReadonly({ kind: 'hermes', readonly: true }), true, 'mode 없는 옛 Hermes 는 읽기 전용');
});

test('사무실용 Hermes: 켜기는 venv 파이썬으로 gateway run 을 띄우고, 읽기 전용이면 거부한다', async () => {
  const { dir } = fakeHermes('start1');
  const o = O.importOffice({ folder: dir, name: '시작1' });
  await assert.rejects(() => R.startOffice(o.id), (e) => e.status === 403);

  const spec = R._test.hermesLaunch({ ...o, mode: 'office' }, { PATH: 'x' });
  assert.deepEqual(spec.args, ['-m', 'hermes_cli.main', '--profile', 'start1', 'gateway', 'run']);
  assert.equal(spec.env.HERMES_HOME, dir);
  assert.equal(spec.env.HERMES_GATEWAY_DETACHED, '1');
  assert.ok(spec.cmd.endsWith('python.exe'));

  O.updateOffice(o.id, { mode: 'office' });
  const calls = [];
  R._test.setSpawn((cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; });
  after(() => R._test.setSpawn(null));
  const r = await R.startOffice(o.id);
  assert.equal(r.via, 'hermes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.detached, true);
  await assert.rejects(() => R.startOffice(o.id), (e) => e.status === 409, '방금 켠 봇을 또 켜지 않는다');
});

test('설치 위치에 Hermes 실행 파일이 없으면 알려 준다', async () => {
  const { dir } = fakeHermes('nopy', { withPython: false });
  const o = O.importOffice({ folder: dir, name: '없음' });
  O.updateOffice(o.id, { mode: 'office' });
  await assert.rejects(() => R.startOffice(o.id), (e) => e.status === 409 && /Hermes/.test(e.message));
});

test('사무실용 Hermes 끄기: 상태 파일의 게이트웨이만 끄고, 직접 끈 표시를 남긴다', async () => {
  const { dir } = fakeHermes('stop1');
  const o = O.importOffice({ folder: dir, name: '끄기1' });
  O.updateOffice(o.id, { mode: 'office', autoStart: true });
  // 켜져 있지 않은 상태(상태 파일 없음): 아무것도 죽이지 않지만 퇴근 표시는 남는다.
  const r = await R.stopOffice(o.id);
  assert.equal(r.stopped, false);
  assert.ok(existsSync(join(RUN_DIR, `${o.id}.stopped`)));
  // 다른 프로그램의 pid(우리 프로세스)를 가리키는 상태 파일: 이 Hermes 의 것이 아니라고 확인되면 건드리지 않는다.
  writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ pid: process.pid, kind: 'hermes-gateway', gateway_state: 'running', hermes_home: dir }));
  R._test.setVerify(async () => false);
  after(() => R._test.setVerify(async () => true));
  assert.equal((await R.stopOffice(o.id)).stopped, false);
  assert.equal(R.runtime(O.getOffice(o.id)).running, true, '우리 프로세스는 그대로 살아 있다');
  // 다른 폴더의 상태 파일은 믿지 않는다.
  writeFileSync(join(dir, 'gateway_state.json'), JSON.stringify({ pid: process.pid, kind: 'hermes-gateway', gateway_state: 'running', hermes_home: join(root, 'elsewhere') }));
  R._test.setVerify(async () => true);
  assert.equal((await R.stopOffice(o.id)).stopped, false);
});

test('항상 켜두기: 사무실용 Hermes 만 감시가 다시 켠다', async () => {
  const { dir } = fakeHermes('watch1');
  const o = O.importOffice({ folder: dir, name: '감시1' });
  const calls = [];
  R._test.setSpawn((cmd, args) => { calls.push(args.join(' ')); return { on() {}, unref() {} }; });
  after(() => R._test.setSpawn(null));
  let acts = await R.watchdogTick();
  assert.equal(acts.some((a) => a.id === o.id), false, '읽기 전용은 건드리지 않는다');
  O.updateOffice(o.id, { mode: 'office', autoStart: true });
  acts = await R.watchdogTick();
  assert.ok(acts.some((a) => a.id === o.id && a.did === 'auto-start'), JSON.stringify(acts));
  assert.ok(calls.some((c) => /--profile watch1 gateway run/.test(c)));
});

test('봇 삭제: 이름을 맞게 입력해야 하고, 불러온 폴더·Hermes 는 파일을 그대로 둔다', () => {
  const { dir } = fakeHermes('del1');
  const o = O.importOffice({ folder: dir, name: '삭제1' });
  assert.throws(() => O.removeOffice(o.id, { confirmName: '틀림' }), (e) => e.status === 400);
  assert.ok(O.listOffices().some((x) => x.id === o.id));
  const r = O.removeOffice(o.id, { confirmName: '삭제1' });
  assert.equal(r.kind, 'unregistered');
  assert.equal(O.listOffices().some((x) => x.id === o.id), false);
  assert.ok(existsSync(join(dir, 'config.yaml')), '파일은 그대로');
});

test('봇 삭제: 이 프로그램이 만든 사무실은 폴더를 보관 위치로 옮긴다', () => {
  const c = O.createOffice({ name: '만든 것', presets: [] });
  const r = O.removeOffice(c.id, { confirmName: '만든 것' });
  assert.equal(r.kind, 'closed');
  assert.ok(existsSync(join(r.archived, 'CLAUDE.md')));
  assert.equal(existsSync(c.folder), false);
});

test('API: 모드 바꾸기·삭제가 화면 요청으로만 동작한다', async () => {
  const { dir } = fakeHermes('api1');
  const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900), updateCheck: false });
  after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const h = { 'content-type': 'application/json', 'x-ai-office': '1' };
  const send = (method, p, b, headers = h) => fetch(`${base}${p}`, { method, headers, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, json: await r.json() }));

  const imp = await send('POST', '/api/offices/import', { folder: dir, name: 'API헤르메스' });
  assert.equal(imp.status, 200);
  const id = imp.json.id;
  const sum = async () => (await (await fetch(`${base}/api/overview`)).json()).offices.find((x) => x.id === id);
  assert.equal((await sum()).mode, 'readonly');
  assert.equal((await send('POST', `/api/offices/${id}/start`)).status, 403, '읽기 전용은 켤 수 없다');
  assert.equal((await send('PATCH', `/api/offices/${id}`, { mode: 'office' }, { 'content-type': 'application/json' })).status, 403, '화면이 아닌 곳의 요청은 거부');
  assert.equal((await send('PATCH', `/api/offices/${id}`, { autoStart: true })).status, 403);
  assert.equal((await send('PATCH', `/api/offices/${id}`, { mode: 'office' })).status, 200);
  const s = await sum();
  assert.equal(s.mode, 'office');
  assert.equal(s.readonly, false);
  assert.equal(s.removeKind, 'unregister');
  assert.equal((await send('POST', `/api/offices/${id}/teams`, { name: 'x' })).status, 403, 'Hermes 에는 부서를 만들 수 없다');
  assert.equal((await send('PATCH', `/api/offices/${id}`, { autoStart: true })).status, 200);

  assert.equal((await send('POST', `/api/offices/${id}/remove`, { confirmName: '틀림' })).status, 400);
  assert.equal((await send('POST', `/api/offices/${id}/remove`, { confirmName: 'API헤르메스' })).status, 200);
  assert.equal(await sum(), undefined);
  assert.ok(existsSync(join(dir, 'config.yaml')));
});
