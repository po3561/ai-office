import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, fakeLegacyOffice } from './helpers.mjs';
const root = sandbox();
const T = await import('../src/teams.mjs');
const O = await import('../src/offices.mjs');
const P = await import('../src/paths.mjs');

test('saved organization merges agent files created outside the dashboard', () => {
  const dir = fakeLegacyOffice(join(root, 'merge'));
  T.saveOffice(dir, { name: 'Custom', teams: [] });
  assert.deepEqual(T.loadOffice(dir).teams.map(t => t.key), ['developer']);
  assert.equal(T.loadOffice(dir).name, 'Custom');
});
test('corrupt organization recovers previous valid metadata without replacing damaged evidence', () => {
  const dir = fakeLegacyOffice(join(root, 'recover'));
  T.saveOffice(dir, { name: 'Original', honorific: 'Owner', teams: T.listTeams(dir) });
  T.saveOffice(dir, { ...T.loadOffice(dir), name: 'Latest' });
  writeFileSync(T.officeJsonPath(dir), '{broken');
  const office = T.loadOffice(dir);
  assert.equal(office.name, 'Original');
  assert.equal(office.recovery.status, 'previous-valid');
  assert.equal(readFileSync(T.officeJsonPath(dir), 'utf8'), '{broken');
  T.addTeam(dir, { key: 'qa-team', name: 'QA', role: 'Review' });
  assert.equal(T.listTeams(dir).length, 2);
});
test('retired department markers prevent a leftover agent from resurrecting it', () => {
  const dir = fakeLegacyOffice(join(root, 'retired'));
  T.removeTeam(dir, 'developer');
  writeFileSync(join(T.agentsDir(dir), 'developer.md'), '---\nname: developer\ndescription: Old\n---\nOld');
  assert.deepEqual(T.listTeams(dir), []);
  assert.ok(T.loadOffice(dir).retiredTeams.some(t => t.key === 'developer'));
});
test('retirement survives damaged office.json whose previous document predates the removal', () => {
  const dir = fakeLegacyOffice(join(root, 'retired-recovery'));
  T.removeTeam(dir, 'developer');
  writeFileSync(T.officeJsonPath(dir), '{broken');
  assert.equal(T.loadOffice(dir).recovery.status, 'previous-valid');
  assert.deepEqual(T.listTeams(dir), []);
  T.addTeam(dir, { key: 'developer', name: 'New development', role: 'Build' });
  assert.equal(T.listTeams(dir).length, 1);
});
test('corrupt registry never silently becomes empty; previous valid registry keeps disconnected offices', () => {
  mkdirSync(P.DATA_HOME, { recursive: true });
  writeFileSync(P.FILES.offices, JSON.stringify({ offices: [{ id: 'offline', folder: join(root, 'missing'), name: 'External' }] }));
  O.updateOffice('offline', { name: 'Changed' });
  writeFileSync(P.FILES.offices, '{broken');
  assert.equal(O.listOffices()[0].id, 'offline');
  assert.equal(O.listOffices()[0].folder, join(root, 'missing'));
});
test('damaged organization without recovery source cannot be silently saved as an empty organization', () => {
  const dir = join(root, 'unrecoverable');
  mkdirSync(join(dir, '.ai-office'), { recursive: true });
  writeFileSync(T.officeJsonPath(dir), '{broken');
  assert.equal(T.loadOffice(dir).recovery.status, 'damaged');
  assert.throws(() => T.saveOffice(dir, T.loadOffice(dir)), /손상/);
});
test('readding an explicitly retired department clears its tombstone', () => {
  const dir = fakeLegacyOffice(join(root, 'readd'));
  T.removeTeam(dir, 'developer');
  T.addTeam(dir, { key: 'developer', name: 'Development', role: 'Build' });
  assert.equal(T.listTeams(dir)[0].key, 'developer');
});
test('a disconnected drive never auto-relinks an office to a different same-name folder', { skip: process.platform !== 'win32' }, () => {
  const letter = 'ZYXWVUTSRQPONMLKJIHGEBA'.split('').find(l => !existsSync(`${l}:\\`));
  if (!letter) return;
  const target = join(P.OFFICES_DIR, 'Offline-Office');
  mkdirSync(join(target, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(target, 'CLAUDE.md'), '# unrelated');
  const folder = `${letter}:\\Offline-Office`;
  writeFileSync(P.FILES.offices, JSON.stringify({ offices: [{ id: 'offline-drive', folder, name: 'Original', kind: 'claude-office' }] }));
  O.autoRelink();
  assert.equal(O.getOffice('offline-drive').folder, folder);
});
