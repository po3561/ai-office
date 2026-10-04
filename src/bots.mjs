// LAPIS 봇 저장소: 봇 하나 = <데이터>\bots\<id>\bot.json 한 폴더.
// 봇은 엔진(어떤 AI), 에이전트(부서), 텔레그램 방·주제 설정을 가진다. Claude Office 사무실·Hermes 와 달리 이 프로그램이 직접 돌리는 "LAPIS 런타임" 봇이다.
// 텔레그램 토큰은 폴더가 아니라 DPAPI 비밀 저장소에 둔다.
import { join } from 'node:path';
import { mkdirSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { BOTS_DIR, CLOSED_DIR } from './paths.mjs';
import { readJson, writeJson, isDir, need, slug, nowIso, stamp, HttpError } from './util.mjs';
import { ENGINE_TYPES, ACCESS } from './engines.mjs';
import { PRESETS, presetByKey } from './presets.mjs';
import { TOKEN_RE, maskToken } from './tgapi.mjs';

const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const oneLine = (s, max) => clean(s, max).replace(/\s*[\r\n]+\s*/g, ' ');
const ID_RE = /^-?\d{1,20}$/;
export const DEFAULT_PERSONA = '너는 사용자의 개인 비서다. 한국어로 간결하고 정확하게 답한다. 모르는 것은 모른다고 말하고, 외부 발송·결제·삭제처럼 되돌리기 어려운 일은 먼저 확인을 받는다.';

function checkEngine(e, { optional = false } = {}) {
  if (optional && !e) return null;
  need(e && ENGINE_TYPES[e.type], '엔진 종류를 골라 주세요.');
  const model = clean(e.model, 80);
  need(!/[\s"'`;|&<>]/.test(model), '모델 이름에 공백이나 특수문자를 쓸 수 없습니다.');
  return { type: e.type, model };
}

export function createBots({ dir = BOTS_DIR, secrets, tg, nowMs = () => Date.now() } = {}) {
  const botDir = (id) => join(dir, id);
  const file = (id) => join(botDir(id), 'bot.json');
  const tokenName = (id) => `tg:${id}`;
  const save = (b) => { b.updatedAt = nowIso(); writeJson(file(b.id), b); return b; };

  function load(id) {
    need(/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(id)), '봇을 찾을 수 없습니다.', 404);
    const b = readJson(file(id), null);
    need(b, '봇을 찾을 수 없습니다.', 404);
    b.telegram ||= {};
    b.telegram.allowFrom ||= []; b.telegram.pending ||= {}; b.telegram.rooms ||= {};
    b.telegram.policy ||= 'pairing';
    b.agents ||= [];
    return b;
  }

  const list = () => {
    if (!isDir(dir)) return [];
    return readdirSync(dir).filter((n) => existsSync(file(n))).map((n) => { try { return load(n); } catch { return null; } }).filter(Boolean);
  };

  async function summary(b) {
    return {
      id: b.id, name: b.name, kind: 'lapis', engine: b.engine, access: b.access, autoStart: Boolean(b.autoStart),
      agents: b.agents.length, rooms: Object.keys(b.telegram.rooms).length, allowed: b.telegram.allowFrom.length,
      telegram: { set: await secrets.has(tokenName(b.id)), username: b.telegram.username || '' }, createdAt: b.createdAt, folder: botDir(b.id),
    };
  }

  function uniqueId(name) {
    const root = slug(name) || 'bot';
    let id = root, n = 2;
    while (existsSync(botDir(id)) || isDir(join(CLOSED_DIR, id))) id = `${root}-${n++}`;
    return id;
  }

  function agentFrom(src, existing = []) {
    const preset = src.preset ? presetByKey(src.preset) : null;
    need(!src.preset || preset, '추천 부서를 찾을 수 없습니다.');
    const name = oneLine(src.name ?? preset?.name, 30);
    need(name, '에이전트 이름을 적어 주세요.');
    let key = String(src.key || preset?.key || slug(name) || '').toLowerCase();
    if (!key || !KEY_RE.test(key)) key = `agent-${existing.length + 1}`;
    let k = key, n = 2;
    while (existing.some((a) => a.key === k)) k = `${key}-${n++}`;
    return {
      key: k, name, emoji: clean(src.emoji ?? preset?.emoji ?? '🏷️', 4) || '🏷️',
      role: oneLine(src.role ?? preset?.role, 160), instructions: clean(src.instructions ?? preset?.instructions ?? '', 4000),
      engine: checkEngine(src.engine, { optional: true }), access: src.access ? (need(ACCESS.includes(src.access), '권한은 chat, read, write 중 하나입니다.'), src.access) : '',
      skills: Array.isArray(src.skills) ? [...new Set(src.skills.map(String).filter((s) => /^[A-Za-z0-9._-]{1,64}$/.test(s)))] : [],
    };
  }

  return {
    list, load,
    skillsDir: (id) => join(botDir(id), 'skills'),
    folder: botDir,
    async listSummaries() { return Promise.all(list().map(summary)); },
    async detail(id) {
      const b = load(id);
      return { ...b, ...(await summary(b)), telegram: { ...b.telegram, set: await secrets.has(tokenName(id)), pending: pendingView(b, nowMs()) } };
    },

    create({ name, engine, persona, honorific, presets, access } = {}) {
      name = oneLine(name, 40);
      need(name, '봇 이름을 1~40자로 적어 주세요.');
      const eng = checkEngine(engine);
      const id = uniqueId(name);
      const b = {
        version: 1, id, name, kind: 'lapis', createdAt: nowIso(), engine: eng, access: ACCESS.includes(access) ? access : 'chat',
        persona: clean(persona || DEFAULT_PERSONA, 4000), honorific: oneLine(honorific || '사용자님', 20) || '사용자님', autoStart: false,
        agents: [], defaultAgent: '', telegram: { allowFrom: [], pending: {}, rooms: {}, policy: 'pairing', username: '' },
      };
      for (const key of Array.isArray(presets) ? presets : []) b.agents.push(agentFrom({ preset: key }, b.agents));
      mkdirSync(join(botDir(id), 'skills'), { recursive: true });
      save(b);
      return b;
    },

    update(id, patch = {}) {
      const b = load(id);
      if ('name' in patch) { const n = oneLine(patch.name, 40); need(n, '이름을 적어 주세요.'); b.name = n; }
      if ('persona' in patch) b.persona = clean(patch.persona, 4000);
      if ('honorific' in patch) { const h = oneLine(patch.honorific, 20); need(h && !/[<>&"]/.test(h), '호칭은 1~20자로 적어 주세요.'); b.honorific = h; }
      if ('engine' in patch) b.engine = checkEngine(patch.engine);
      if ('access' in patch) { need(ACCESS.includes(patch.access), '권한은 chat, read, write 중 하나입니다.'); b.access = patch.access; }
      if ('autoStart' in patch) b.autoStart = Boolean(patch.autoStart);
      if ('defaultAgent' in patch) { need(!patch.defaultAgent || b.agents.some((a) => a.key === patch.defaultAgent), '없는 에이전트입니다.'); b.defaultAgent = patch.defaultAgent || ''; }
      return save(b);
    },

    // 폐쇄: 폴더는 지우지 않고 보관 위치로 옮긴다. 토큰은 비밀 저장소에서 지운다(다시 쓰려면 새로 붙여 넣는다).
    async close(id, confirmName) {
      const b = load(id);
      need(String(confirmName || '').trim() === b.name, '확인을 위해 봇 이름을 똑같이 입력해 주세요.');
      mkdirSync(CLOSED_DIR, { recursive: true });
      renameSync(botDir(id), join(CLOSED_DIR, `${id}_${stamp()}`));
      await secrets.remove(tokenName(id));
      return { id, name: b.name };
    },

    // ── 에이전트 ──
    addAgent(id, src = {}) {
      const b = load(id);
      need(b.agents.length < 40, '에이전트는 최대 40개까지 만들 수 있습니다.');
      const a = agentFrom(src, b.agents);
      b.agents.push(a);
      if (!b.defaultAgent) b.defaultAgent = a.key;
      save(b);
      return a;
    },
    updateAgent(id, key, patch = {}) {
      const b = load(id);
      const a = b.agents.find((x) => x.key === key);
      need(a, '에이전트를 찾을 수 없습니다.', 404);
      if ('name' in patch) { const n = oneLine(patch.name, 30); need(n, '이름을 적어 주세요.'); a.name = n; }
      if ('emoji' in patch) a.emoji = clean(patch.emoji, 4) || a.emoji;
      if ('role' in patch) a.role = oneLine(patch.role, 160);
      if ('instructions' in patch) a.instructions = clean(patch.instructions, 4000);
      if ('engine' in patch) a.engine = checkEngine(patch.engine, { optional: true });
      if ('access' in patch) { need(!patch.access || ACCESS.includes(patch.access), '권한은 chat, read, write 중 하나입니다.'); a.access = patch.access || ''; }
      if ('skills' in patch) a.skills = [...new Set((patch.skills || []).map(String).filter((s) => /^[A-Za-z0-9._-]{1,64}$/.test(s)))];
      save(b);
      return a;
    },
    removeAgent(id, key) {
      const b = load(id);
      const i = b.agents.findIndex((x) => x.key === key);
      need(i >= 0, '에이전트를 찾을 수 없습니다.', 404);
      const [gone] = b.agents.splice(i, 1);
      if (b.defaultAgent === key) b.defaultAgent = b.agents[0]?.key || '';
      for (const r of Object.values(b.telegram.rooms)) { if (r.agent === key) r.agent = ''; for (const t of Object.values(r.topics || {})) if (t.agent === key) t.agent = ''; }
      save(b);
      return gone;
    },

    // ── 텔레그램 ──
    async saveToken(id, token) {
      const b = load(id);
      token = String(token || '').trim();
      need(TOKEN_RE.test(token), '봇 토큰 형식이 올바르지 않습니다. BotFather가 알려 준 123456789:AAH… 형태 전체를 붙여 넣어 주세요.');
      const me = await tg.getMe(token).catch((e) => { throw new HttpError(400, `토큰을 확인하지 못했습니다: ${e.message}`); });
      await secrets.set(tokenName(id), token);
      b.telegram.username = me.username || ''; b.telegram.botId = me.id; b.telegram.botName = me.first_name || '';
      save(b);
      return { username: me.username, name: me.first_name, masked: maskToken(token) };
    },
    async clearToken(id) { const b = load(id); await secrets.remove(tokenName(id)); b.telegram.username = ''; delete b.telegram.botId; save(b); },
    token: (id) => secrets.get(tokenName(id)),

    // 접근 허용(페어링): 모르는 사람이 DM 을 보내면 코드를 만들어 알려 주고, 사용자가 앱에서 코드를 입력해야 허용된다.
    isAllowed(id, senderId) { return load(id).telegram.allowFrom.includes(String(senderId)); },
    requestPairing(id, { senderId, name = '', chatId }) {
      const b = load(id);
      const now = nowMs();
      for (const [c, p] of Object.entries(b.telegram.pending)) if (p.expiresAt < now) delete b.telegram.pending[c];
      const existing = Object.entries(b.telegram.pending).find(([, p]) => p.senderId === String(senderId));
      if (existing) { save(b); return existing[0]; }
      need(Object.keys(b.telegram.pending).length < 20, '대기 중인 요청이 너무 많습니다.', 429);
      const code = String(randomInt(100000, 1000000));
      b.telegram.pending[code] = { senderId: String(senderId), name: oneLine(name, 40), chatId: String(chatId), createdAt: now, expiresAt: now + 60 * 60 * 1000 };
      save(b);
      return code;
    },
    pair(id, code) {
      const b = load(id);
      code = String(code || '').trim();
      need(/^\d{6}$/.test(code), '페어링 코드는 봇이 알려 준 6자리 숫자입니다.');
      const p = b.telegram.pending[code];
      need(p && p.expiresAt > nowMs(), '없거나 만료된 코드입니다. 봇에게 메시지를 다시 보내 새 코드를 받아 주세요.', 404);
      if (!b.telegram.allowFrom.includes(p.senderId)) b.telegram.allowFrom.push(p.senderId);
      delete b.telegram.pending[code];
      save(b);
      return { senderId: p.senderId, chatId: p.chatId, name: p.name };
    },
    deny(id, code) { const b = load(id); delete b.telegram.pending[String(code || '')]; save(b); },
    removeSender(id, senderId) { const b = load(id); b.telegram.allowFrom = b.telegram.allowFrom.filter((x) => x !== String(senderId)); save(b); },
    setPolicy(id, mode) { need(['pairing', 'allowlist'].includes(mode), '허용 방식은 pairing 또는 allowlist 입니다.'); const b = load(id); b.telegram.policy = mode; save(b); },

    // ── 방·주제 ──
    touchRoom(id, { chatId, title = '', type = 'group' }) {
      const b = load(id);
      const key = String(chatId);
      need(ID_RE.test(key), '방 번호가 올바르지 않습니다.');
      const r = (b.telegram.rooms[key] ||= { title: '', type, mode: 'mention', connected: true, agent: '', instructions: '', topics: {}, seenAt: '' });
      const t = oneLine(title, 80);
      if ((t && r.title !== t) || !r.seenAt || nowMs() - Date.parse(r.seenAt) > 3600_000) { if (t) r.title = t; r.seenAt = new Date(nowMs()).toISOString(); save(b); }
      return r;
    },
    setRoom(id, chatId, patch = {}) {
      const b = load(id);
      const r = b.telegram.rooms[String(chatId)];
      need(r, '방을 찾을 수 없습니다. 봇에게 그 방에서 먼저 메시지를 보내 주세요.', 404);
      if ('mode' in patch) { need(['mention', 'all'].includes(patch.mode), '응답 방식은 mention 또는 all 입니다.'); r.mode = patch.mode; }
      if ('connected' in patch) r.connected = Boolean(patch.connected);
      if ('agent' in patch) { need(!patch.agent || b.agents.some((a) => a.key === patch.agent), '없는 에이전트입니다.'); r.agent = patch.agent || ''; }
      if ('instructions' in patch) r.instructions = clean(patch.instructions, 2000);
      save(b);
      return r;
    },
    setTopic(id, chatId, threadId, patch = {}) {
      const b = load(id);
      const r = b.telegram.rooms[String(chatId)];
      need(r, '방을 찾을 수 없습니다.', 404);
      need(/^\d{1,12}$/.test(String(threadId)), '주제 번호가 올바르지 않습니다.');
      const t = (r.topics[String(threadId)] ||= { name: '', agent: '', instructions: '' });
      if ('name' in patch) t.name = oneLine(patch.name, 60);
      if ('agent' in patch) { need(!patch.agent || b.agents.some((a) => a.key === patch.agent), '없는 에이전트입니다.'); t.agent = patch.agent || ''; }
      if ('instructions' in patch) t.instructions = clean(patch.instructions, 2000);
      save(b);
      return t;
    },
    forgetRoom(id, chatId) { const b = load(id); delete b.telegram.rooms[String(chatId)]; save(b); },
  };
}

function pendingView(b, now) {
  return Object.entries(b.telegram.pending).filter(([, p]) => p.expiresAt > now)
    .map(([code, p]) => ({ code, senderId: p.senderId, name: p.name, ageSec: Math.round((now - p.createdAt) / 1000) }));
}

export const AGENT_PRESETS = PRESETS.map(({ key, name, emoji, role, group, description }) => ({ key, name, emoji, role, group, description }));
