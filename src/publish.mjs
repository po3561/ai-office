// 웹 배포: LAPIS 봇 하나를 사용자의 Cloudflare 계정에 Worker 로 올려 `*.workers.dev` 웹 주소로 쓰게 한다.
// Cloudflare REST API 로 직접 올린다(wrangler·npm 불필요): 계정 확인 → KV(대화 기록) → Worker 업로드 → workers.dev 켜기 → 텔레그램 웹훅.
// Worker 는 PC 파일과 Claude Code·Codex 구독을 쓸 수 없으므로 API 키 엔진(OpenAI·Anthropic) 또는 Workers AI(무료 한도) 로만 돈다.
// 비밀 값(비밀번호·API 키·봇 토큰)은 secret 바인딩으로만 올리고, 설정 JSON 에는 넣지 않는다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, need, readJson, writeJson, nowIso } from './util.mjs';
import { loadSkillText } from './runtime.mjs';

const HERE = new URL('.', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, HERE), 'utf8');
export const COMPAT_DATE = '2025-09-01';
export const CLOUD_ENGINES = {
  openai: { label: 'GPT (OpenAI API 키)', secret: 'openai' },
  anthropic: { label: 'Claude (Anthropic API 키)', secret: 'anthropic' },
  workersai: { label: 'Cloudflare 무료 AI (API 키 불필요)', secret: null },
};
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,50}$/;
const CF_FRIENDLY = [
  [/authentication|invalid api token|9109|10000/i, 'Cloudflare 토큰이 거절되었어요. 토큰이 맞는지, 「Workers 편집」 권한이 있는지 확인해 주세요.'],
  [/kv.*(?:permission|auth)|storage.*(?:permission|auth)/i, '토큰에 「Workers KV 저장소 편집」 권한이 없어요.'],
];

