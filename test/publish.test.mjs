import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const { createSecrets, plain } = await import('../src/secrets.mjs');
const { createBots } = await import('../src/bots.mjs');
const { createTgApi } = await import('../src/tgapi.mjs');
const { createPublisher } = await import('../src/publish.mjs');

const TOKEN = '123456789:' + 'A'.repeat(35);
const CFTOKEN = 'cf' + 'x'.repeat(38);
let n = 0;

// 가짜 Cloudflare + 텔레그램 서버. 호출을 기록하고, 올라온 Worker 의 multipart 를 풀어 둔다.
async function fakes(t, { subdomain = 'acme', authOk = true } = {}) {
  const st = { calls: [], uploads: [], kv: [], webhook: null, deleted: [], accounts: [{ id: 'acc1', name: '내 계정' }] };
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const path = req.url.split('?')[0];
      st.calls.push(`${req.method} ${path}`);
      const out = (result, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: 10000, message: 'Authentication error' }], result })); };
      if (path.startsWith('/bot')) {   // 텔레그램
        const method = path.split('/').pop();
        const b = body.length ? JSON.parse(body) : {};
        if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 7, username: 'lapis_pub_bot', first_name: 'Pub' } }));
        if (method === 'setWebhook') { st.webhook = b; return res.end(JSON.stringify({ ok: true, result: true })); }
        if (method === 'deleteWebhook') { st.webhook = null; return res.end(JSON.stringify({ ok: true, result: true })); }
        return res.end(JSON.stringify({ ok: true, result: {} }));
      }
      if (!authOk || req.headers.authorization !== `Bearer ${CFTOKEN}`) return out(null, 403);
      if (path === '/accounts') return out(st.accounts);
      if (path === '/accounts/acc1/workers/subdomain') {
        if (req.method === 'GET') return subdomain ? out({ subdomain }) : out(null, 404);
        subdomain = JSON.parse(body).subdomain; return out({ subdomain });
      }
      if (path === '/accounts/acc1/ai/models/search') return out([{ name: '@cf/meta/test-instruct' }]);
      if (path === '/accounts/acc1/storage/kv/namespaces') {
        if (req.method === 'GET') return out(st.kv);
        const ns = { id: 'ns-' + ++n, title: JSON.parse(body).title }; st.kv.push(ns); return out(ns);
      }
      if (path.startsWith('/accounts/acc1/storage/kv/namespaces/') && req.method === 'DELETE') { st.deleted.push(path); return out({}); }
      if (/\/workers\/scripts\/[^/]+$/.test(path) && req.method === 'PUT') {
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const meta = JSON.parse(await form.get('metadata').text());
        st.uploads.push({ name: path.split('/').pop(), meta, parts: [...form.keys()], worker: await form.get('worker.mjs').text() });
        return out({ id: 'x' });
      }
      if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(path)) return out({ enabled: JSON.parse(body).enabled });
      if (/\/workers\/scripts\/[^/]+$/.test(path) && req.method === 'DELETE') { st.deleted.push(path); return out({}); }
      if (path === '/alive/api/info') return res.end(JSON.stringify({ app: 'lapis-bot' }));
      out(null, 404);
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { s.closeAllConnections(); s.close(r); }));
  st.base = 'http://127.0.0.1:' + s.address().port;
  return st;
}

async function setup(t, opts) {
  const f = await fakes(t, opts);
  const secrets = createSecrets({ file: join(root, `pub-${n++}.bin`), crypto: plain });
  const tg = createTgApi({ base: f.base });
  const bots = createBots({ dir: join(root, `pubbots-${n++}`), secrets, tg });
  const bot = bots.create({ name: '배포 봇', engine: { type: 'ollama', model: 'local-m' }, presets: ['planner'] });
  bots.updateAgent(bot.id, 'planner', { engine: { type: 'claude', model: '' }, instructions: '개조식으로' });
  await secrets.set('cloudflare', CFTOKEN);
  await secrets.set('openai', 'sk-' + 'o'.repeat(30));
  // 웹 주소 확인(/api/info)은 가짜 서버로 보내기 위해 fetch 를 바꿔 낀다
  const realFetch = fetch;
  const fetchImpl = (url, init) => realFetch(String(url).startsWith('https://') && /workers\.dev/.test(url) ? f.base + '/alive/api/info' : url, init);
  const stopped = [];
  const pub = createPublisher({ bots, secrets, tg, fetchImpl, cfBase: f.base, stopLocal: async (id) => { stopped.push(id); }, wait: async () => {} });
  return { f, secrets, bots, bot, pub, stopped, tg };
}
const ctx = () => ({ lines: [], log(l) { this.lines.push(l); }, step(s) { this.lines.push('▶ ' + s); }, progress() {} });

