import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const { syncSkills } = await import('../src/skill-sync.mjs');

// 폴더 3곳: Claude 전역, Codex, 사무실
const dirs = { claude: join(root, 'c', 'skills'), codex: join(root, 'x', 'skills'), office: join(root, 'o', '.claude', 'skills') };
for (const d of Object.values(dirs)) mkdirSync(join(d, '..'), { recursive: true });
const roots = [
  { id: 'claude', label: 'Claude 전역', dir: dirs.claude },
  { id: 'codex', label: 'Codex', dir: dirs.codex },
  { id: 'office:o', label: '사무실', dir: dirs.office },
];
const skill = (dir, name, body = '본문', extra = {}) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: 테스트\n---\n${body}\n`, 'utf8');
  for (const [f, t] of Object.entries(extra)) { mkdirSync(join(dir, name, f, '..'), { recursive: true }); writeFileSync(join(dir, name, f), t); }
};
const names = (d) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();

test('없는 쪽에만 복사하고, 하위 파일도 함께 옮기며, 지우지 않는다', () => {
  skill(dirs.codex, 'tdd', '테스트 먼저', { 'references/a.md': '참고' });
  skill(dirs.claude, 'drive-organize');
  const r = syncSkills({ roots });
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(names(dirs.claude), ['drive-organize', 'tdd']);
  assert.deepEqual(names(dirs.codex), ['drive-organize', 'tdd']);
  assert.deepEqual(names(dirs.office), ['drive-organize', 'tdd']);
  assert.equal(readFileSync(join(dirs.office, 'tdd', 'references', 'a.md'), 'utf8'), '참고');
  assert.equal(syncSkills({ roots }).copied.length, 0, '두 번째 실행은 할 일이 없다');
});

test('사무실에만 있는 업무 전용 스킬은 Claude 전역으로 올리지 않고 Codex 로만 보낸다', () => {
  skill(dirs.office, 'event-sheet');
  syncSkills({ roots });
  assert.ok(existsSync(join(dirs.codex, 'event-sheet')));
  assert.ok(!existsSync(join(dirs.claude, 'event-sheet')));
  syncSkills({ roots, officeToGlobal: true });
  assert.ok(existsSync(join(dirs.claude, 'event-sheet')));
});

test('내용이 다르면 기본은 충돌로 알리기만 하고 아무것도 덮지 않는다', () => {
  skill(dirs.claude, 'writing', '클로드 버전');
  skill(dirs.codex, 'writing', '코덱스 버전');
  const r = syncSkills({ roots });
  assert.deepEqual(r.conflicts.map((c) => c.name), ['writing']);
  assert.match(readFileSync(join(dirs.claude, 'writing', 'SKILL.md'), 'utf8'), /클로드/);
  assert.match(readFileSync(join(dirs.codex, 'writing', 'SKILL.md'), 'utf8'), /코덱스/);
});

test('--prefer newer 는 최근에 고친 쪽으로 맞추고, 덮이는 쪽 원본은 .sync-backup 에 남긴다', () => {
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(join(dirs.claude, 'writing', 'SKILL.md'), old, old);
  const r = syncSkills({ roots, prefer: 'newer' });
  assert.ok(r.updated.some((u) => u.name === 'writing' && u.from === 'codex' && u.to === 'claude'));
  assert.match(readFileSync(join(dirs.claude, 'writing', 'SKILL.md'), 'utf8'), /코덱스/);
  const bak = readdirSync(join(dirs.claude, '.sync-backup'));
  assert.equal(bak.length, 1);
  assert.match(readFileSync(join(dirs.claude, '.sync-backup', bak[0], 'SKILL.md'), 'utf8'), /클로드/);
  assert.equal(syncSkills({ roots, prefer: 'newer' }).updated.length, 0);
});

test('미리보기는 아무것도 쓰지 않고, 제외 목록·점 폴더는 건드리지 않는다', () => {
  skill(dirs.codex, 'brand-new');
  skill(dirs.codex, 'secret-one');
  mkdirSync(join(dirs.codex, '.system', 'imagegen'), { recursive: true });
  writeFileSync(join(dirs.codex, '.system', 'imagegen', 'SKILL.md'), 'x');
  const dry = syncSkills({ roots, dryRun: true, exclude: ['secret-one'] });
  assert.ok(dry.copied.some((c) => c.name === 'brand-new'));
  assert.ok(!existsSync(join(dirs.claude, 'brand-new')));
  syncSkills({ roots, exclude: ['secret-one'] });
  assert.ok(existsSync(join(dirs.claude, 'brand-new')));
  assert.ok(!existsSync(join(dirs.claude, 'secret-one')));
  assert.ok(!existsSync(join(dirs.claude, '.system')));
});

test('상위 폴더가 없는 대상(설치 안 된 Codex 등)은 만들지 않고 건너뛴다', () => {
  const r = syncSkills({ roots: [...roots, { id: 'ghost', label: '없는 곳', dir: join(root, 'nope', 'skills') }] });
  assert.ok(!r.roots.some((x) => x.id === 'ghost'));
  assert.ok(!existsSync(join(root, 'nope')));
});
