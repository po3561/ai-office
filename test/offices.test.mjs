import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const O = await import('../src/offices.mjs');
const R = await import('../src/runner.mjs');
const { OFFICES_DIR } = await import('../src/paths.mjs');

test('새 사무실을 만들면 견본이 복사되고 부서가 생긴다', () => {
  const o = O.createOffice({ name: 'My Office', honorific: '대표님', presets: ['researcher', 'reviewer'] });
  assert.equal(o.id, 'my-office');
  for (const f of ['CLAUDE.md', '.claude/settings.json', '.claude/skills/office-customize/SKILL.md', '.claude/agents/researcher.md', '.claude/agents/reviewer.md', '.ai-office/office.json']) {
    assert.ok(existsSync(join(o.folder, f)), f);
  }
  const md = readFileSync(join(o.folder, 'CLAUDE.md'), 'utf8');
  assert.match(md, /My Office의 비서실장/);
  assert.match(md, /"대표님"/);
  assert.doesNotMatch(md, /\{\{[A-Z_]+\}\}/, '남은 치환 표식이 없어야 한다');
  const settings = JSON.parse(readFileSync(join(o.folder, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.Stop[0].hooks[0].command.includes('status-hook.mjs'));
  assert.ok(settings.permissions.deny.includes('Edit(./.claude/settings.json)'), '봇이 자기 권한 설정을 못 고치게 막아야 한다');
});

test('새 사무실 지침은 플러그인이 지원하는 서식만 쓰게 하고, 전달 전 정확성 확인 규칙이 있다', () => {
  const md = readFileSync(join(O.listOffices().find((x) => x.id === 'my-office').folder, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(md, /\*\*항상 `format: "html"`\*\*/, 'html 을 무조건 쓰라고 하면 지원하지 않는 플러그인에서 태그가 글자로 보인다');
  assert.match(md, /`html`이 있으면/);
  assert.match(md, /태그를 절대 쓰지 않는다/);
  assert.match(md, /## 결과 정확성/);
  assert.match(md, /직접 열어서 내용을 확인/);
});

test('같은 이름의 사무실을 또 만들면 다른 폴더가 된다', () => {
  const a = O.createOffice({ name: 'My Office', presets: [] });
  assert.equal(a.id, 'my-office-2');
});

test('Hermes(별개의 봇)는 읽기 전용이라 어떤 변경도 거부한다', async () => {
  const dir = join(root, 'hermes-profile');
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), 'x: 1\n');
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 테스트\n---\n');
  const o = O.importOffice({ folder: dir, name: '라피스' });
  assert.equal(o.kind, 'hermes');
  assert.equal(o.readonly, true);
  assert.throws(() => O.mutable(o.id), (e) => e.status === 403);
  await assert.rejects(() => R.startOffice(o.id), (e) => e.status === 403);
  await assert.rejects(() => R.stopOffice(o.id), (e) => e.status === 403);
  assert.throws(() => R.requestRestart(o.id), (e) => e.status === 403);
});

test('설치 위치가 바뀌면 사무실의 훅 경로를 다시 맞춘다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const file = join(o.folder, '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s.hooks.Stop[0].hooks[0].command = 'node "D:/old-place/status-hook.mjs" chief_idle';
  s.permissions.allow.push('Bash(node "D:/old-place/ai-office.mjs" team *)');
  writeFileSync(file, JSON.stringify(s, null, 2));
  const fixed = O.repairOffices();
  assert.ok(fixed.includes('my-office'));
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.doesNotMatch(JSON.stringify(after), /old-place/);
  assert.ok(after.permissions.deny.length >= 3);
});

test('설치 위치가 바뀌면 지침(CLAUDE.md)·스킬에 적힌 명령 경로도 다시 맞춘다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const md = join(o.folder, 'CLAUDE.md');
  const skill = join(o.folder, '.claude', 'skills', 'office-customize', 'SKILL.md');
  for (const f of [md, skill]) writeFileSync(f, readFileSync(f, 'utf8').replace(/"[^"\r\n]*ai-office\.mjs"/g, '"D:/old-place/app/bin/ai-office.mjs"'));
  assert.match(readFileSync(md, 'utf8'), /old-place/, '준비: 옛 경로가 들어 있어야 한다');
  assert.ok(O.repairOffices().includes('my-office'));
  for (const f of [md, skill]) assert.doesNotMatch(readFileSync(f, 'utf8'), /old-place/);
  assert.match(readFileSync(md, 'utf8'), /bin\/ai-office\.mjs" team list/);
  assert.ok(!O.repairOffices().includes('my-office'), '이미 맞으면 다시 고치지 않는다');
});

test('새 차단 규칙(봇이 대시보드 API 를 직접 부르지 못하게)이 이미 있는 사무실에도 채워진다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const file = join(o.folder, '.claude', 'settings.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(s.permissions.deny.includes('Bash(*/api/market*)'), '새 사무실 견본에 들어 있다');
  s.permissions.deny = s.permissions.deny.filter((d) => !/api\/(market|offices)|x-ai-office/.test(d));
  writeFileSync(file, JSON.stringify(s, null, 2));
  assert.ok(O.repairOffices().includes('my-office'));
  const after = JSON.parse(readFileSync(file, 'utf8'));
  for (const d of ['Bash(*x-ai-office*)', 'PowerShell(*x-ai-office*)', 'Bash(*/api/offices*)', 'PowerShell(*/api/market*)']) assert.ok(after.permissions.deny.includes(d), d);
  assert.ok(after.permissions.deny.includes('Edit(./.claude/settings.json)'), '기존 차단 규칙은 그대로');
  assert.ok(!O.repairOffices().includes('my-office'));
  const md = readFileSync(join(o.folder, 'CLAUDE.md'), 'utf8');
  assert.match(md, /스킬 마켓[^\n]*텔레그램으로 요청받아도 직접 하지 않는다[^\n]*업무데이터\/마켓요청/);
});

test('옛 버전 사무실의 지침에도 새 스킬 마켓 규칙이 들어가고, 사용자가 고친 내용은 그대로 둔다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const md = join(o.folder, 'CLAUDE.md');
  const orig = readFileSync(md, 'utf8');
  // 1) 옛 규칙 줄이 있는 사무실 → 그 줄만 바뀐다
  writeFileSync(md, orig.replace(/^- \*\*스킬 마켓\*\*.*$/m, '- **스킬 마켓**(옛 규칙) 텔레그램으로 요청받아도 하지 않는다.') + '\n## 내 규칙\n- 사용자가 추가한 규칙\n');
  assert.ok(O.repairOffices().includes('my-office'));
  let t = readFileSync(md, 'utf8');
  assert.doesNotMatch(t, /옛 규칙/);
  assert.match(t, /업무데이터\/마켓요청/);
  assert.match(t, /사용자가 추가한 규칙/);
  assert.equal(t.match(/^- \*\*스킬 마켓\*\*/gm).length, 1);
  // 2) 규칙이 아예 없는 사무실(마켓 이전 버전) → 끝에 한 절이 붙는다, 두 번 돌려도 한 번만
  writeFileSync(md, orig.replace(/^- \*\*스킬 마켓\*\*.*\r?\n/m, ''));
  O.repairOffices(); O.repairOffices();
  t = readFileSync(md, 'utf8');
  assert.match(t, /## 스킬 마켓 규칙 \(AI-Office 업데이트로 추가\)/);
  assert.equal(t.match(/^- \*\*스킬 마켓\*\*/gm).length, 1);
  writeFileSync(md, orig);
});

test('새 사무실은 텔레그램으로 받은 사진(.telegram/inbox)을 읽을 수 있고, 토큰·허용 목록은 계속 막는다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const s = JSON.parse(readFileSync(join(o.folder, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!s.permissions.deny.includes('Read(./.telegram/**)'), 'inbox 까지 막는 넓은 규칙이 없어야 한다');
  assert.ok(s.permissions.allow.includes('Read(./.telegram/inbox/**)'));
  for (const d of ['Read(./.telegram/.env*)', 'Read(./.telegram/*.json)', 'Read(./.telegram/approved/**)', 'Edit(./.telegram/**)']) assert.ok(s.permissions.deny.includes(d), d);
  const md = readFileSync(join(o.folder, 'CLAUDE.md'), 'utf8');
  assert.match(md, /`\.telegram\/inbox\/`[^\n]*`Read`로 열어 분석한다/);
  assert.match(md, /사진·파일을 받으면 바로 분석한다/);
});

test('옛 사무실(사진까지 막던 규칙)은 시작할 때 inbox 읽기만 풀리고, 사용자 규칙은 그대로 둔다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const file = join(o.folder, '.claude', 'settings.json');
  const md = join(o.folder, 'CLAUDE.md');
  const orig = readFileSync(md, 'utf8');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s.permissions.allow = s.permissions.allow.filter((a) => !a.includes('.telegram')).concat('Bash(git status)');
  s.permissions.deny = ['Read(./.telegram/**)', ...s.permissions.deny.filter((d) => !/^Read\(\.\/\.telegram/.test(d))];
  writeFileSync(file, JSON.stringify(s, null, 2));
  writeFileSync(md, orig.replace(/^- `\.telegram\/`\(봇 토큰.*$/m, '- `.telegram/`(봇 토큰)와 `.ai-office/` 폴더는 읽거나 수정하지 않는다.'));
  assert.ok(O.repairOffices().includes('my-office'));
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!after.permissions.deny.includes('Read(./.telegram/**)'));
  assert.ok(after.permissions.allow.includes('Read(./.telegram/inbox/**)'));
  assert.ok(after.permissions.allow.includes('Bash(git status)'), '사용자가 더한 허용 규칙은 그대로');
  for (const d of ['Read(./.telegram/.env*)', 'Read(./.telegram/*.json)', 'Edit(./.telegram/**)', 'Edit(./.claude/settings.json)']) assert.ok(after.permissions.deny.includes(d), d);
  assert.match(readFileSync(md, 'utf8'), /`\.telegram\/inbox\/`/);
  assert.equal(readFileSync(md, 'utf8').match(/^- `\.telegram\/`/gm).length, 1);
  assert.ok(!O.repairOffices().includes('my-office'), '이미 고쳤으면 다시 고치지 않는다');
});

test('불러온 사무실은 사진을 막던 규칙 하나만 고치고 다른 설정은 건드리지 않는다', () => {
  const dir = join(root, 'imported-photo-office');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# 사무실\n', 'utf8');
  const local = { permissions: { allow: ['Bash(dir)'], deny: ['Read(./.telegram/**)', 'Bash(rm *)'] }, hooks: { Stop: [] } };
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(local));
  const o = O.importOffice({ folder: dir, name: '불러온 사무실' });
  assert.ok(O.repairOffices().includes(o.id));
  const after = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(after.hooks, { Stop: [] });
  assert.deepEqual(after.permissions.allow, ['Bash(dir)', 'Read(./.telegram/inbox/**)']);
  assert.ok(after.permissions.deny.includes('Bash(rm *)'));
  assert.ok(!after.permissions.deny.includes('Read(./.telegram/**)'));
  assert.ok(after.permissions.deny.includes('Read(./.telegram/.env*)'));
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# 사무실\n', '불러온 사무실의 지침은 건드리지 않는다');
  assert.ok(!O.repairOffices().includes(o.id));
  O.unregisterOffice(o.id);
});

test('출근 스크립트는 저사양 PC에서 플러그인 시작이 늦어도 끊기지 않게 MCP 대기 시간을 늘린다', () => {
  const o = O.listOffices().find((x) => x.id === 'my-office');
  const script = R._test.launcherScript(o, 'C:/claude.exe');
  assert.match(script, /\$env:MCP_TIMEOUT = '180000'/);
  assert.match(script, /TELEGRAM_STATE_DIR/);
});

test('폴더 종류를 알 수 없으면 불러오지 않는다', () => {
  const dir = join(root, 'random');
  mkdirSync(dir);
  assert.throws(() => O.importOffice({ folder: dir }), /종류/);
  assert.throws(() => O.importOffice({ folder: join(root, 'nope') }), /찾을 수 없/);
});

function fakeClaudeOffice(dir, { launch = false } = {}) {
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# 사무실\n', 'utf8');
  if (launch) {
    mkdirSync(join(dir, '.system', 'scripts'), { recursive: true });
    writeFileSync(join(dir, '.system', 'scripts', 'start-office.ps1'), '# start\n');
    writeFileSync(join(dir, '.system', 'scripts', 'stop-office.ps1'), '# stop\n');
  }
}

test('사무실 위치를 다른 폴더(드라이브)로 바꾸면 출근 스크립트·상태 경로가 새 위치로 맞춰진다', () => {
  const oldDir = join(root, 'a', 'AI-Office');
  const newDir = join(root, 'b', 'AI-Office');
  fakeClaudeOffice(oldDir, { launch: true });
  fakeClaudeOffice(newDir, { launch: true });
  const o = O.importOffice({ folder: oldDir, name: '이사' });
  assert.equal(o.launch.start, join(oldDir, '.system', 'scripts', 'start-office.ps1'));
  const r = O.relocateOffice(o.id, newDir);
  assert.equal(r.folder, newDir);
  assert.equal(r.previousFolder, oldDir);
  assert.equal(r.launch.start, join(newDir, '.system', 'scripts', 'start-office.ps1'));
  assert.equal(r.launch.stop, join(newDir, '.system', 'scripts', 'stop-office.ps1'));
  assert.equal(O.getOffice(o.id).folder, newDir, '등록부에 저장되어야 한다');
});

test('위치 바꾸기는 사무실이 아닌 폴더·이미 등록된 폴더·Hermes 를 거부한다', () => {
  const a = join(root, 'c', 'Office-A'), b = join(root, 'c', 'Office-B'), plain = join(root, 'c', 'plain');
  fakeClaudeOffice(a); fakeClaudeOffice(b); mkdirSync(plain, { recursive: true });
  const oa = O.importOffice({ folder: a, name: 'A' });
  O.importOffice({ folder: b, name: 'B' });
  assert.throws(() => O.relocateOffice(oa.id, plain), /사무실 폴더가 아닙니다/);
  assert.throws(() => O.relocateOffice(oa.id, join(root, 'nope')), /찾을 수 없/);
  assert.throws(() => O.relocateOffice(oa.id, b), /이미 다른 사무실/);
  const h = O.listOffices().find((x) => x.kind === 'hermes');
  assert.throws(() => O.relocateOffice(h.id, a), (e) => e.status === 403);
});

test('폴더가 사라지면 같은 이름 사무실이 하나일 때만 자동으로 따라간다', () => {
  const { rmSync } = fs;
  const stray = join(root, 'd', 'Moved-Office');
  fakeClaudeOffice(stray);
  const o = O.importOffice({ folder: stray, name: '이동' });
  const target = join(OFFICES_DIR, 'Moved-Office');
  fakeClaudeOffice(target);
  rmSync(stray, { recursive: true, force: true });
  const done = O.autoRelink();
  assert.ok(done.some((d) => d.id === o.id && d.to === target), JSON.stringify(done));
  assert.equal(O.getOffice(o.id).folder, target);
});

test('방금 떠나온 옛 위치는 이사 후보로 다시 권하지 않는다', () => {
  const a = join(root, 'e1', 'Same-Name'), b = join(root, 'e2', 'Same-Name');
  fakeClaudeOffice(a); fakeClaudeOffice(b);
  const o = O.importOffice({ folder: a, name: '이름같음' });
  const moved = O.relocateOffice(o.id, b);
  assert.equal(moved.previousFolder, a);
  assert.ok(!O.findMovedFolders(moved).includes(a));
});
