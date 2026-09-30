import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakeLegacyOffice } from './helpers.mjs';

const root = sandbox();
const T = await import('../src/teams.mjs');

test('기존 사무실은 에이전트 파일에서 부서를 읽어 온다', () => {
  const dir = fakeLegacyOffice(root);
  const teams = T.listTeams(dir);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].key, 'developer');
  assert.equal(teams[0].name, '개발팀');
  assert.equal(teams[0].managed, false);
});

test('부서를 추가하면 에이전트 파일·조직도 표·변경 이력이 함께 바뀐다', () => {
  const dir = join(root, 'legacy-office');
  const t = T.addTeam(dir, { preset: 'hr' });
  assert.equal(t.key, 'hr');
  assert.ok(existsSync(join(dir, '.claude', 'agents', 'hr.md')));
  const md = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /AI-OFFICE:TEAMS:START/);
  assert.match(md, /\| 인사·총무팀 \| `hr` \|/);
  assert.match(md, /\| 개발팀 \| `developer` \|/, '기존 부서도 표에 남아 있어야 한다');
  assert.match(md, /## 다른 절/, '표 밖의 내용은 그대로여야 한다');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('CLAUDE.md.bak-')), '처음 고칠 때 원본을 백업해야 한다');
  assert.match(readFileSync(join(dir, '업무데이터', '맞춤설정', '변경이력.csv'), 'utf8'), /부서 추가,?"?,?"?인사·총무팀|부서 추가/);
});

test('한글 이름만 있어도 부서 키가 만들어지고, 중복은 막는다', () => {
  const dir = join(root, 'legacy-office');
  const a = T.addTeam(dir, { name: '물류팀', role: '배송 관리' });
  assert.match(a.key, /^[a-z][a-z0-9-]+$/);
  assert.throws(() => T.addTeam(dir, { preset: 'hr' }), /이미 있는 부서/);
  assert.throws(() => T.addTeam(dir, { name: '', role: 'x' }), /이름/);
  assert.throws(() => T.addTeam(dir, { name: 'x팀', role: 'y', key: '../evil' }), /부서 키/);
});

test('부서를 없애도 파일은 지우지 않고 보관함으로 옮긴다', () => {
  const dir = join(root, 'legacy-office');
  T.removeTeam(dir, 'hr');
  assert.ok(!existsSync(join(dir, '.claude', 'agents', 'hr.md')));
  assert.ok(readdirSync(join(dir, '보관함', '부서보관')).some((f) => f.startsWith('hr_')));
  assert.ok(!T.listTeams(dir).some((t) => t.key === 'hr'));
  assert.doesNotMatch(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), /`hr`/);
  assert.throws(() => T.removeTeam(dir, 'hr'), /없는 부서/);
});

test('직접 쓴 에이전트 파일의 본문을 고치면 원본을 백업한다', () => {
  const dir = join(root, 'legacy-office');
  T.updateTeam(dir, 'developer', { instructions: '- 새 지침' });
  const body = readFileSync(join(dir, '.claude', 'agents', 'developer.md'), 'utf8');
  assert.match(body, /name: developer/);
  assert.match(body, /새 지침/);
  assert.ok(readdirSync(join(dir, '보관함', '맞춤설정_백업')).some((f) => f.endsWith('_developer.md')));
});
