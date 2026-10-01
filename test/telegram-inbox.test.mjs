// 봇이 텔레그램으로 받은 사진·파일(.telegram/inbox)을 읽을 수 있고, 토큰·허용 목록은 여전히 못 읽는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

sandbox();
const O = await import('../src/offices.mjs');
const settingsOf = (o) => JSON.parse(readFileSync(join(o.folder, '.claude', 'settings.json'), 'utf8'));

test('새 사무실: 토큰·허용 목록 읽기는 막고, inbox 는 막지 않는다', () => {
  const o = O.createOffice({ name: 'Inbox One', presets: [] });
  const deny = settingsOf(o).permissions.deny;
  assert.ok(!deny.includes('Read(./.telegram/**)'), '폴더 전체 읽기 금지가 남아 있으면 사진을 열 수 없다');
  for (const d of ['Read(./.telegram/.env)', 'Read(./.telegram/access.json)', 'Read(./.telegram/rooms.json)', 'Read(./.telegram/approved/**)', 'Edit(./.telegram/**)']) assert.ok(deny.includes(d), d);
  assert.ok(!deny.some((d) => /inbox/.test(d)), 'inbox 는 차단 목록에 없어야 한다');
  const md = readFileSync(join(o.folder, 'CLAUDE.md'), 'utf8');
  assert.match(md, /\.telegram\/inbox\/`? 는 .*읽기만/);
});

test('예전 사무실: 옛 차단 규칙과 옛 지침 줄을 새 규칙으로 바꾸고, 다시 돌려도 그대로다', () => {
  const o = O.createOffice({ name: 'Inbox Old', presets: [] });
  const file = join(o.folder, '.claude', 'settings.json');
  const s = settingsOf(o);
  s.permissions.deny = s.permissions.deny.filter((d) => !d.startsWith('Read(./.telegram/')).concat('Read(./.telegram/**)');
  writeFileSync(file, JSON.stringify(s, null, 2));
  const mdFile = join(o.folder, 'CLAUDE.md');
  const md = readFileSync(mdFile, 'utf8').replace(/^- `\.telegram\/`의 봇 토큰.*$/m, '- `.telegram/`(봇 토큰)와 `.ai-office/` 폴더는 읽거나 수정하지 않는다.');
  writeFileSync(mdFile, md + '\n- (2026-10-01) 내가 직접 적은 규칙 — 그대로 남아야 함\n');

  assert.ok(O.repairOffices().includes(o.id));
  const deny = settingsOf(o).permissions.deny;
  assert.ok(!deny.includes('Read(./.telegram/**)'));
  assert.ok(deny.includes('Read(./.telegram/.env)') && deny.includes('Read(./.telegram/access.json)'));
  assert.ok(deny.includes('Edit(./.claude/settings.json)'), '다른 차단 규칙은 그대로');
  const after = readFileSync(mdFile, 'utf8');
  assert.match(after, /inbox/);
  assert.match(after, /내가 직접 적은 규칙 — 그대로 남아야 함/);

  const before = [readFileSync(file, 'utf8'), after];
  assert.ok(!O.repairOffices().includes(o.id), '이미 맞춰졌으면 고칠 것이 없다');
  assert.deepEqual([readFileSync(file, 'utf8'), readFileSync(mdFile, 'utf8')], before);
});
