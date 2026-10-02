import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

sandbox();
const O = await import('../src/offices.mjs');
const D = await import('../src/drives.mjs');
const P = await import('../src/permits.mjs');
const { CLI } = await import('../src/paths.mjs');
const { startServer } = await import('../src/server.mjs');
const { server, port } = await startServer({ port: 39000 + Math.floor(Math.random() * 900) });
after(() => server.close());

const office = O.createOffice({ name: 'Drive Office', honorific: '과장님', presets: [] });
const local = join(office.folder, '.claude', 'settings.local.json');
const mdFile = join(office.folder, 'CLAUDE.md');
const readLocal = () => JSON.parse(readFileSync(local, 'utf8'));
const md = () => readFileSync(mdFile, 'utf8');

test('경로는 드라이브 경로만 받고, 시스템 폴더·토큰 폴더·네트워크 경로는 거부한다', () => {
  assert.equal(D.normalizeGrantPath('d:\\'), 'D:/');
  assert.equal(D.normalizeGrantPath('D:'), 'D:/');
  assert.equal(D.normalizeGrantPath('"D:\\공유자료\\"'), 'D:/공유자료');
  for (const bad of ['', 'D', '/d/x', '\\\\server\\share', 'D:\\a\\..\\b', 'D:\\a*', 'D:\\.telegram', 'D:\\office\\.ai-office\\x', 'D:\\.claude']) {
    assert.throws(() => D.normalizeGrantPath(bad), (e) => e.status === 400 || e.status === 403, bad);
  }
  const sys = (process.env.SystemDrive || 'C:').toUpperCase();
  for (const bad of [`${sys}\\`, `${sys}\\Windows`, `${sys}\\Windows\\System32`, `${sys}\\Program Files\\x`, `${sys}\\Users`, `${sys}\\Users\\me`]) {
    assert.throws(() => D.normalizeGrantPath(bad), (e) => e.status === 403, bad);
  }
  assert.equal(D.normalizeGrantPath(`${sys}\\Users\\me\\Desktop`), `${sys}/Users/me/Desktop`);
});

