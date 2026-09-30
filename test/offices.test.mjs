import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const O = await import('../src/offices.mjs');
const R = await import('../src/runner.mjs');

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
