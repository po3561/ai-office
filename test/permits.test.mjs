import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const O = await import('../src/offices.mjs');
const P = await import('../src/permits.mjs');
const { CLI } = await import('../src/paths.mjs');

const office = O.createOffice({ name: 'Permit Office', honorific: '과장님', presets: [] });
const local = join(office.folder, '.claude', 'settings.local.json');
const main = join(office.folder, '.claude', 'settings.json');
const readLocal = () => JSON.parse(readFileSync(local, 'utf8'));

test('좁은 규칙은 통과하고, 통째로 여는 규칙·위험 규칙·봇 자신의 설정을 건드리는 규칙은 거부한다', () => {
  for (const ok of ['Bash(*기획부DB작업*)', 'Bash(robocopy *기획부DB*)', 'PowerShell(Copy-Item *기획부DB*)', 'Edit(./결과물/기획부DB/**)', 'Read(D:/기획부DB/**)']) {
    assert.equal(P.validateRule(ok), ok);
  }
  const bad = [
    '', 'Bash', 'Bash()', 'Bash(*)', 'PowerShell(*)', 'Edit(**)', 'Write(**/*.md)', 'Edit(./../x/**)',
    'WebFetch(domain:evil.com)', 'mcp__plugin_telegram_telegram__reply',
    'Bash(rm -rf *)', 'Bash(del *기획부DB*)', 'PowerShell(Remove-Item *기획부DB*)', 'Bash(curl *기획부DB*)',
    'Bash(bash *)', 'PowerShell(powershell -File *기획부DB*)', 'Bash(git push *)', 'Bash(robocopy * /MIR *기획부DB*)', 'Bash(robocopy *기획부DB* /MOVE)',
    'Edit(./.claude/settings.json)', 'Edit(./.ai-office/**)', 'Read(./.telegram/.env)', 'Bash(*x-ai-office*)', 'Bash(curl http://127.0.0.1:1/api/offices)',
    'Bash(node "C:/app/bin/ai-office.mjs" permit *)', 'Bash(echo 1\n)',
  ];
  for (const b of bad) assert.throws(() => P.validateRule(b), (e) => e.status === 400 || e.status === 403, JSON.stringify(b));
});

test('허용 규칙은 사용자 승인 증거(--approved)와 이유가 있어야 열린다', () => {
  assert.throws(() => P.addPermit(office.folder, { rule: 'Bash(*기획부DB작업*)', reason: '복사 작업' }), /approved/);
  assert.throws(() => P.addPermit(office.folder, { rule: 'Bash(*기획부DB작업*)', approved: '허용' }), /reason/);
  assert.ok(!existsSync(local), '승인 없이는 아무것도 쓰지 않는다');
});

test('승인을 받은 규칙은 settings.local.json 에만 더해지고, 견본이 관리하는 settings.json 과 차단 규칙은 그대로다', () => {
  const before = readFileSync(main, 'utf8');
  const r = P.addPermit(office.folder, { rule: ' Bash(robocopy *기획부DB*) ', reason: '기획부DB 복사 이어하기', approved: '허용' });
  assert.deepEqual(r, { rule: 'Bash(robocopy *기획부DB*)', added: true });
  assert.deepEqual(readLocal().permissions.allow, ['Bash(robocopy *기획부DB*)']);
  assert.equal(readFileSync(main, 'utf8'), before);
  assert.equal(readLocal().permissions.deny, undefined, '차단 규칙은 건드리지 않는다');
  assert.equal(P.addPermit(office.folder, { rule: 'Bash(robocopy *기획부DB*)', reason: '다시', approved: '허용' }).added, false, '같은 규칙은 한 번만');
  const csv = readFileSync(join(office.folder, '업무데이터', '맞춤설정', '변경이력.csv'), 'utf8');
  assert.match(csv, /권한 허용.*robocopy \*기획부DB\*.*기획부DB 복사 이어하기.*허용/);
});

test('이미 있는 settings.local.json 의 다른 설정은 보존하고, 깨진 파일은 덮어쓰지 않는다', () => {
  const cur = readLocal();
  cur.env = { KEEP: '1' };
  writeFileSync(local, JSON.stringify(cur));
  P.addPermit(office.folder, { rule: 'Bash(*기획부DB작업*)', reason: '작업 폴더 접근', approved: '네 허용' });
  assert.equal(readLocal().env.KEEP, '1');
  assert.deepEqual(P.listPermits(office.folder), ['Bash(robocopy *기획부DB*)', 'Bash(*기획부DB작업*)']);
  writeFileSync(local, '{ 깨짐');
  assert.throws(() => P.addPermit(office.folder, { rule: 'Bash(*다른작업*)', reason: '테스트', approved: '허용' }), (e) => e.status === 500);
  assert.equal(readFileSync(local, 'utf8'), '{ 깨짐');
  writeFileSync(local, JSON.stringify(cur));
});

