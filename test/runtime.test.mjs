import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const { createSecrets, plain } = await import('../src/secrets.mjs');
const { createBots } = await import('../src/bots.mjs');
const { createTgApi } = await import('../src/tgapi.mjs');
const { createRuntime, chunk, stripThinking, pickAgent, buildSystem } = await import('../src/runtime.mjs');
const { createEngines, flatten } = await import('../src/engines.mjs');

const TOKEN = '123456789:' + 'A'.repeat(35);
let seq = 0;

// 가짜 텔레그램 서버: getMe / getUpdates(대기열) / sendMessage 기록
async function fakeTelegram(t) {
  const state = { queue: [], sent: [], actions: 0 };
  const s = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      const ok = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (!req.url.includes(TOKEN)) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
      if (method === 'getMe') return ok({ id: 777, username: 'lapis_test_bot', first_name: 'LapisTest' });
      if (method === 'sendMessage') { state.sent.push(body); return ok({ message_id: 1 }); }
      if (method === 'sendChatAction') { state.actions++; return ok(true); }
      if (method === 'getUpdates') {
        const take = state.queue.splice(0);
        if (take.length) return ok(take);
        setTimeout(() => ok([]), 30);
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.closeAllConnections(); s.close(r); }));
  state.base = 'http://127.0.0.1:' + s.address().port;
  return state;
}

const msg = (over = {}) => ({ message_id: ++seq, date: Math.floor(Date.now() / 1000), chat: { id: 5001, type: 'private' }, from: { id: 5001, first_name: '테스터' }, text: '안녕', ...over });

async function setup(t, { engineReply = () => '답변이에요' } = {}) {
  const tgState = await fakeTelegram(t);
  const secrets = createSecrets({ file: join(root, `sec-${seq++}.bin`), crypto: plain });
  const tg = createTgApi({ base: tgState.base });
  const bots = createBots({ dir: join(root, `bots-${seq++}`), secrets, tg });
  const calls = [];
  const engines = { complete: async (req) => { calls.push(req); return engineReply(req); } };
  const bot = bots.create({ name: '테스트 봇', engine: { type: 'ollama', model: 'm1' }, presets: ['planner', 'researcher'] });
  await bots.saveToken(bot.id, TOKEN);
  const rt = createRuntime({ bots, engines, tg, pollTimeout: 1 });
  t.after(() => rt.stop(bot.id));
  return { tgState, bots, rt, bot, calls, secrets };
}
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('시간 초과'); };

test('봇 만들기: 추천 부서가 에이전트가 되고, 이름으로 안전한 id 가 정해진다', async (t) => {
  const { bots, bot } = await setup(t);
  assert.equal(bot.agents.length, 2);
  assert.deepEqual(bot.agents.map((a) => a.key), ['planner', 'researcher']);
  assert.equal(bot.defaultAgent, '');
  const b2 = bots.create({ name: '테스트 봇', engine: { type: 'openai', model: 'gpt-x' } });
  assert.notEqual(b2.id, bot.id);
  assert.throws(() => bots.create({ name: '', engine: { type: 'ollama' } }), /이름/);
  assert.throws(() => bots.create({ name: 'x', engine: { type: 'evil' } }), /엔진/);
  assert.throws(() => bots.create({ name: 'x', engine: { type: 'ollama', model: 'a b;rm' } }), /모델/);
  assert.throws(() => bots.load('../x'), (e) => e.status === 404);
});

test('에이전트: 추가·수정·삭제하고, 삭제하면 방·주제 연결도 비운다', async (t) => {
  const { bots, bot } = await setup(t);
  const a = bots.addAgent(bot.id, { name: '물류팀', role: '배송', instructions: '빠르게', engine: { type: 'openai', model: 'gpt-x' }, access: 'chat' });
  assert.match(a.key, /^agent-\d+$|^[a-z]/);
  bots.update(bot.id, { defaultAgent: 'planner' });
  bots.touchRoom(bot.id, { chatId: -1001, title: '업무방' });
  bots.setRoom(bot.id, -1001, { agent: 'planner' });
  bots.setTopic(bot.id, -1001, 7, { name: '기획', agent: 'planner', instructions: '개조식' });
  bots.updateAgent(bot.id, a.key, { instructions: '더 빠르게', skills: ['s-1', '../bad'] });
  assert.deepEqual(bots.load(bot.id).agents.find((x) => x.key === a.key).skills, ['s-1']);
  bots.removeAgent(bot.id, 'planner');
  const after = bots.load(bot.id);
  assert.equal(after.defaultAgent, 'researcher');
  assert.equal(after.telegram.rooms['-1001'].agent, '');
  assert.equal(after.telegram.rooms['-1001'].topics['7'].agent, '');
  assert.throws(() => bots.update(bot.id, { defaultAgent: 'nope' }), /없는 에이전트/);
  assert.throws(() => bots.updateAgent(bot.id, 'nope', {}), (e) => e.status === 404);
});