test('배포 계획: 토큰·계정·주소 이름·쓸 수 있는 클라우드 엔진을 알려 준다', async (t) => {
  const { pub, bot } = await setup(t);
  const p = await pub.plan(bot.id);
  assert.equal(p.tokenSet, true);
  assert.equal(p.account.name, '내 계정');
  assert.equal(p.subdomain, 'acme');
  assert.deepEqual(p.engines.map((e) => [e.type, e.ready]), [['openai', true], ['anthropic', false], ['workersai', true]]);
  assert.deepEqual(p.workersAiModels, ['@cf/meta/test-instruct']);
  assert.match(p.note, /로컬에서만 도는 엔진/);
  assert.equal(p.issues.length, 0);
});

test('토큰이 없거나 거절되면 해야 할 일을 알려 준다', async (t) => {
  const a = await setup(t);
  await a.secrets.remove('cloudflare');
  assert.equal((await a.pub.plan(a.bot.id)).issues[0].code, 'no-token');
  const b = await setup(t, { authOk: false });
  const p = await b.pub.plan(b.bot.id);
  assert.equal(p.issues[0].code, 'token');
  assert.match(p.issues[0].text, /토큰이 거절/);
});

test('배포: KV 를 만들고, 비밀은 secret 바인딩으로만 올리고, 텔레그램 웹훅을 걸고, 로컬 수신을 멈춘다', async (t) => {
  const { f, pub, bot, bots, stopped, secrets } = await setup(t);
  await bots.saveToken(bot.id, TOKEN);
  bots.update(bot.id, { autoStart: true });
  bots.requestPairing(bot.id, { senderId: 5001, chatId: 5001 });
  bots.pair(bot.id, Object.keys(bots.load(bot.id).telegram.pending)[0]);
  const c = ctx();
  const r = await pub.deploy(bot.id, { engine: { type: 'openai', model: 'gpt-test' }, password: 'pass-1234-ok' }, c);
  assert.equal(r.url, `https://lapis-${bot.id}.acme.workers.dev`);
  assert.equal(r.telegram, true);
  assert.deepEqual(stopped, [bot.id]);
  const up = f.uploads[0];
  assert.deepEqual(up.parts.sort(), ['agentlogic.mjs', 'metadata', 'worker.mjs']);
  assert.equal(up.meta.main_module, 'worker.mjs');
  const by = Object.fromEntries(up.meta.bindings.map((b) => [b.name, b]));
  assert.equal(by.KV.type, 'kv_namespace');
  assert.equal(by.ACCESS_PASSWORD.type, 'secret_text');
  assert.equal(by.OPENAI_API_KEY.type, 'secret_text');
  assert.equal(by.TELEGRAM_BOT_TOKEN.type, 'secret_text');
  assert.equal(by.WEBHOOK_SECRET.type, 'secret_text');
  // 설정 JSON 에는 비밀이 없고, 로컬 전용 엔진은 클라우드 엔진으로 바뀌었다
  const cfg = JSON.parse(by.BOT_CONFIG.text);
  assert.equal(by.BOT_CONFIG.text.includes(TOKEN) || by.BOT_CONFIG.text.includes('pass-1234-ok') || by.BOT_CONFIG.text.includes('sk-'), false);
  assert.deepEqual(cfg.engine, { type: 'openai', model: 'gpt-test' });
  assert.equal(cfg.agents[0].engine, null);
  assert.equal(cfg.agents[0].instructions, '개조식으로');
  assert.deepEqual(cfg.telegram.allowFrom, ['5001']);
  assert.ok(f.calls.includes(`POST /accounts/acc1/workers/scripts/lapis-${bot.id}/subdomain`));
  assert.match(f.webhook.url, new RegExp(`^https://lapis-${bot.id}\\.acme\\.workers\\.dev/telegram/[0-9a-f]{32}$`));
  assert.equal(f.webhook.secret_token, by.WEBHOOK_SECRET.text);
  assert.deepEqual(f.webhook.allowed_updates, ['message']);
  assert.equal(bots.load(bot.id).autoStart, false);
  assert.equal(await pub.revealPassword(bot.id), 'pass-1234-ok');
  assert.equal(pub.status(bot.id).url, r.url);
  // 다시 배포하면 KV·웹훅 경로를 재사용하고 비밀번호는 그대로 쓴다
  await pub.deploy(bot.id, { engine: { type: 'openai', model: 'gpt-test2' } }, ctx());
  assert.equal(f.kv.length, 1);
  assert.equal(f.uploads[1].meta.bindings.find((b) => b.name === 'WEBHOOK_PATH').text, by.WEBHOOK_PATH.text);
});

