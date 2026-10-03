import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'lapis-telegram-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hermesHome = join(root, 'hermes'), claudeTelegramDir = join(root, 'claude');
  await Promise.all([mkdir(hermesHome), mkdir(claudeTelegramDir)]);
  const db = new DatabaseSync(join(hermesHome, 'state.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, chat_id TEXT, thread_id TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL);');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('tg', 'telegram', '-123', '7');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('cli', 'cli', null, null);
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= count; i++) insert.run(i, 'tg', i % 2 ? 'user' : 'assistant', `telegram ${i}`, 1790848000 + i);
  insert.run(1001, 'cli', 'user', 'PRIVATE CLI TEXT', 1790849000);
  insert.run(1002, 'tg', 'tool', 'PRIVATE TOOL TEXT', 1790849001);
  db.close();
  await writeFile(join(hermesHome, 'gateway_state.json'), JSON.stringify({ pid: process.pid, gateway_state: 'running', platforms: { telegram: { state: 'connected' } }, updated_at: '2026-10-01T01:00:00Z' }));
  await writeFile(join(claudeTelegramDir, 'bot.pid'), String(process.pid));
  await writeFile(join(claudeTelegramDir, 'context.json'), JSON.stringify({ '-456:2': { deliveredId: 5, items: [
    { id: 1, at: 1790848100000, from: '부과장님', text: 'office task' },
    { id: 2, at: 1790848101000, from: '카오(비서실장)', text: 'office reply' },
    { id: 2.1, at: 1790848102000, from: '라피스(봇)', text: 'MIRRORED HERMES' },
  ] }, __hermesLastId: 2 }));
  return { hermesHome, claudeTelegramDir };
}
async function snapshot(options) {
  const mod = await import('../src/telegram.mjs').catch(() => null);
  assert.ok(mod?.telegramSnapshot, 'telegramSnapshot connector must be implemented');
  return mod.telegramSnapshot(options);
}

test('reads two distinct bots, excludes CLI/tool/mirrored records and leaves sources unchanged', async t => {
  const options = await fixture(t);
  const paths = [join(options.hermesHome, 'state.db'), join(options.claudeTelegramDir, 'context.json')];
  const before = await Promise.all(paths.map(p => readFile(p)));
  const result = await snapshot(options);
  assert.equal(result.bots.length, 2);
  assert.equal(result.messages.length, 4);
  assert.deepEqual(result.messages.map(m => m.botId).sort(), ['kao', 'kao', 'lapis', 'lapis']);
  assert.ok(result.messages.every(m => ['user', 'assistant'].includes(m.role)));
  assert.ok(result.messages.filter(m => m.role === 'assistant').every(m => m.source.endsWith('-recorded')));
  assert.ok(result.messages.every(m => !/PRIVATE|MIRRORED/.test(m.text)));
  assert.ok(result.bots.every(b => b.running === true));
  assert.equal(result.bots.find(b => b.id === 'lapis').sourceUpdatedAt, '2026-10-01T01:00:00.000Z');
  assert.notEqual(result.bots.find(b => b.id === 'lapis').lastReceivedAt, result.observedAt);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p))), before);
});

test('returns only latest 100 aggregate messages and deterministic unique IDs', async t => {
  const options = await fixture(t, 150);
  const result = await snapshot(options);
  assert.equal(result.messages.length, 100);
  assert.equal(new Set(result.messages.map(m => m.id)).size, 100);
  assert.ok(result.messages.every((m, i, a) => !i || a[i - 1].at >= m.at));
  assert.deepEqual((await snapshot(options)).messages, result.messages);
});

test('redacts credentials, bounds text, extracts text blocks and excludes image payloads', async t => {
  const options = await fixture(t);
  const db = new DatabaseSync(join(options.hermesHome, 'state.db'));
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789';
  db.prepare('UPDATE messages SET content=? WHERE id=1').run(JSON.stringify([{ type: 'text', text: `token=${token} password=hunter222 ${'x'.repeat(4000)}` }, { type: 'image_url', image_url: { url: 'SECRET_IMAGE' } }]));
  db.close();
  const result = await snapshot(options);
  const text = result.messages.find(m => m.botId === 'lapis' && m.role === 'user').text;
  assert.ok(text.length <= 3000);
  assert.ok(!text.includes(token) && !text.includes('hunter222') && !text.includes('SECRET_IMAGE'));
  assert.match(text, /REDACTED/);
});

test('one malformed source does not hide other bot and never claims stale pid is running', async t => {
  const options = await fixture(t);
  await writeFile(join(options.claudeTelegramDir, 'context.json'), '{bad');
  await writeFile(join(options.hermesHome, 'gateway_state.json'), JSON.stringify({ pid: 2147483647, gateway_state: 'running', updated_at: '2026-10-01T01:00:00Z' }));
  const result = await snapshot(options);
  assert.equal(result.messages.length, 2);
  assert.equal(result.bots.find(b => b.id === 'lapis').running, false);
  assert.equal(result.bots.find(b => b.id === 'kao').status, 'unavailable');
  assert.ok(result.errors.some(e => e.botId === 'kao'));
  assert.ok(!JSON.stringify(result.errors).includes(options.claudeTelegramDir));
});

test('missing sources return unavailable summaries without creating state files', async t => {
  const options = await fixture(t);
  await rm(join(options.hermesHome, 'state.db'));
  await rm(join(options.claudeTelegramDir, 'context.json'));
  const result = await snapshot(options);
  assert.equal(result.messages.length, 0);
  assert.equal(result.errors.length, 2);
  await assert.rejects(readFile(join(options.hermesHome, 'state.db')), { code: 'ENOENT' });
});
