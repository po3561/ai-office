// LAPIS 런타임: 텔레그램 메시지를 받아(롱폴링) 방·주제·에이전트 설정대로 엔진을 불러 답장한다.
// 허용된 사람만 쓸 수 있다: 모르는 사람의 DM 에는 페어링 코드만 알려 주고(앱에서 입력해야 허용), 그룹에서는 조용히 무시한다.
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readText, readJson, writeJson, isDir, HttpError } from './util.mjs';
import { scanSkills, parseFrontmatter } from './skills.mjs';
import { stripThinking, chunk, buildSystem as buildSystemCore, pickAgent } from './agentlogic.mjs';

export { stripThinking, chunk, pickAgent };
// 로컬 런타임용: 역할에 붙은 스킬 파일을 읽어 넣는다.
export const buildSystem = (bot, { skillsDir, ...rest }) => buildSystemCore(bot, { ...rest, skillText: loadSkillText(skillsDir, rest.agent?.skills || []) });

const HISTORY_MAX = 20;
const STALE_SEC = 600;      // 10분 넘게 묵은 메시지는 재시작 직후 쏟아져 나오지 않도록 무시한다
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

// 스킬 본문(머리말 뒤)을 읽어 지침으로 붙인다. 너무 길면 자른다.
export function loadSkillText(skillsDir, ids) {
  if (!ids?.length || !isDir(skillsDir)) return '';
  const known = new Map(scanSkills(skillsDir).map((s) => [s.id, s]));
  const parts = [];
  for (const id of ids) {
    const s = known.get(id);
    if (!s) continue;
    // 분류 폴더 안에 있을 수도 있어 직접 찾는다
    const candidates = [join(skillsDir, id, 'SKILL.md'), ...(s.category ? [join(skillsDir, s.category, id, 'SKILL.md')] : [])];
    const f = candidates.find((c) => existsSync(c));
    if (!f) continue;
    const text = readText(f);
    const body = text.slice(parseFrontmatter(text).bodyStart).trim().slice(0, 6000);
    parts.push(`### 스킬: ${s.name}\n${s.description ? s.description + '\n' : ''}${body}`);
  }
  return parts.join('\n\n');
}