test('Cloudflare 무료 AI: AI 바인딩을 붙이고 API 키는 올리지 않는다', async (t) => {
  const { f, pub, bot, secrets } = await setup(t);
  await secrets.remove('openai');
  await pub.deploy(bot.id, { engine: { type: 'workersai', model: '@cf/meta/test-instruct' }, password: 'longenough1' }, ctx());
  const names = f.uploads[0].meta.bindings.map((b) => b.name);
  assert.ok(names.includes('AI'));
  assert.equal(names.includes('OPENAI_API_KEY'), false);
  assert.equal(names.includes('TELEGRAM_BOT_TOKEN'), false);   // 텔레그램 토큰이 없으면 웹 채팅만
  assert.equal(f.webhook, null);
});

test('배포 입력 검사: 이름·비밀번호·엔진·주소 이름·키가 없으면 올리기 전에 거절한다', async (t) => {
  const { f, pub, bot, secrets } = await setup(t, { subdomain: '' });
  const eng = { type: 'openai', model: 'm' };
  await assert.rejects(pub.deploy(bot.id, { engine: eng, password: 'longenough1', name: 'Bad Name!' }, ctx()), /영문 소문자/);
  await assert.rejects(pub.deploy(bot.id, { engine: eng, password: 'short' }, ctx()), /8자 이상/);
  await assert.rejects(pub.deploy(bot.id, { engine: { type: 'ollama', model: 'm' }, password: 'longenough1' }, ctx()), /엔진을 골라/);
  await assert.rejects(pub.deploy(bot.id, { engine: eng, password: 'longenough1' }, ctx()), /주소 이름/);   // 계정에 workers.dev 이름이 없다
  await secrets.remove('openai');
  await assert.rejects(pub.deploy(bot.id, { engine: eng, password: 'longenough1', subdomain: 'newname' }, ctx()), /연결되어 있지 않아요/);
  assert.equal(f.uploads.length, 0);
  // 주소 이름이 없는 계정은 정해 주면 만들어 준다
  await secrets.set('openai', 'sk-' + 'o'.repeat(30));
  const r = await pub.deploy(bot.id, { engine: eng, password: 'longenough1', subdomain: 'newname' }, ctx());
  assert.match(r.url, /\.newname\.workers\.dev$/);
});

test('텔레그램을 PC 로 되돌리고, 배포를 지우면 Worker·KV·웹훅·비밀번호를 정리한다', async (t) => {
  const { f, pub, bot, bots, secrets } = await setup(t);
  await bots.saveToken(bot.id, TOKEN);
  await pub.deploy(bot.id, { engine: { type: 'openai', model: 'm' }, password: 'longenough1' }, ctx());
  assert.ok(f.webhook);
  await pub.restoreLocal(bot.id);
  assert.equal(f.webhook, null);
  assert.equal(pub.status(bot.id).telegram, false);
  await pub.remove(bot.id);
  assert.ok(f.deleted.some((p) => p.endsWith(`/workers/scripts/lapis-${bot.id}`)));
  assert.ok(f.deleted.some((p) => p.includes('/storage/kv/namespaces/')));
  assert.equal(await secrets.has('deploy-pw:' + bot.id), false);
  assert.equal(pub.status(bot.id), null);
  await assert.rejects(pub.remove(bot.id), (e) => e.status === 404);
});