test('토큰: 형식·검증을 거쳐 비밀 저장소에만 두고, 봇 파일에는 남기지 않는다', async (t) => {
  const { bots, bot, secrets } = await setup(t);
  const text = readFileSync(join(bots.folder(bot.id), 'bot.json'), 'utf8');
  assert.equal(text.includes(TOKEN), false);
  assert.equal(await secrets.get('tg:' + bot.id), TOKEN);
  assert.equal(bots.load(bot.id).telegram.username, 'lapis_test_bot');
  await assert.rejects(bots.saveToken(bot.id, 'bad'), /형식/);
  await assert.rejects(bots.saveToken(bot.id, '123456789:' + 'B'.repeat(35)), /확인하지 못했/);
  const d = await bots.detail(bot.id);
  assert.equal(JSON.stringify(d).includes(TOKEN), false);
});

test('모르는 사람의 DM: 페어링 코드만 알려 주고 엔진은 부르지 않는다. 코드를 입력하면 허용된다', async (t) => {
  const { tgState, bots, rt, bot, calls } = await setup(t);
  tgState.queue.push({ update_id: 1, message: msg() });
  await rt.start(bot.id);
  await waitFor(() => tgState.sent.length);
  const code = /코드: (\d{6})/.exec(tgState.sent[0].text)[1];
  assert.equal(calls.length, 0);
  assert.equal(bots.isAllowed(bot.id, 5001), false);
  assert.throws(() => bots.pair(bot.id, '000000'), /없거나 만료/);
  bots.pair(bot.id, code);
  assert.equal(bots.isAllowed(bot.id, 5001), true);
  tgState.queue.push({ update_id: 2, message: msg({ text: '지금은 되나요?' }) });
  await waitFor(() => tgState.sent.length >= 2);
  assert.equal(tgState.sent[1].text, '답변이에요');
  assert.equal(calls.length, 1);
});

test('허용된 사람의 대화: 기억을 이어 붙이고, 지침·역할이 시스템 프롬프트에 들어간다', async (t) => {
  const { tgState, bots, rt, bot, calls } = await setup(t);
  bots.update(bot.id, { defaultAgent: 'planner', persona: '친절한 비서', honorific: '대표님' });
  bots.requestPairing(bot.id, { senderId: 5001, chatId: 5001 });
  bots.pair(bot.id, Object.keys(bots.load(bot.id).telegram.pending)[0]);
  tgState.queue.push({ update_id: 1, message: msg({ text: '기획안 써줘' }) });
  await rt.start(bot.id);
  await waitFor(() => calls.length === 1);
  assert.match(calls[0].system, /친절한 비서/);
  assert.match(calls[0].system, /대표님/);
  assert.match(calls[0].system, /기획팀/);
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: '기획안 써줘' }]);
  await waitFor(() => tgState.sent.length === 1);
  tgState.queue.push({ update_id: 2, message: msg({ text: '더 짧게' }) });
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(calls[1].messages[1].content, '답변이에요');
});