test('규칙은 닫을 수 있고, 열려 있지 않은 규칙은 닫을 수 없다', () => {
  P.addPermit(office.folder, { rule: 'Bash(*기획부DB작업*)', reason: '작업 폴더 접근', approved: '네 허용' });
  P.removePermit(office.folder, 'Bash(*기획부DB작업*)');
  assert.deepEqual(P.listPermits(office.folder), ['Bash(robocopy *기획부DB*)']);
  assert.throws(() => P.removePermit(office.folder, 'Bash(*기획부DB작업*)'), (e) => e.status === 404);
});

test('규칙은 30개까지만 열린다', () => {
  for (let i = P.listPermits(office.folder).length; i < P.MAX_PERMITS; i++) P.addPermit(office.folder, { rule: `Bash(tool${i}x *)`, reason: '개수 테스트', approved: '허용' });
  assert.equal(P.listPermits(office.folder).length, P.MAX_PERMITS);
  assert.throws(() => P.addPermit(office.folder, { rule: 'Bash(onemore *)', reason: '개수 테스트', approved: '허용' }), /30개/);
  writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(robocopy *기획부DB*)'] } }));
});

test('새 사무실 견본: 봇이 permit 명령을 쓸 수 있고, 지침에 "물어본 뒤에만 연다"는 절차가 들어 있다', () => {
  const s = JSON.parse(readFileSync(main, 'utf8'));
  assert.ok(s.permissions.allow.some((a) => /^Bash\(node ".*" permit \*\)$/.test(a)));
  assert.ok(s.permissions.allow.some((a) => /^PowerShell\(node ".*" permit \*\)$/.test(a)));
  assert.ok(s.permissions.deny.includes('Edit(./.claude/settings.json)'), '설정 파일 직접 수정 차단은 그대로');
  assert.ok(s.permissions.deny.includes('Edit(./.claude/settings.local.json)'));
  const md = readFileSync(join(office.folder, 'CLAUDE.md'), 'utf8');
  assert.match(md, /^- \*\*권한 열기\*\*.*허용한다고 답한 뒤에만.*permit add --office permit-office/m);
  assert.match(md, /답이 없으면 .*열지 않은 채 기다린다/);
  assert.doesNotMatch(md, /\{\{[A-Z_]+\}\}/);
});

test('옛 사무실에도 permit 허용 명령과 권한 열기 규칙이 채워지고, 사용자가 고친 내용은 그대로 둔다', () => {
  const md = join(office.folder, 'CLAUDE.md');
  const orig = readFileSync(md, 'utf8');
  const s = JSON.parse(readFileSync(main, 'utf8'));
  s.permissions.allow = s.permissions.allow.filter((a) => !/ permit /.test(a));
  writeFileSync(main, JSON.stringify(s, null, 2));
  writeFileSync(md, orig.replace(/^- \*\*권한 열기\*\*.*\r?\n/m, '') + '\n## 내 규칙\n- 사용자가 추가한 규칙\n');
  assert.ok(O.repairOffices().includes('permit-office'));
  const after = JSON.parse(readFileSync(main, 'utf8'));
  assert.ok(after.permissions.allow.some((a) => / permit \*\)$/.test(a)));
  const t = readFileSync(md, 'utf8');
  assert.match(t, /## 권한 열기 규칙 \(AI-Office 업데이트로 추가\)/);
  assert.match(t, /permit add --office permit-office/);
  assert.match(t, /과장님께 "무엇을 하려다 막혔는지/);
  assert.match(t, /사용자가 추가한 규칙/);
  O.repairOffices();
  assert.equal(readFileSync(md, 'utf8').match(/^- \*\*권한 열기\*\*/gm).length, 1, '두 번 돌려도 한 번만');
  assert.ok(!O.repairOffices().includes('permit-office'));
  // 옛 문구의 줄은 새 문구로 바뀐다
  writeFileSync(md, t.replace(/^- \*\*권한 열기\*\*.*$/m, '- **권한 열기** 옛 문구'));
  assert.ok(O.repairOffices().includes('permit-office'));
  assert.doesNotMatch(readFileSync(md, 'utf8'), /옛 문구/);
});

test('명령줄: 승인 없이는 거부되고, 승인 증거와 함께면 규칙이 열렸다 닫힌다', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, 'permit', ...args, '--office', 'permit-office'], { encoding: 'utf8', env: process.env });
  let r = run('add', '--rule', 'Bash(robocopy *기획부DB*)', '--reason', '복사');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /approved/);
  r = run('add', '--rule', 'Bash(curl *기획부DB*)', '--reason', '전송', '--approved', '허용');
  assert.notEqual(r.status, 0);
  r = run('add', '--rule', 'Bash(xcopy *기획부DB*)', '--reason', '복사', '--approved', '허용');
  assert.equal(r.status, 0, r.stderr);
  assert.match(run('list').stdout, /xcopy \*기획부DB\*/);
  assert.equal(run('remove', '--rule', 'Bash(xcopy *기획부DB*)').status, 0);
  assert.doesNotMatch(run('list').stdout, /xcopy/);
});