export function createRuntime({ bots, engines, tg, log = () => {}, nowMs = () => Date.now(), pollTimeout = 25 }) {
  const state = new Map();   // botId → {running, error, since, handled, username, abort}
  const chains = new Map();  // botId:chat:thread → Promise (같은 대화는 순서대로 처리)

  const histFile = (id, chat, thread) => join(bots.folder(id), 'history', `${chat}_${thread || 0}.json`);
  const readHist = (id, chat, thread) => readJson(histFile(id, chat, thread), []);
  const writeHist = (id, chat, thread, h) => { mkdirSync(join(bots.folder(id), 'history'), { recursive: true }); writeJson(histFile(id, chat, thread), h.slice(-HISTORY_MAX)); };

  async function reply(token, msg, text, thread) {
    for (const part of chunk(text)) {
      await tg.sendMessage(token, {
        chat_id: msg.chat.id, text: part, ...(thread ? { message_thread_id: thread } : {}),
        ...(msg.chat.type !== 'private' ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}),
      });
    }
  }

  const HELP = '쓰는 법\n- 그냥 말을 걸면 답해요.\n- /agents 역할 목록, /agent 키 역할 바꾸기\n- /reset 이 대화 기억 지우기\n- /whoami 이 방·주제 번호 보기';

  async function handleMessage(botId, token, me, msg) {
    if (!msg || msg.from?.is_bot || !msg.chat) return;
    if (nowMs() / 1000 - (msg.date || 0) > STALE_SEC) return;
    const bot = bots.load(botId);
    const priv = msg.chat.type === 'private';
    const senderId = String(msg.from?.id ?? '');
    const thread = msg.is_topic_message ? msg.message_thread_id : (msg.chat.is_forum ? msg.message_thread_id : 0) || 0;
    const allowed = bots.isAllowed(botId, senderId);

    if (!allowed) {
      if (priv && bot.telegram.policy === 'pairing') {
        const code = bots.requestPairing(botId, { senderId, name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' '), chatId: msg.chat.id });
        await reply(token, msg, `안녕하세요! 이 봇을 쓰려면 LAPIS 앱의 「봇 스튜디오 → 텔레그램」에서 아래 코드를 입력해 주세요.\n\n코드: ${code}\n(1시간 동안 유효합니다)`, 0);
      }
      return;
    }

    let text = String(msg.text ?? msg.caption ?? '');
    let room = null;
    if (!priv) {
      room = bots.touchRoom(botId, { chatId: msg.chat.id, title: msg.chat.title, type: msg.chat.type });
      if (!room.connected) return;
      const mentioned = text.toLowerCase().includes(`@${me.username}`.toLowerCase());
      const toBot = msg.reply_to_message?.from?.id === me.id;
      const command = /^\/\w+(@\w+)?(\s|$)/.test(text);
      if (!(room.mode === 'all' || mentioned || toBot || command)) return;
      text = text.replace(new RegExp(`@${me.username}`, 'ig'), '').trim();
    }
    if (!text) { if (priv) await reply(token, msg, '지금은 글로 보낸 메시지만 읽을 수 있어요.', thread); return; }

    const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    if (cmd) {
      const [, name, arg = ''] = cmd;
      switch (name.toLowerCase()) {
        case 'start': return reply(token, msg, `안녕하세요, ${bot.honorific}! ${bot.name}입니다.\n\n${HELP}`, thread);
        case 'help': return reply(token, msg, HELP, thread);
        case 'whoami': return reply(token, msg, `방 번호: ${msg.chat.id}\n주제 번호: ${thread || '(없음)'}\n보낸 사람 번호: ${senderId}`, thread);
        case 'reset': writeHist(botId, msg.chat.id, thread, []); return reply(token, msg, '이 대화의 기억을 지웠어요.', thread);
        case 'agents': return reply(token, msg, bot.agents.length ? bot.agents.map((a) => `${a.emoji} ${a.name} — /agent ${a.key}${a.role ? `\n   ${a.role}` : ''}`).join('\n') : '아직 역할이 없어요. 앱의 「봇 스튜디오」에서 추가할 수 있어요.', thread);
        case 'agent': {
          const want = arg.trim();
          const a = bot.agents.find((x) => x.key === want.toLowerCase() || x.name === want);
          if (!a) return reply(token, msg, '그런 역할이 없어요. /agents 로 목록을 확인해 주세요.', thread);
          if (!priv && thread) bots.setTopic(botId, msg.chat.id, thread, { agent: a.key });
          else if (!priv) bots.setRoom(botId, msg.chat.id, { agent: a.key });
          else bots.update(botId, { defaultAgent: a.key });
          return reply(token, msg, `이제 ${a.emoji} ${a.name} 역할로 답해요.`, thread);
        }
        default: break;   // 모르는 명령은 일반 메시지처럼 처리
      }
    }

    const topic = thread && room ? room.topics?.[String(thread)] : null;
    const picked = pickAgent(bot, { room, topic, text });
    const engine = picked.agent?.engine?.type ? picked.agent.engine : bot.engine;
    const access = picked.agent?.access || bot.access;
    const system = buildSystem(bot, { agent: picked.agent, room, topic, skillsDir: bots.skillsDir(botId), now: new Date(nowMs()) });
    const history = readHist(botId, msg.chat.id, thread);
    const messages = [...history, { role: 'user', content: picked.text }];
    tg.sendChatAction(token, { chat_id: msg.chat.id, action: 'typing', ...(thread ? { message_thread_id: thread } : {}) });
    const typing = setInterval(() => tg.sendChatAction(token, { chat_id: msg.chat.id, action: 'typing', ...(thread ? { message_thread_id: thread } : {}) }), 4500);
    let answer;
    try {
      answer = stripThinking(await engines.complete({ engine, system, messages, cwd: join(bots.folder(botId), 'work'), access }));
      if (!answer) throw new Error('빈 답');
    } catch (e) {
      log(`[lapis:${botId}] 엔진 오류: ${e.message}`);
      clearInterval(typing);
      await reply(token, msg, `⚠️ 답을 만들지 못했어요: ${String(e.message).slice(0, 300)}`, thread);
      return;
    }
    clearInterval(typing);
    writeHist(botId, msg.chat.id, thread, [...messages, { role: 'assistant', content: answer }]);
    await reply(token, msg, answer, thread);
  }

  const queued = (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn).catch((e) => log(`[lapis] 처리 오류: ${e.message}`)).finally(() => { if (chains.get(key) === next) chains.delete(key); });
    chains.set(key, next);
    return next;
  };

  const offsetFile = (id) => join(bots.folder(id), 'offset.json');

  async function loop(botId, st) {
    let backoff = 3000;
    const token = await bots.token(botId);
    let me;
    // 읽어 온 위치(offset)는 처리가 끝난 메시지까지만 파일에 남긴다: 처리 중에 꺼져도 다음에 그 메시지를 다시 받는다.
    let offset = readJson(offsetFile(botId), { offset: 0 }).offset;
    const inflight = new Set();
    const persist = (seen) => writeJson(offsetFile(botId), { offset: inflight.size ? Math.min(...inflight) : seen });
    while (!st.abort.signal.aborted) {
      try {
        me ||= await tg.getMe(token);
        st.username = me.username; st.error = '';
        const updates = await tg.getUpdates(token, { offset, timeout: pollTimeout, allowed_updates: ['message'] }, { signal: st.abort.signal });
        backoff = 3000;
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          st.handled++;
          const m = u.message;
          if (m) {
            inflight.add(u.update_id);
            queued(`${botId}:${m.chat?.id}:${m.message_thread_id || 0}`, () => handleMessage(botId, token, me, m)).finally(() => { inflight.delete(u.update_id); persist(offset); });
          }
        }
        if (updates.length) persist(offset);
      } catch (e) {
        if (st.abort.signal.aborted) break;
        st.error = e.status === 409 ? '다른 곳에서 이 봇의 메시지를 받고 있어요. (같은 봇 토큰은 한 곳에서만 쓸 수 있어요. Claude Office·Hermes 등 다른 프로그램을 꺼 주세요.)' : e.message;
        if (e.tgCode === 401) { st.error = '봇 토큰이 거절되었어요. 토큰을 다시 연결해 주세요.'; break; }
        log(`[lapis:${botId}] ${st.error}`);
        await sleep(backoff, st.abort.signal);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    st.running = false;
  }

  async function start(botId) {
    const cur = state.get(botId);
    if (cur?.running) return view(botId);
    const bot = bots.load(botId);
    const token = await bots.token(botId);
    if (!token) throw new HttpError(409, '텔레그램 봇 토큰이 아직 없습니다. 먼저 연결해 주세요.');
    const st = { running: true, error: '', since: new Date(nowMs()).toISOString(), handled: 0, username: bot.telegram.username || '', abort: new AbortController() };
    state.set(botId, st);
    st.done = loop(botId, st);
    return view(botId);
  }
  async function stop(botId) {
    const st = state.get(botId);
    if (st?.running) { st.abort.abort(); await Promise.race([st.done, sleep(3000)]); st.running = false; }
    return view(botId);
  }
  function view(botId) {
    const st = state.get(botId);
    return st ? { running: st.running, error: st.error, since: st.since, handled: st.handled, username: st.username } : { running: false, error: '', since: '', handled: 0, username: '' };
  }
  async function startAll() {
    for (const b of bots.list()) if (b.autoStart) { try { await start(b.id); } catch (e) { log(`[lapis:${b.id}] 자동 시작 실패: ${e.message}`); } }
  }
  async function stopAll() { await Promise.all([...state.keys()].map(stop)); }

  return { start, stop, view, startAll, stopAll, handleMessage, idle: () => Promise.all([...chains.values()]) };
}