test('그룹방: 멘션·답장·/명령일 때만 답하고, 주제별 에이전트와 지침을 적용한다. 허용되지 않은 사람은 무시', async (t) => {
  const { tgState, bots, rt, bot, calls } = await setup(t);
  bots.requestPairing(bot.id, { senderId: 5001, chatId: 5001 });
  bots.pair(bot.id, Object.keys(bots.load(bot.id).telegram.pending)[0]);
  const group = { id: -100200, type: 'supergroup', title: '업무방', is_forum: true };
  await rt.start(bot.id);
  const q = (u) => tgState.queue.push(u);
  q({ update_id: 1, message: msg({ chat: group, text: '그냥 잡담', message_thread_id: 9, is_topic_message: true }) });   // 멘션 없음 → 무시(방은 기록)
  await waitFor(() => bots.load(bot.id).telegram.rooms['-100200']);
  assert.equal(calls.length, 0);
  bots.setTopic(bot.id, -100200, 9, { name: '리서치', agent: 'researcher', instructions: '출처를 적어라' });
  q({ update_id: 2, message: msg({ chat: group, text: '@lapis_test_bot 자료 찾아줘', message_thread_id: 9, is_topic_message: true }) });
  await waitFor(() => calls.length === 1);
  assert.match(calls[0].system, /리서치·데이터팀/);
  assert.match(calls[0].system, /출처를 적어라/);
  assert.equal(calls[0].messages[0].content, '자료 찾아줘');
  await waitFor(() => tgState.sent.length === 1);
  assert.equal(tgState.sent[0].message_thread_id, 9);
  assert.equal(tgState.sent[0].chat_id, -100200);
  q({ update_id: 3, message: msg({ chat: group, from: { id: 9999, first_name: '낯선이' }, text: '@lapis_test_bot 나도', message_thread_id: 9, is_topic_message: true }) });
  q({ update_id: 4, message: msg({ chat: group, text: '/whoami', message_thread_id: 9, is_topic_message: true }) });
  await waitFor(() => tgState.sent.length === 2);
  assert.match(tgState.sent[1].text, /주제 번호: 9/);
  assert.equal(calls.length, 1);   // 낯선 사람은 엔진을 부르지 못했다
  bots.setRoom(bot.id, -100200, { mode: 'all' });
  q({ update_id: 5, message: msg({ chat: group, text: '멘션 없이도', message_thread_id: 9, is_topic_message: true }) });
  await waitFor(() => calls.length === 2);
});

test('/agent 명령은 그 주제의 담당 에이전트를 바꾼다. 이름으로 부르면 그 에이전트가 답한다', async (t) => {
  const { tgState, bots, rt, bot, calls } = await setup(t);
  bots.requestPairing(bot.id, { senderId: 5001, chatId: 5001 });
  bots.pair(bot.id, Object.keys(bots.load(bot.id).telegram.pending)[0]);
  await rt.start(bot.id);
  tgState.queue.push({ update_id: 1, message: msg({ text: '/agent researcher' }) });
  await waitFor(() => tgState.sent.length === 1);
  assert.match(tgState.sent[0].text, /리서치·데이터팀 역할/);
  assert.equal(bots.load(bot.id).defaultAgent, 'researcher');
  tgState.queue.push({ update_id: 2, message: msg({ text: '기획팀 올해 계획 정리' }) });
  await waitFor(() => calls.length === 1);
  assert.match(calls[0].system, /지금 맡은 역할: 📋 기획팀/);
  assert.equal(calls[0].messages.at(-1).content, '올해 계획 정리');
});

test('엔진이 실패하면 사용자에게 알리고 런타임은 계속 돈다. 묵은 메시지는 무시한다', async (t) => {
  let n = 0;
  const { tgState, bots, rt, bot } = await setup(t, { engineReply: () => { if (++n === 1) throw new Error('모델이 없어요'); return '두 번째는 성공'; } });
  bots.requestPairing(bot.id, { senderId: 5001, chatId: 5001 });
  bots.pair(bot.id, Object.keys(bots.load(bot.id).telegram.pending)[0]);
  await rt.start(bot.id);
  tgState.queue.push({ update_id: 1, message: msg({ date: Math.floor(Date.now() / 1000) - 3600, text: '아주 오래된 메시지' }) });
  tgState.queue.push({ update_id: 2, message: msg({ text: '첫 질문' }) });
  await waitFor(() => tgState.sent.length === 1);
  assert.match(tgState.sent[0].text, /답을 만들지 못했어요: 모델이 없어요/);
  tgState.queue.push({ update_id: 3, message: msg({ text: '다시' }) });
  await waitFor(() => tgState.sent.length === 2);
  assert.equal(tgState.sent[1].text, '두 번째는 성공');
  assert.equal(n, 2);
  assert.equal(rt.view(bot.id).running, true);
});

test('긴 답은 나눠 보내고, 생각 과정(<think>)은 숨긴다', () => {
  const long = ('가나다라 '.repeat(400) + '\n').repeat(3);
  const parts = chunk(long, 1000);
  assert.ok(parts.length >= 5);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(stripThinking('<think>음...</think>\n정답'), '정답');
  assert.equal(stripThinking('<think>끝나지 않음'), '');
});

test('pickAgent: 주제 → 방 → 호출어 → 기본 순서', async (t) => {
  const { bots, bot } = await setup(t);
  const b = bots.load(bot.id);
  assert.equal(pickAgent(b, { text: '리서치·데이터팀 조사해줘' }).agent.key, 'researcher');
  assert.equal(pickAgent(b, { text: '@planner 계획' }).text, '계획');
  assert.equal(pickAgent(b, { text: '그냥' }).agent, null);
  assert.equal(pickAgent(b, { room: { agent: 'planner' }, topic: { agent: 'researcher' }, text: '그냥' }).agent.key, 'researcher');
});