// ── 올라가는 Worker 코드 자체의 동작: 같은 코드를 Node 에서 불러 가짜 환경으로 실행한다 ──
test('Worker: 비밀번호 확인, 웹 채팅, 기억, 텔레그램 웹훅(허용·역할·주제·명령)', async (t) => {
  const mod = await import('../src/worker-bot.mjs');
  const worker = mod.default;
  const kv = new Map();
  const sent = [];
  const llmCalls = [];
  const cfg = {
    name: '웹 봇', honorific: '대표님', persona: '친절한 비서', timeZone: 'Asia/Seoul', engine: { type: 'openai', model: 'gpt-x' }, defaultAgent: '',
    agents: [{ key: 'planner', name: '기획팀', emoji: '📋', role: '기획', instructions: '개조식', engine: null, skillText: '### 스킬: 문체\n□ ○ -' }, { key: 'dev', name: '개발팀', emoji: '💻', role: '개발', instructions: '', engine: { type: 'anthropic', model: 'claude-x' }, skillText: '' }],
    telegram: { username: 'web_bot', allowFrom: ['5001'], rooms: { '-100200': { mode: 'mention', connected: true, agent: 'dev', instructions: '방 지침', topics: { 9: { name: '기획', agent: 'planner', instructions: '주제 지침' } } } } },
  };
  const env = {
    BOT_CONFIG: JSON.stringify(cfg), ACCESS_PASSWORD: 'pw-12345678', OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'ak-test',
    TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 'whsecret', WEBHOOK_PATH: 'abc123',
    KV: { get: async (k, type) => { const v = kv.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.openai.com')) { llmCalls.push({ type: 'openai', body: JSON.parse(init.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: '<think>흠</think>GPT 답' } }] })); }
    if (u.includes('api.anthropic.com')) { llmCalls.push({ type: 'anthropic', body: JSON.parse(init.body) }); return new Response(JSON.stringify({ content: [{ type: 'text', text: '클로드 답' }] })); }
    if (u.includes('api.telegram.org')) { const method = u.split('/').pop(); if (method === 'sendMessage') sent.push(JSON.parse(init.body)); return new Response('{"ok":true,"result":{}}'); }
    throw new Error('예상 밖 호출 ' + u);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const tasks = [];
  const ctxW = { waitUntil: (p) => tasks.push(p) };
  const req = (path, init) => worker.fetch(new Request('https://w.test' + path, init), env, ctxW);
  const chat = (body, pw = 'pw-12345678') => req('/api/chat', { method: 'POST', headers: { authorization: 'Bearer ' + pw, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // 화면과 정보
  const page = await req('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /기획팀/);
  assert.equal((await (await req('/api/info')).json()).app, 'lapis-bot');
  // 비밀번호
  assert.equal((await chat({ message: 'hi' }, 'nope')).status, 401);
  assert.equal((await chat({ ping: true })).status, 200);
  assert.equal((await chat({ message: '' })).status, 400);
  // 웹 채팅: 기억, 생각 과정 숨김, 역할 지정
  const a = await (await chat({ session: 's1', message: '안녕', agent: 'planner' })).json();
  assert.equal(a.text, 'GPT 답');
  assert.match(llmCalls[0].body.messages[0].content, /대표님/);
  assert.match(llmCalls[0].body.messages[0].content, /□ ○ -/);
  await chat({ session: 's1', message: '더 짧게', agent: 'planner' });
  assert.deepEqual(llmCalls[1].body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  await chat({ session: 's2', message: '개발팀 버그 찾아줘' });   // 이름으로 부르면 그 역할의 엔진(Anthropic)
  assert.equal(llmCalls[2].type, 'anthropic');
  // 웹훅 확인
  const hook = (update, secret = 'whsecret', path = '/telegram/abc123') => req(path, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }, body: JSON.stringify(update) });
  assert.equal((await hook({}, 'wrong')).status, 403);
  assert.equal((await hook({}, 'whsecret', '/telegram/other')).status, 404);
  const msg = (over) => ({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 5001, type: 'private' }, from: { id: 5001 }, text: '안녕', ...over } });
  // 낯선 사람은 번호만 안내받는다
  await hook(msg({ chat: { id: 9, type: 'private' }, from: { id: 9 } }));
  await Promise.all(tasks.splice(0));
  assert.match(sent.at(-1).text, /번호를 알려 주세요: 9/);
  const before = llmCalls.length;
  // 허용된 사람의 DM
  await hook(msg({ text: '오늘 일정 알려줘' }));
  await Promise.all(tasks.splice(0));
  assert.equal(sent.at(-1).text, 'GPT 답');
  assert.equal(llmCalls.length, before + 1);
  // 그룹: 멘션 없으면 무시, 주제에는 그 주제 담당(기획팀)과 지침
  const grp = { id: -100200, type: 'supergroup' };
  await hook(msg({ chat: grp, text: '잡담', message_thread_id: 9, is_topic_message: true }));
  await Promise.all(tasks.splice(0));
  assert.equal(llmCalls.length, before + 1);
  await hook(msg({ chat: grp, text: '@web_bot 계획 세워줘', message_thread_id: 9, is_topic_message: true }));
  await Promise.all(tasks.splice(0));
  const last = llmCalls.at(-1);
  assert.equal(last.type, 'openai');
  assert.match(last.body.messages[0].content, /기획팀/);
  assert.match(last.body.messages[0].content, /주제 지침/);
  assert.equal(sent.at(-1).message_thread_id, 9);
  // 명령: /agent 로 바꾸면 기억해 두었다가 다음 대화에 쓴다
  await hook(msg({ text: '/agent dev' }));
  await Promise.all(tasks.splice(0));
  assert.match(sent.at(-1).text, /개발팀 역할/);
  await hook(msg({ text: '코드 봐줘' }));
  await Promise.all(tasks.splice(0));
  assert.equal(llmCalls.at(-1).type, 'anthropic');
  await hook(msg({ text: '/reset' }));
  await Promise.all(tasks.splice(0));
  assert.match(sent.at(-1).text, /기억을 지웠어요/);
  assert.equal(kv.has('h:tg:5001:0'), false);
});
