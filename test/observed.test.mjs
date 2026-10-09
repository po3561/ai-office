import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const O = await import('../src/observed.mjs');
const { projectSlug } = await import('../src/roomlog.mjs');
const { createUsage } = await import('../src/usage.mjs');

const line = (o) => JSON.stringify(o) + '\n';
const reply = (id, at, usage, extra = {}) => line({ type: 'assistant', timestamp: at, requestId: id, message: { id, model: 'claude-sonnet-5-5', usage, content: [{ type: 'text', text: 'ok' }], ...extra } });
const inbound = (at) => line({ type: 'user', timestamp: at, message: { role: 'user', content: '<channel source="plugin:telegram:telegram" chat_id="-1" user="a">지시</channel>' } });
const limit = (at) => line({ type: 'assistant', timestamp: at, isApiErrorMessage: true, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 10, 4pm (Asia/Seoul)" }] } });

function claudeOffice() {
  const root = mkdtempSync(join(tmpdir(), 'obs-'));
  const folder = join(root, 'My Office');
  mkdirSync(folder);
  const dir = join(root, 'claude', 'projects', projectSlug(folder));
  mkdirSync(join(dir, 'session-a', 'subagents'), { recursive: true });
  return { root, folder, dir, claudeHome: join(root, 'claude'), office: { id: 'office', name: 'Office', kind: 'claude-office', folder } };
}

test('limit messages are turned into a Korean reset time', () => {
  assert.equal(O.limitText("You've hit your weekly limit · resets Oct 10, 4pm (Asia/Seoul)"), '주간 한도 초과 · 10월 10일 오후 4시에 풀려요');
  assert.equal(O.limitText('Session limit reached ∙ resets 11:30am'), '5시간 한도 초과 · 오전 11시 30분에 풀려요');
  assert.equal(O.limitText('limit'), '사용 한도 초과');
});

test('Claude transcripts count each response once, read only appended lines, and include subagents', async () => {
  const c = claudeOffice();
  const file = join(c.dir, 'main.jsonl');
  const u = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
  // 한 응답이 내용 조각마다 줄을 남긴다(같은 id) → 한 번만 센다
  writeFileSync(file, inbound('2026-10-08T00:00:00Z') + reply('r1', '2026-10-08T00:00:05Z', u) + reply('r1', '2026-10-08T00:00:06Z', u));
  writeFileSync(join(c.dir, 'session-a', 'subagents', 'agent-1.jsonl'), reply('s1', '2026-10-08T00:00:07Z', { input_tokens: 1, output_tokens: 1 }));
  let clock = Date.parse('2026-10-08T01:00:00Z');
  const obs = O.createObserver({ claudeHome: c.claudeHome, now: () => clock, ttlMs: 0 });
  let r = await obs.office(c.office);
  assert.equal(r.available, true);
  assert.equal(r.events.length, 2);
  const main = r.events.find((e) => e.requestId === 'claude:r1');
  assert.deepEqual([main.inputTokens, main.outputTokens, main.cacheReadTokens, main.cacheWriteTokens], [1210, 5, 1000, 200]);
  assert.equal(main.botId, 'office');
  assert.equal(main.billing, 'subscription');
  assert.equal(r.context.tokens, 1210);           // 서브에이전트가 아니라 본 대화의 길이
  assert.equal(r.inboundAt, '2026-10-08T00:00:00Z');

  appendFileSync(file, inbound('2026-10-08T00:10:00Z') + limit('2026-10-08T00:10:01Z'));
  clock += 1000;
  r = await obs.office(c.office);
  assert.equal(r.events.length, 2);
  assert.equal(r.incidents.length, 1);
  assert.equal(r.incidents[0].kind, 'limit');

  const verdict = O.assess({ office: c.office, runtime: { running: true }, observed: r, nowMs: clock });
  assert.equal(verdict.state, 'bad');
  assert.match(verdict.headline, /주간 한도 초과 · 10월 10일 오후 4시에 풀려요/);
  assert.equal(verdict.usage.today.calls, 2);

  // 다시 답하기 시작하면 "지금 막힘"이 아니라 "최근에 걸린 적 있음"으로 내려간다
  appendFileSync(file, reply('r2', '2026-10-08T00:20:00Z', u));
  clock += 1000;
  const recovered = O.assess({ office: c.office, runtime: { running: true }, observed: await obs.office(c.office), nowMs: clock });
  assert.equal(recovered.state, 'warn');
  assert.match(recovered.headline, /다시 답하는 중/);
});

test('Hermes log lines become one failure per exhausted retry, network notes and blocked senders', () => {
  const log = [
    '2026-10-08 11:43:55,532 ERROR agent.chat_completion_helpers: Streaming failed before delivery: Gemini HTTP 503 (UNAVAILABLE): high demand',
    '2026-10-08 11:44:00,000 WARNING agent.conversation_loop: API call failed (attempt 1/3) error_type=GeminiAPIError',
    'Traceback (most recent call last):',
    '2026-10-08 11:44:31,112 ERROR [s1] agent.conversation_loop: API call failed after 3 retries. Gemini HTTP 503 (UNAVAILABLE): This model is currently experiencing high demand.',
    '2026-10-08 10:13:43,241 ERROR telegram.ext: Network Retry Loop (Bootstrap delete Webhook): Timed out: Timed out.',
    '2026-10-08 12:38:42,203 WARNING hermes_plugins.telegram_platform.adapter: [Telegram] Blocked unauthorized user 5550001111 in chat -100389',
    '2026-10-01 12:38:42,203 ERROR old: ignored because it is older than since',
  ].join('\n');
  const list = O.hermesIncidents(log, { since: Date.parse('2026-10-07T00:00:00') });
  assert.deepEqual(list.map((i) => i.kind), ['provider-busy', 'network', 'blocked']);
  assert.match(list[0].text, /^Gemini HTTP 503/);
  assert.equal(list[2].user, '5550001111');
});

test('a single provider failure warns, three in a row after the last reply means the bot cannot answer', () => {
  const office = { id: 'h', name: 'Hermes', kind: 'hermes' };
  const at = (m) => `2026-10-08T00:${String(m).padStart(2, '0')}:00.000Z`;
  const nowMs = Date.parse('2026-10-08T01:00:00Z');
  const once = O.assess({ office, runtime: { running: true, telegram: 'connected' }, nowMs, observed: { replyAt: at(1), inboundAt: at(2), incidents: [{ kind: 'provider-busy', at: at(3), text: 'Gemini HTTP 503' }] } });
  assert.equal(once.state, 'warn');
  assert.match(once.headline, /가장 최근 지시에는 답하지 못했어요/);
  const stuck = O.assess({ office, runtime: { running: true, telegram: 'connected' }, nowMs, observed: { replyAt: at(1), incidents: [3, 4, 5].map((m) => ({ kind: 'provider-busy', at: at(m) })) } });
  assert.equal(stuck.state, 'bad');
  const blocked = O.assess({ office, runtime: { running: true }, nowMs, names: { 111: 'AI-Office 봇' }, observed: { replyAt: at(1), incidents: [{ kind: 'blocked', at: at(2), user: '111' }, { kind: 'blocked', at: at(3), user: '222' }] } });
  assert.equal(blocked.state, 'ok');
  assert.match(blocked.reasons[0].text, /^AI-Office 봇 · 허용 목록에 없는 사용자 1명\(222\)의 메시지를 24시간 2번 무시했어요/);
  const off = O.assess({ office, runtime: { running: false, detail: '게이트웨이 꺼짐' }, nowMs, observed: { incidents: [{ kind: 'provider-busy', at: at(3) }] } });
  assert.equal(off.state, 'off');
  const disconnected = O.assess({ office, runtime: { running: true, telegram: 'disconnected' }, nowMs, observed: {} });
  assert.equal(disconnected.state, 'bad');
});

test('long office conversations and unanswered instructions are called out', () => {
  const office = { id: 'o', name: 'Office', kind: 'claude-office' };
  const nowMs = Date.parse('2026-10-08T01:00:00Z');
  const r = O.assess({ office, runtime: { running: true }, nowMs, observed: { replyAt: '2026-10-08T00:00:00Z', inboundAt: '2026-10-08T00:30:00Z', context: { at: '2026-10-08T00:00:00Z', tokens: 420000 } } });
  assert.equal(r.state, 'warn');
  assert.ok(r.reasons.some((x) => /10분 넘게 답이 없어요/.test(x.text)));
  assert.ok(r.reasons.some((x) => /약 42만 토큰을 다시 읽어요/.test(x.text)));
});

test('Hermes state.db sessions are read as measured usage with call counts and provider estimates', async (t) => {
  let Db; try { ({ DatabaseSync: Db } = await import('node:sqlite')); } catch { t.skip('node:sqlite 없음'); return; }
  const folder = mkdtempSync(join(tmpdir(), 'hermes-'));
  const db = new Db(join(folder, 'state.db'));
  db.exec(`create table sessions (id text primary key, source text, started_at real);
    create table messages (id integer primary key, session_id text, role text, timestamp real);
    create table session_model_usage (session_id text, model text, billing_provider text, api_call_count integer, input_tokens integer, output_tokens integer,
      cache_read_tokens integer, cache_write_tokens integer, estimated_cost_usd real, actual_cost_usd real, first_seen real, last_seen real);
    insert into sessions values ('s1', 'telegram', 1791419000);
    insert into messages (session_id, role, timestamp) values ('s1', 'user', 1791419040), ('s1', 'assistant', 1791419048);
    insert into session_model_usage values ('s1', 'gemini-3.1-flash-lite', 'gemini', 21, 222161, 3300, 125372, 0, 0.0636, null, 1791419000, 1791427448),
                                           ('s1', 'unused', 'gemini', 0, 0, 0, 0, 0, null, null, 1791419000, 1791419000);`);
  db.close();
  const obs = O.createObserver({ claudeHome: folder, now: () => Date.parse('2026-10-08T03:00:00Z') });
  const r = await obs.office({ id: 'lapis-pilot', name: 'lapis-pilot', kind: 'hermes', folder });
  assert.equal(r.available, true);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].calls, 21);
  assert.equal(r.events[0].replyAt, undefined);
  assert.equal(r.replyAt, new Date(1791419048 * 1000).toISOString());

  const usage = createUsage({ home: mkdtempSync(join(tmpdir(), 'usage-')) });
  const q = usage.query({}, r.events);
  assert.equal(q.totals.requests, 21);
  assert.equal(q.totals.inputTokens, 222161);
  assert.equal(q.totals.cost, 0.0636);       // 단가를 정하지 않으면 Hermes 가 계산한 값
  assert.equal(q.bots[0].botName, 'lapis-pilot');
  usage.setPricing({ currency: 'USD', models: [{ provider: 'gemini', model: 'gemini-3.1-flash-lite', inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 1 }] });
  assert.notEqual(usage.query({}, r.events).totals.cost, 0.0636);   // 직접 정한 단가가 우선
});