test('스킬: 에이전트에 붙인 스킬 본문이 지침에 들어간다', async (t) => {
  const { bots, bot } = await setup(t);
  const dir = join(bots.skillsDir(bot.id), 'report-style');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: 보고서 문체\ndescription: 개조식으로 쓴다\n---\n\n항상 □ ○ - 순서로 쓴다.\n', 'utf8');
  bots.updateAgent(bot.id, 'planner', { skills: ['report-style'] });
  const b = bots.load(bot.id);
  const sys = buildSystem(b, { agent: b.agents[0], skillsDir: bots.skillsDir(bot.id) });
  assert.match(sys, /스킬: 보고서 문체/);
  assert.match(sys, /□ ○ - 순서/);
});

test('엔진 어댑터: OpenAI·Anthropic 요청 모양, 명령줄 엔진(claude·codex)의 인자와 권한', async () => {
  const secrets = createSecrets({ file: join(root, 'eng.bin'), crypto: plain });
  await secrets.set('openai', 'sk-' + 'a'.repeat(30));
  await secrets.set('anthropic', 'sk-ant-' + 'b'.repeat(30));
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(/openai/.test(url) ? { choices: [{ message: { content: 'gpt 답' } }] } : { content: [{ type: 'text', text: '클로드 답' }] }), { status: 200 });
  };
  const ran = [];
  const runImpl = async (cmd, args, opts) => { ran.push({ cmd, args, opts }); if (args.includes('-o')) writeFileSync(args[args.indexOf('-o') + 1], 'codex 답'); return { code: 0, stdout: 'cli 답\n', stderr: '' }; };
  const components = { detect: async (id) => ({ installed: true, path: `C:/tools/${id}.exe`, version: '1' }) };
  const e = createEngines({ ollama: null, secrets, components, fetchImpl, runImpl });
  const messages = [{ role: 'user', content: '질문' }];
  assert.equal(await e.complete({ engine: { type: 'openai', model: 'gpt-x' }, system: 'S', messages }), 'gpt 답');
  assert.equal(fetched[0].body.messages[0].role, 'system');
  assert.match(fetched[0].headers.authorization, /^Bearer sk-/);
  assert.equal(await e.complete({ engine: { type: 'anthropic', model: 'claude-x' }, system: 'S', messages }), '클로드 답');
  assert.equal(fetched[1].body.system, 'S');
  assert.equal(fetched[1].headers['anthropic-version'], '2023-06-01');
  assert.equal(await e.complete({ engine: { type: 'claude', model: '' }, system: 'S', messages, access: 'chat', cwd: join(root, 'w1') }), 'cli 답');
  assert.ok(ran[0].args.includes('--tools'));
  assert.ok(ran[0].args.includes('--append-system-prompt-file'));
  assert.equal(ran[0].args.includes('Edit'), false);
  await e.complete({ engine: { type: 'claude' }, system: 'S', messages, access: 'write', cwd: join(root, 'w1') });
  assert.ok(ran[1].args.includes('Edit') && ran[1].args.includes('acceptEdits'));
  assert.equal(await e.complete({ engine: { type: 'codex', model: 'm' }, system: 'S', messages, access: 'read', cwd: join(root, 'w1') }), 'codex 답');
  assert.equal(ran[2].args[ran[2].args.indexOf('--sandbox') + 1], 'read-only');
  await e.complete({ engine: { type: 'codex' }, system: 'S', messages, access: 'write', cwd: join(root, 'w1') });
  assert.equal(ran[3].args[ran[3].args.indexOf('--sandbox') + 1], 'workspace-write');
  // API 엔진은 access 를 무시하고(도구 없음), 알 수 없는 엔진은 거절한다
  await assert.rejects(e.complete({ engine: { type: 'evil' }, messages }), /엔진 종류/);
  assert.match(flatten({ system: 'S', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] }), /이전 대화[\s\S]*사용자: a[\s\S]*나: b[\s\S]*지금 온 메시지\]\nc/);
});

test('봇 폐쇄: 이름을 똑같이 입력해야 하고, 폴더는 보관 위치로 옮기고 토큰은 지운다', async (t) => {
  const { bots, bot, secrets } = await setup(t);
  await assert.rejects(bots.close(bot.id, '다른 이름'), /똑같이/);
  await bots.close(bot.id, '테스트 봇');
  assert.equal(existsSync(bots.folder(bot.id)), false);
  assert.equal(await secrets.has('tg:' + bot.id), false);
});