export function createPublisher({ bots, secrets, tg, fetchImpl = fetch, cfBase = 'https://api.cloudflare.com/client/v4', stopLocal = async () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const recordFile = (id) => join(bots.folder(id), 'deploy.json');
  const record = (id) => readJson(recordFile(id), null);

  async function cf(token, method, path, { json, form, ok404 = false } = {}) {
    let res;
    try {
      res = await fetchImpl(cfBase + path, {
        method, headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: json !== undefined ? JSON.stringify(json) : form, signal: AbortSignal.timeout(60000),
      });
    } catch { throw new HttpError(503, 'Cloudflare 에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
    const j = await res.json().catch(() => ({}));
    if (res.status === 404 && ok404) return null;
    if (!res.ok || j.success === false) {
      const msg = (j.errors || []).map((e) => e.message).join(' / ') || `응답 ${res.status}`;
      const friendly = CF_FRIENDLY.find(([re]) => re.test(msg + ' ' + (j.errors || []).map((e) => e.code).join(' ')))?.[1];
      throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, friendly || `Cloudflare 오류: ${msg}`);
    }
    return j.result;
  }

  async function account(token, wanted) {
    const list = await cf(token, 'GET', '/accounts?per_page=50');
    need(Array.isArray(list) && list.length, '이 토큰으로 볼 수 있는 Cloudflare 계정이 없어요.', 400);
    const a = (wanted && list.find((x) => x.id === wanted)) || list[0];
    return { id: a.id, name: a.name, count: list.length };
  }

  const subdomainOf = async (token, acct) => (await cf(token, 'GET', `/accounts/${acct}/workers/subdomain`, { ok404: true }))?.subdomain || '';

  async function plan(botId) {
    const bot = bots.load(botId);
    const token = await secrets.get('cloudflare');
    const out = { bot: { id: bot.id, name: bot.name }, tokenSet: Boolean(token), issues: [], engines: [], telegram: Boolean(await bots.token(botId)), record: record(botId), account: null, subdomain: '', suggestedName: `lapis-${bot.id}`.slice(0, 50), hasPassword: await secrets.has('deploy-pw:' + botId) };
    for (const [type, e] of Object.entries(CLOUD_ENGINES)) {
      const ready = !e.secret || (await secrets.has(e.secret));
      out.engines.push({ type, label: e.label, ready, needs: ready ? '' : (e.secret === 'openai' ? 'key:openai' : 'key:anthropic') });
    }
    if (!token) { out.issues.push({ code: 'no-token', text: 'Cloudflare API 토큰이 아직 없어요. 연결 허브에서 먼저 연결해 주세요.' }); return out; }
    try {
      out.account = await account(token);
      out.subdomain = await subdomainOf(token, out.account.id);
      try { out.workersAiModels = ((await cf(token, 'GET', `/accounts/${out.account.id}/ai/models/search?task=Text%20Generation&per_page=40`)) || []).map((m) => m.name).filter(Boolean); } catch { out.workersAiModels = []; }
      if (!out.subdomain) out.issues.push({ code: 'no-subdomain', text: '이 Cloudflare 계정에는 아직 workers.dev 주소 이름이 없어요. 아래에서 정하면 만들어 드려요.' });
    } catch (e) { out.issues.push({ code: 'token', text: e.message }); }
    const unsupported = [bot.engine, ...bot.agents.map((a) => a.engine).filter((e) => e?.type)].filter((e) => !CLOUD_ENGINES[e.type]);
    if (unsupported.length) out.note = '로컬에서만 도는 엔진(로컬 AI·Claude 로그인·ChatGPT 로그인·Hermes)을 쓰는 부분은 웹에서는 아래에서 고른 클라우드 엔진으로 바뀌어요. PC의 파일은 웹에서 쓸 수 없어요.';
    return out;
  }

  // 로컬 설정을 Worker 설정(JSON)으로. 비밀은 넣지 않는다. 클라우드에서 못 도는 엔진은 고른 클라우드 엔진으로 바꾼다.
  function buildConfig(bot, engine) {
    const remote = (e) => (e?.type && CLOUD_ENGINES[e.type] ? { type: e.type, model: e.model } : null);
    const skillsDir = bots.skillsDir(bot.id);
    return {
      name: bot.name, honorific: bot.honorific, persona: bot.persona, timeZone: 'Asia/Seoul', engine,
      defaultAgent: bot.defaultAgent,
      agents: bot.agents.map((a) => ({ key: a.key, name: a.name, emoji: a.emoji, role: a.role, instructions: a.instructions, engine: remote(a.engine) || null, skillText: loadSkillText(skillsDir, a.skills || []) })),
      telegram: { username: bot.telegram.username || '', allowFrom: bot.telegram.allowFrom, rooms: Object.fromEntries(Object.entries(bot.telegram.rooms).map(([id, r]) => [id, { title: r.title, mode: r.mode, connected: r.connected, agent: r.agent, instructions: r.instructions, topics: r.topics }])) },
    };
  }

  async function deploy(botId, opts = {}, ctx = { log() {}, step() {}, progress() {} }) {
    const bot = bots.load(botId);
    const token = await secrets.get('cloudflare');
    need(token, 'Cloudflare API 토큰을 먼저 연결해 주세요.', 409);
    const name = String(opts.name || `lapis-${bot.id}`).toLowerCase();
    need(NAME_RE.test(name), '웹 주소 이름은 영문 소문자·숫자·하이픈으로 2~51자예요.');
    const engine = { type: opts.engine?.type, model: String(opts.engine?.model || '').trim() };
    need(CLOUD_ENGINES[engine.type], '웹에서 쓸 엔진을 골라 주세요.');
    need(engine.model, '모델 이름을 적어 주세요.');
    const apiKeys = {};
    for (const t of new Set([engine.type, ...bot.agents.map((a) => a.engine?.type).filter(Boolean)])) {
      const s = CLOUD_ENGINES[t]?.secret;
      if (s) { const v = await secrets.get(s); if (t === engine.type) need(v, `${CLOUD_ENGINES[t].label} 가 연결되어 있지 않아요.`, 409); if (v) apiKeys[s] = v; }
    }
    // 에이전트가 자기 엔진을 쓰는데 키가 없으면 고른 클라우드 엔진으로 되돌린다
    const cfg = buildConfig(bot, { type: engine.type, model: engine.model });
    for (const a of cfg.agents) if (a.engine && CLOUD_ENGINES[a.engine.type].secret && !apiKeys[CLOUD_ENGINES[a.engine.type].secret]) a.engine = null;
    let password = String(opts.password || '');
    if (!password) password = await secrets.get('deploy-pw:' + botId);
    need(password.length >= 8, '웹 접속 비밀번호를 8자 이상으로 정해 주세요.');

    ctx.step('Cloudflare 계정 확인');
    const acct = await account(token, opts.accountId);
    ctx.log(`계정: ${acct.name}`);
    let sub = await subdomainOf(token, acct.id);
    if (!sub) {
      need(opts.subdomain && /^[a-z0-9][a-z0-9-]{1,40}$/.test(opts.subdomain), 'workers.dev 주소 이름(영문 소문자·숫자·하이픈)을 정해 주세요.');
      await cf(token, 'PUT', `/accounts/${acct.id}/workers/subdomain`, { json: { subdomain: opts.subdomain } });
      sub = opts.subdomain; ctx.log(`workers.dev 주소 이름을 만들었어요: ${sub}`);
    }

    ctx.step('대화 기록 저장소(KV) 준비');
    const title = `lapis-${name}`;
    const prev = record(botId);
    let nsId = prev?.namespaceId || '';
    if (!nsId) {
      const all = await cf(token, 'GET', `/accounts/${acct.id}/storage/kv/namespaces?per_page=100`);
      nsId = (all || []).find((n) => n.title === title)?.id || (await cf(token, 'POST', `/accounts/${acct.id}/storage/kv/namespaces`, { json: { title } })).id;
    }

    ctx.step('Worker 올리기');
    const webhookPath = prev?.webhookPath || randomBytes(16).toString('hex');
    const webhookSecret = prev?.webhookSecret || randomBytes(24).toString('hex');
    const token_tg = await bots.token(botId);
    const bindings = [
      { type: 'kv_namespace', name: 'KV', namespace_id: nsId },
      { type: 'plain_text', name: 'BOT_CONFIG', text: JSON.stringify(cfg) },
      { type: 'secret_text', name: 'ACCESS_PASSWORD', text: password },
    ];
    if (engine.type === 'workersai') bindings.push({ type: 'ai', name: 'AI' });
    if (apiKeys.openai) bindings.push({ type: 'secret_text', name: 'OPENAI_API_KEY', text: apiKeys.openai });
    if (apiKeys.anthropic) bindings.push({ type: 'secret_text', name: 'ANTHROPIC_API_KEY', text: apiKeys.anthropic });
    if (token_tg && opts.telegram !== false) bindings.push({ type: 'secret_text', name: 'TELEGRAM_BOT_TOKEN', text: token_tg }, { type: 'secret_text', name: 'WEBHOOK_SECRET', text: webhookSecret }, { type: 'plain_text', name: 'WEBHOOK_PATH', text: webhookPath });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.mjs', compatibility_date: COMPAT_DATE, bindings, tags: ['lapis'] })], { type: 'application/json' }), 'metadata.json');
    form.append('worker.mjs', new Blob([read('./worker-bot.mjs')], { type: 'application/javascript+module' }), 'worker.mjs');
    form.append('agentlogic.mjs', new Blob([read('./agentlogic.mjs')], { type: 'application/javascript+module' }), 'agentlogic.mjs');
    await cf(token, 'PUT', `/accounts/${acct.id}/workers/scripts/${name}`, { form });
    await cf(token, 'POST', `/accounts/${acct.id}/workers/scripts/${name}/subdomain`, { json: { enabled: true, previews_enabled: false } });
    const url = `https://${name}.${sub}.workers.dev`;

    let telegram = false;
    if (token_tg && opts.telegram !== false) {
      ctx.step('텔레그램을 웹으로 연결');
      await tg.call(token_tg, 'setWebhook', { url: `${url}/telegram/${webhookPath}`, secret_token: webhookSecret, allowed_updates: ['message'], drop_pending_updates: false });
      await stopLocal(botId);   // 같은 봇 토큰은 한 곳에서만 받을 수 있다. 웹훅이 성공한 뒤에만 PC 쪽 수신을 멈춘다(실패하면 PC 봇이 그대로 일한다)
      telegram = true;
      bots.update(botId, { autoStart: false });   // 이제 웹이 텔레그램을 받으므로 PC 에서는 자동으로 켜지 않는다
    }

    ctx.step('웹 주소 확인');
    let alive = false;
    for (let i = 0; i < 12 && !alive; i++) {
      try { const r = await fetchImpl(url + '/api/info', { signal: AbortSignal.timeout(8000) }); alive = r.ok && (await r.json()).app === 'lapis-bot'; } catch { /* 올라가는 데 몇 초 걸린다 */ }
      if (!alive) await wait(2500);
    }
    if (!alive) ctx.log('아직 주소가 열리지 않았어요. 1~2분 뒤 다시 열어 보세요.');
    await secrets.set('deploy-pw:' + botId, password);
    writeJson(recordFile(botId), { name, url, accountId: acct.id, namespaceId: nsId, subdomain: sub, engine, telegram, webhookPath, webhookSecret, deployedAt: nowIso(), alive });
    return { url, alive, telegram };
  }

  // 텔레그램 수신을 PC 로 되돌린다(웹 배포는 그대로 둔다).
  async function restoreLocal(botId) {
    const t = await bots.token(botId);
    need(t, '텔레그램 봇이 연결되어 있지 않아요.', 409);
    await tg.call(t, 'deleteWebhook', { drop_pending_updates: false });
    const r = record(botId);
    if (r) writeJson(recordFile(botId), { ...r, telegram: false });
    return { ok: true };
  }

  async function remove(botId) {
    const r = record(botId);
    need(r, '배포한 기록이 없어요.', 404);
    const token = await secrets.get('cloudflare');
    need(token, 'Cloudflare API 토큰이 필요해요.', 409);
    const t = await bots.token(botId);
    if (r.telegram && t) await tg.call(t, 'deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    await cf(token, 'DELETE', `/accounts/${r.accountId}/workers/scripts/${r.name}`, { ok404: true });
    if (r.namespaceId) await cf(token, 'DELETE', `/accounts/${r.accountId}/storage/kv/namespaces/${r.namespaceId}`, { ok404: true });
    await secrets.remove('deploy-pw:' + botId);
    const { rmSync } = await import('node:fs');
    rmSync(recordFile(botId), { force: true });
    return { ok: true };
  }

  return { plan, deploy, remove, restoreLocal, status: (id) => { const r = record(id); return r ? { name: r.name, url: r.url, engine: r.engine, telegram: r.telegram, deployedAt: r.deployedAt, alive: r.alive } : null; }, revealPassword: (id) => secrets.get('deploy-pw:' + id), buildConfig };
}