test('읽기·쓰기만 맡기면 파일 접근과 만들기·옮기기 명령만 열리고, 삭제 명령과 삭제 안내는 없다', () => {
  assert.deepEqual(D.listGrants(office.folder), []);
  D.setGrant(office.folder, { path: 'D:\\', level: 'readwrite' });
  const s = readLocal().permissions;
  assert.deepEqual(s.additionalDirectories, ['D:/']);
  assert.ok(s.allow.includes('Read(//d/**)') && s.allow.includes('Edit(//d/**)'));
  assert.ok(s.allow.includes('PowerShell(Copy-Item *D:\\*)') && s.allow.includes('Bash(mv *D:/*)'));
  assert.ok(!s.allow.some((a) => /rm|Remove-Item|del |rmdir/.test(a)), '삭제 명령은 열리지 않는다');
  assert.ok(s.deny.includes('Read(//**/.telegram/.env*)') && s.deny.includes('Edit(//**/.telegram/**)') && !s.deny.some((d) => d === 'Read(//**/.telegram/**)') && s.deny.includes('Bash(*.ai-office*)'), '토큰·상태 폴더는 항상 막는다');
  assert.match(md(), /## 드라이브 서버 권한/);
  assert.match(md(), /\| `D:\/` \| 읽기·쓰기·만들기·수정·옮기기 \|/);
  assert.match(md(), /삭제는 이 위치에서도 맡기지 않았다/);
  assert.ok(md().indexOf('DRIVE-ACCESS-START') < md().indexOf('## 폴더 규칙'), '폴더 규칙 앞에 들어간다');
  assert.match(readFileSync(join(office.folder, '업무데이터', '맞춤설정', '변경이력.csv'), 'utf8'), /드라이브 허용.*D:\/.*읽기·쓰기/);
});

test('삭제까지 맡기면 그 위치 글자가 들어간 삭제 명령이 열리고, 지침에 삭제 규칙(대량은 먼저 묻기)이 들어간다', () => {
  D.setGrant(office.folder, { path: 'D:\\', level: 'full' });
  const s = readLocal().permissions;
  for (const r of ['Bash(rm *D:/*)', 'Bash(rm */d/*)', 'PowerShell(Remove-Item *D:\\*)', 'PowerShell(Remove-Item *D:/*)']) assert.ok(s.allow.includes(r), r);
  assert.equal(D.listGrants(office.folder).length, 1, '같은 위치는 덮어쓴다');
  assert.equal(s.allow.filter((a) => a === 'Read(//d/**)').length, 1);
  assert.match(md(), /\| `D:\/` \| 읽기·쓰기·만들기·수정·옮기기·삭제 \|/);
  assert.match(md(), /20개 초과를 지울 때는 먼저 대상 목록과 개수를 텔레그램으로 알리고 \*\*허용한다는 답을 받은 뒤\*\*/);
  assert.equal(md().match(/DRIVE-ACCESS-START/g).length, 1);
});

test('폴더 단위로 맡기면 그 폴더만 열리고, 사용자가 직접 넣은 설정은 보존된다', () => {
  const cur = readLocal();
  cur.env = { KEEP: '1' };
  cur.permissions.allow.push('Bash(my own rule *)');
  writeFileSync(local, JSON.stringify(cur));
  D.setGrant(office.folder, { path: 'E:\\백업\\사진', level: 'readwrite' });
  const s = readLocal();
  assert.equal(s.env.KEEP, '1');
  assert.ok(s.permissions.allow.includes('Bash(my own rule *)'));
  assert.deepEqual(s.permissions.additionalDirectories, ['D:/', 'E:/백업/사진']);
  assert.ok(s.permissions.allow.includes('Edit(//e/백업/사진/**)'));
  assert.ok(!s.permissions.allow.includes('Edit(//e/**)'));
});

test('permit 명령의 개수·목록에는 드라이브 규칙이 섞이지 않고, 봇이 드라이브 규칙을 닫을 수도 없다', () => {
  assert.deepEqual(P.listPermits(office.folder), ['Bash(my own rule *)']);
  assert.throws(() => P.removePermit(office.folder, 'Read(//d/**)'), (e) => e.status === 404);
  assert.ok(readLocal().permissions.allow.includes('Read(//d/**)'));
  P.addPermit(office.folder, { rule: 'Bash(robocopy *기획부DB*)', reason: '복사', approved: '허용' });
  assert.ok(readLocal().permissions.allow.includes('Read(//d/**)'), 'permit 이 쓴 뒤에도 드라이브 규칙이 남는다');
  P.removePermit(office.folder, 'Bash(robocopy *기획부DB*)');
});

test('해제하면 이 기능이 더한 규칙과 지침 절만 걷어내고, 모두 해제하면 깨끗해진다', () => {
  D.removeGrant(office.folder, 'E:\\백업\\사진');
  let s = readLocal().permissions;
  assert.deepEqual(s.additionalDirectories, ['D:/']);
  assert.ok(!s.allow.some((a) => a.includes('백업')));
  assert.ok(s.allow.includes('Bash(my own rule *)'));
  assert.throws(() => D.removeGrant(office.folder, 'E:\\백업\\사진'), (e) => e.status === 404);
  D.removeGrant(office.folder, 'D:\\');
  s = readLocal().permissions;
  assert.equal(s.additionalDirectories, undefined);
  assert.deepEqual(s.allow, ['Bash(my own rule *)']);
  assert.equal(s.deny, undefined);
  assert.doesNotMatch(md(), /DRIVE-ACCESS|## 드라이브 서버 권한/);
  assert.match(md(), /## 폴더 규칙/);
});

test('위치는 6곳까지, 깨진 settings.local.json 은 덮어쓰지 않는다', () => {
  for (const l of 'DEFGHI') D.setGrant(office.folder, { path: `${l}:\\`, level: 'readwrite' });
  assert.throws(() => D.setGrant(office.folder, { path: 'J:\\', level: 'readwrite' }), /6곳/);
  for (const l of 'DEFGHI') D.removeGrant(office.folder, `${l}:\\`);
  writeFileSync(local, '{ 깨짐');
  assert.throws(() => D.setGrant(office.folder, { path: 'D:\\', level: 'readwrite' }), (e) => e.status === 500);
  assert.equal(readFileSync(local, 'utf8'), '{ 깨짐');
  assert.deepEqual(D.listGrants(office.folder), [], '실패하면 부여 기록도 남기지 않는다');
  writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(my own rule *)'] } }));
  assert.throws(() => D.setGrant(office.folder, { path: 'D:\\', level: 'bogus' }), /허용 범위/);
});

test('규칙이나 지침 절이 지워지면 서버 점검(repairOffices)이 다시 채우고, 이미 맞으면 건드리지 않는다', () => {
  D.setGrant(office.folder, { path: 'D:\\', level: 'full' });
  assert.ok(!O.repairOffices().includes('drive-office'), '이미 맞으면 그대로');
  writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(my own rule *)'] } }));
  writeFileSync(mdFile, md().replace(/<!-- DRIVE-ACCESS-START[\s\S]*DRIVE-ACCESS-END -->\r?\n?/, ''));
  assert.doesNotMatch(md(), /## 드라이브 서버 권한/);
  assert.ok(O.repairOffices().includes('drive-office'));
  assert.ok(readLocal().permissions.allow.includes('Read(//d/**)'));
  assert.ok(readLocal().permissions.allow.includes('Bash(my own rule *)'));
  assert.match(md(), /\| `D:\/` \| 읽기·쓰기·만들기·수정·옮기기·삭제 \|/);
  assert.ok(!O.repairOffices().includes('drive-office'));
  // CRLF 지침에서도 안정적이다
  writeFileSync(mdFile, md().replace(/\r?\n/g, '\r\n'));
  assert.ok(!O.repairOffices().includes('drive-office'));
  D.removeGrant(office.folder, 'D:\\');
  assert.doesNotMatch(md(), /## 드라이브 서버 권한/);
});

test('견본은 봇이 drive 명령을 쓰지 못하게 막고, 지침의 삭제 금지 규칙에 예외 안내가 있다', () => {
  const s = JSON.parse(readFileSync(join(office.folder, '.claude', 'settings.json'), 'utf8'));
  assert.ok(s.permissions.deny.some((d) => /^Bash\(node ".*" drive \*\)$/.test(d)));
  assert.ok(s.permissions.deny.some((d) => /^PowerShell\(node ".*" drive \*\)$/.test(d)));
  assert.ok(!s.permissions.allow.some((a) => / drive /.test(a)));
  assert.match(md(), /예외: 아래 `드라이브 서버 권한` 절이 있으면/);
});

test('명령줄: 삭제까지는 --yes 가 있어야 하고, 봇이 아닌 사용자만 쓴다', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, 'drive', ...args, '--office', 'drive-office'], { encoding: 'utf8', env: process.env });
  let r = run('grant', '--path', 'D:\\', '--level', 'full');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--yes/);
  assert.deepEqual(D.listGrants(office.folder), []);
  r = run('grant', '--path', 'D:\\', '--level', 'full', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(run('list').stdout, /D:\/.*삭제/);
  assert.equal(run('revoke', '--path', 'D:\\').status, 0);
  assert.deepEqual(D.listGrants(office.folder), []);
});

test('화면 API: 삭제 포함은 확인 표시가 있어야 하고, 상세에 부여 목록이 나온다', async () => {
  const h = { 'content-type': 'application/json', 'x-ai-office': '1' };
  const call = (method, p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: method === 'GET' ? {} : h, body: b ? JSON.stringify(b) : undefined }).then(async (x) => ({ status: x.status, json: await x.json() }));
  const base = '/api/offices/drive-office';
  assert.equal((await call('POST', `${base}/drives`, { path: 'D:\\', level: 'full' })).status, 400);
  assert.equal((await call('POST', `${base}/drives`, { path: 'C:\\Windows', level: 'readwrite' })).status, 403);
  const ok = await call('POST', `${base}/drives`, { path: 'D:\\', level: 'full', confirmDelete: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.grant.path, 'D:/');
  assert.deepEqual((await call('GET', base)).json.drives.map((g) => g.path), ['D:/']);
  assert.equal((await call('DELETE', `${base}/drives`, { path: 'D:\\' })).status, 200);
  assert.deepEqual((await call('GET', base)).json.drives, []);
});
