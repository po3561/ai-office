// 예전 AI-Office 사무실의 텔레그램 방·주제 / 정기 보고 설정을 그대로 읽고 쓴다.
// 예전 사무실의 텔레그램 플러그인은 이 파일들을 직접 읽는다(형식이 이 프로그램의 새 방식과 다르다).
//   chats.json     플러그인이 기록: 봇이 본 방과 주제
//   rooms.json     방 별칭, 주제별 담당 팀(team), 호출어(trigger), 올리기 전 승인(confirmPosts), 마지막 확인 결과(live)
//   access.json    groups = 연결된 업무방(requireMention 등)
//   routines.json  정기 보고(아침·저녁) 받을 곳과 시각,  routines-state.json  마지막 발송 기록
// 형식이 다르면 아무것도 건드리지 않도록 isLegacy() 로 먼저 구분한다. 담당 팀 이름은 사무실의 부서 목록에서 가져온다.
import { join } from 'node:path';
import { mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { readJson, writeJson, isFile, need, nowIso } from './util.mjs';

const CHAT_RE = /^-?\d{1,20}$/;
export const DEFAULT_TRIGGER = '카오';
export const ROUTINES = { morning: '아침 업무보고', evening: '저녁 업무결산' };
const DEFAULT_TIMES = { morning: '08:00', evening: '22:00' };

const f = (dir) => ({
  access: join(dir, 'access.json'), chats: join(dir, 'chats.json'), rooms: join(dir, 'rooms.json'),
  routines: join(dir, 'routines.json'), routineState: join(dir, 'routines-state.json'), env: join(dir, '.env'), lock: join(dir, 'rooms.lock'),
});
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 예전 형식인가: rooms.json 이 방 ID 를 바로 키로 쓰거나(rooms 래퍼 없음), 플러그인이 chats.json·routines.json 을 만들어 둔 경우.
export function isLegacy(dir) {
  if (!dir) return false;
  const F = f(dir);
  const r = readJson(F.rooms, null);
  const obj = r && typeof r === 'object' && !Array.isArray(r);
  if (obj && Object.keys(r).some((k) => CHAT_RE.test(k))) return true;                              // 방 ID 가 바로 키
  if (obj && r.rooms && typeof r.rooms === 'object' && Object.keys(r.rooms).length) return false;   // 새 형식(방이 들어 있음)
  return isFile(F.chats) || isFile(F.routines);
}

// 새 방식 코드가 예전 파일에 끼워 넣은 빈 "rooms": {} 는 예전 쪽에서 가짜 방 "rooms" 로 보이므로 지운다(원본은 .bak-ai-office 로 남긴다).
export function repairLegacy(dir) {
  if (!isLegacy(dir)) return false;
  const F = f(dir);
  return withLock(dir, () => {
    let changed = false;
    const rooms = readObj(F.rooms);
    if ('rooms' in rooms && !(rooms.rooms && Object.keys(rooms.rooms).length)) {
      writeJson(F.rooms + '.bak-ai-office', rooms);
      delete rooms.rooms;
      writeJson(F.rooms, rooms);
      changed = true;
    }
    // 가짜 방 "rooms" 를 업무방으로 연결해 버린 찌꺼기(방 ID 가 아닌 groups 키)
    const access = readObj(F.access);
    const bad = Object.keys(access.groups || {}).filter((k) => !CHAT_RE.test(k));
    if (bad.length) {
      writeJson(F.access + '.bak-ai-office', access, 0o600);
      for (const k of bad) delete access.groups[k];
      writeJson(F.access, access, 0o600);
      changed = true;
    }
    return changed;
  });
}

// rooms.json·access.json 을 고칠 때 플러그인·예전 현황판과 동시에 쓰지 않도록 같은 잠금 폴더를 쓴다.
function withLock(dir, fn) {
  const lock = f(dir).lock;
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 10000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* 이미 풀림 */ }
      need(i <= 100, '방 설정 파일이 잠겨 있습니다. 잠시 후 다시 시도하세요.', 409);
      sleep(50);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

const readObj = (file) => { const v = readJson(file, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };

// 담당 팀: teams = [{ key, name }] (사무실 부서). 키·이름·일부 이름 모두 받는다. 없음/해제 → null.
export function teamKey(teams, q) {
  if (q == null || q === '') return null;
  const s = String(q).trim();
  if (['없음', 'none', '-', '해제'].includes(s)) return null;
  const hit = teams.find((t) => t.key === s);
  if (hit) return hit.key;
  const norm = (x) => String(x).replace(/[\s·팀]/g, '');
  const byName = teams.find((t) => norm(t.name) === norm(s)) || teams.find((t) => norm(t.name).includes(norm(s)) || norm(s).includes(norm(t.name)));
  need(byName, `팀을 찾을 수 없습니다: ${s}`);
  return byName.key;
}

export function listRooms(dir, teams = []) {
  const F = f(dir);
  const access = { allowFrom: [], groups: {}, ...readObj(F.access) };
  const chats = readObj(F.chats), rooms = readObj(F.rooms);
  const names = Object.fromEntries(teams.map((t) => [t.key, t.name]));
  const ids = new Set([...Object.keys(chats), ...Object.keys(access.groups || {}), ...Object.keys(rooms)].filter((k) => CHAT_RE.test(k)));   // 방 ID 가 아닌 키("rooms" 같은 찌꺼기)는 방이 아니다
  const out = [];
  for (const id of ids) {
    const c = chats[id] || {};
    if (c.migrated_to) continue;
    const r = rooms[id] || {};
    const live = r.live || {};
    const policy = (access.groups || {})[id];
    const status = live.bot_status || c.bot_status || 'member';
    if (['left', 'kicked'].includes(status) && !policy) continue;
    const topicIds = new Set([...Object.keys(c.topics || {}), ...Object.keys(r.topics || {})]);
    const topics = [...topicIds].map((tid) => {
      const seen = (c.topics || {})[tid] || {};
      const cfg = (r.topics || {})[tid] || {};
      return {
        id: tid, name: seen.name || cfg.name || `주제 #${tid}`,
        team: cfg.team || null, teamName: cfg.team ? names[cfg.team] || cfg.team : null,
        trigger: typeof cfg.trigger === 'string' ? cfg.trigger : null,
        lastSeen: seen.last_seen || cfg.created_at || null,
      };
    }).sort((a, b) => Number(a.id) - Number(b.id));
    out.push({
      id, title: live.title || c.title || r.alias || id, alias: r.alias || '',
      type: live.type || c.type || 'group', isForum: Boolean(live.is_forum ?? c.is_forum),
      botStatus: status, isAdmin: status === 'administrator', canManageTopics: Boolean(live.can_manage_topics ?? c.can_manage_topics),
      memberCount: live.member_count ?? null, linked: Boolean(policy),
      requireMention: policy ? Boolean(policy.requireMention) : null,
      confirmPosts: Boolean(r.confirmPosts),
      trigger: typeof r.trigger === 'string' ? r.trigger : DEFAULT_TRIGGER,
      lastSeen: c.last_seen || null, checkedAt: live.at || null, error: live.error || null, topics,
    });
  }
  return out.sort((a, b) => (b.linked - a.linked) || String(a.title).localeCompare(String(b.title), 'ko'));
}

export function findRoom(dir, teams, q) {
  const s = String(q ?? '').trim();
  need(s, '방을 지정하세요.');
  const list = listRooms(dir, teams);
  const exact = list.find((r) => r.id === s || r.title === s || r.alias === s);
  if (exact) return exact;
  const hits = list.filter((r) => r.title.includes(s) || (r.alias && r.alias.includes(s)));
  need(hits.length, `방을 찾을 수 없습니다: ${s}. 봇이 그 방에 있는지 확인하세요.`, 404);
  need(hits.length === 1, `"${s}"에 해당하는 방이 여러 개입니다.`);
  return hits[0];
}

function findTopic(room, q) {
  const s = String(q ?? '').trim();
  const t = room.topics.find((x) => x.id === s || x.name === s)
    || (room.topics.filter((x) => x.name.includes(s)).length === 1 ? room.topics.find((x) => x.name.includes(s)) : null);
  need(t, `"${room.title}"에서 주제를 찾을 수 없습니다: ${s}`, 404);
  return t;
}

function updateRoom(dir, id, fn) {
  return withLock(dir, () => {
    const rooms = readObj(f(dir).rooms);
    rooms[id] = fn({ topics: {}, ...(rooms[id] || {}) });
    writeJson(f(dir).rooms, rooms);
    return rooms[id];
  });
}

// ── 텔레그램에 직접 묻기(토큰은 이 PC 안에서만 쓰고 응답·오류에 싣지 않는다) ──
function token(dir) {
  let text = '';
  try { text = readFileSync(f(dir).env, 'utf8'); } catch { /* 없으면 아래에서 안내 */ }
  const hit = /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(text);
  need(hit, '봇 토큰이 없습니다. 「연결」 화면에서 먼저 연결해 주세요.', 409);
  return hit[1].trim();
}

function translate(desc) {
  const d = String(desc);
  if (/not enough rights|CHAT_ADMIN_REQUIRED|not an administrator/i.test(d)) return '봇에게 권한이 없습니다. 방에서 봇을 관리자로 지정하고 "주제 관리" 권한을 켜 주세요.';
  if (/chat is not a forum|TOPICS_DISABLED|FORUM_DISABLED/i.test(d)) return '이 방은 주제(토픽) 기능이 꺼져 있습니다. 방 설정에서 "주제"를 켜 주세요.';
  if (/chat not found/i.test(d)) return '방을 찾을 수 없습니다. 봇이 방에서 나갔거나 방 ID가 바뀌었습니다.';
  if (/kicked|bot is not a member/i.test(d)) return '봇이 이 방에서 내보내졌습니다.';
  if (/thread not found|TOPIC_ID_INVALID/i.test(d)) return '주제를 찾을 수 없습니다. 삭제되었을 수 있습니다.';
  return d;
}

async function api(dir, method, params, fetcher = fetch) {
  const t = token(dir);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetcher(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: ac.signal });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(translate(j.description || `HTTP ${res.status}`));
    return j.result;
  } catch (e) {
    throw new Error(String(e.message || e).split(t).join('<token>'));
  } finally { clearTimeout(timer); }
}

export async function refreshRooms(dir, teams, fetcher) {
  const botId = Number(token(dir).split(':')[0]);
  for (const r of listRooms(dir, teams)) {
    const live = { at: nowIso() };
    try {
      const chat = await api(dir, 'getChat', { chat_id: r.id }, fetcher);
      Object.assign(live, { title: chat.title, type: chat.type, is_forum: Boolean(chat.is_forum) });
      const me = await api(dir, 'getChatMember', { chat_id: r.id, user_id: botId }, fetcher);
      Object.assign(live, { bot_status: me.status, can_manage_topics: Boolean(me.can_manage_topics) });
      live.member_count = await api(dir, 'getChatMemberCount', { chat_id: r.id }, fetcher).catch(() => null);
    } catch (e) { live.error = e.message; }
    updateRoom(dir, r.id, (x) => ({ ...x, live }));
  }
  return listRooms(dir, teams);
}

export async function createTopic(dir, teams, roomQ, name, teamQ, fetcher) {
  const room = findRoom(dir, teams, roomQ);
  const title = String(name ?? '').trim();
  need(title, '주제 이름을 적어 주세요.');
  need(title.length <= 128, '주제 이름은 128자 이내여야 합니다.');
  need(room.linked, `"${room.title}"은(는) 아직 업무방으로 연결되지 않았습니다. 먼저 연결해 주세요.`);
  const team = teamKey(teams, teamQ);
  const t = await api(dir, 'createForumTopic', { chat_id: room.id, name: title }, fetcher);
  const tid = String(t.message_thread_id);
  updateRoom(dir, room.id, (x) => ({ ...x, topics: { ...x.topics, [tid]: { name: t.name, team, created_at: nowIso() } } }));
  return { room: room.title, chatId: room.id, threadId: tid, name: t.name, team, teamName: team ? (teams.find((x) => x.key === team) || {}).name || team : null };
}

export function assignTopic(dir, teams, roomQ, topicQ, teamQ) {
  const room = findRoom(dir, teams, roomQ);
  const topic = findTopic(room, topicQ);
  const team = teamKey(teams, teamQ);
  updateRoom(dir, room.id, (x) => ({ ...x, topics: { ...x.topics, [topic.id]: { ...(x.topics[topic.id] || {}), name: topic.name, team } } }));
  return { room: room.title, name: topic.name, team, teamName: team ? (teams.find((x) => x.key === team) || {}).name || team : null };
}

// 방 연결·해제는 허용된 계정(페어링)이 있어야 한다. 연결하면 허용된 계정만 방에서 봇을 부를 수 있다.
export function setLinked(dir, teams, roomQ, linked) {
  const room = findRoom(dir, teams, roomQ);
  return withLock(dir, () => {
    const a = readJson(f(dir).access, null);
    need(a && typeof a === 'object', '텔레그램 연결 설정(access.json)을 읽을 수 없습니다.', 409);
    a.groups = a.groups || {};
    if (linked) {
      need((a.allowFrom || []).length > 0, '먼저 내 텔레그램 계정을 허용(페어링)해 주세요.', 409);
      a.groups[room.id] = { requireMention: false, allowFrom: [...a.allowFrom] };
    } else delete a.groups[room.id];
    writeJson(f(dir).access, a, 0o600);
    return { id: room.id, linked };
  });
}

export function setRoomOptions(dir, teams, roomQ, opts = {}) {
  const room = findRoom(dir, teams, roomQ);
  if ('requireMention' in opts) {
    withLock(dir, () => {
      const a = readJson(f(dir).access, null);
      need(a && a.groups && a.groups[room.id], '먼저 방을 연결하세요.', 409);
      a.groups[room.id].requireMention = Boolean(opts.requireMention);
      writeJson(f(dir).access, a, 0o600);
    });
  }
  updateRoom(dir, room.id, (x) => ({
    ...x,
    ...('confirmPosts' in opts ? { confirmPosts: Boolean(opts.confirmPosts) } : {}),
    ...('trigger' in opts ? { trigger: String(opts.trigger ?? '').trim().slice(0, 10) } : {}),
    ...('alias' in opts ? { alias: String(opts.alias || '').slice(0, 40) } : {}),
  }));
  return listRooms(dir, teams).find((r) => r.id === room.id);
}

// 방 전체(topicQ 없음) 또는 주제별 호출어. '없음' = 호출어 없이 모두 받음, '기본' = 주제 설정을 지우고 방 설정을 따름.
export function setTrigger(dir, teams, roomQ, topicQ, value) {
  const room = findRoom(dir, teams, roomQ);
  const v = String(value ?? '').trim();
  const reset = ['기본', 'default'].includes(v);
  const trig = ['없음', 'none', '-', '해제', ''].includes(v) ? '' : v.slice(0, 10);
  const topic = topicQ ? findTopic(room, topicQ) : null;
  updateRoom(dir, room.id, (x) => {
    if (!topic) return reset ? (({ trigger, ...rest }) => rest)(x) : { ...x, trigger: trig };
    const t = { ...(x.topics[topic.id] || {}), name: topic.name };
    if (reset) delete t.trigger; else t.trigger = trig;
    return { ...x, topics: { ...x.topics, [topic.id]: t } };
  });
  return { room: room.title, topic: topic ? topic.name : null, trigger: reset ? '(기본값)' : trig };
}

// ── 정기 보고(아침 업무보고·저녁 결산) ──
// 텔레그램 플러그인이 정한 시각에 비서실장에게 "⏰ 정기 루틴" 메시지를 넣고, 비서실장이 보고를 작성해 이 방·주제에 올린다.
export function getRoutine(dir) {
  const F = f(dir);
  const cfg = readObj(F.routines), st = readObj(F.routineState);
  const out = { chatId: cfg.chat_id || null, threadId: cfg.thread_id || null, room: cfg.room || null, topic: cfg.topic || null };
  for (const id of Object.keys(ROUTINES)) {
    out[id] = { time: (cfg[id] && cfg[id].time) || DEFAULT_TIMES[id], enabled: cfg[id] ? cfg[id].enabled !== false : false, lastRun: (st.lastRun && st.lastRun[id]) || null, lastAt: st[`${id}At`] || null };
  }
  return out;
}

const saveRoutine = (dir, fn) => withLock(dir, () => { writeJson(f(dir).routines, fn(readObj(f(dir).routines))); });

// 보고 받을 곳: roomQ 가 '개인'이면 허용된 첫 계정과의 개인 대화, 아니면 연결된 업무방(주제는 선택).
export function setRoutineTarget(dir, teams, roomQ, topicQ) {
  let target;
  if (['개인', '개인대화', 'dm', 'DM'].includes(String(roomQ ?? '').trim())) {
    const owner = (readObj(f(dir).access).allowFrom || [])[0];
    need(owner, '페어링된 계정이 없습니다. 먼저 내 텔레그램 계정을 허용해 주세요.', 409);
    target = { chat_id: String(owner), thread_id: null, room: '개인 대화', topic: null };
  } else {
    const room = findRoom(dir, teams, roomQ);
    need(room.linked, `"${room.title}"은(는) 업무방으로 연결되지 않아 보고를 올릴 수 없습니다.`);
    const topic = topicQ ? findTopic(room, topicQ) : null;
    target = { chat_id: room.id, thread_id: topic ? topic.id : null, room: room.title, topic: topic ? topic.name : null };
  }
  saveRoutine(dir, (cfg) => {
    const next = { ...cfg, ...target };
    for (const id of Object.keys(ROUTINES)) if (!next[id]) next[id] = { time: DEFAULT_TIMES[id], enabled: true };   // 처음 정하면 기본 시각으로 켠다
    return next;
  });
  return getRoutine(dir);
}

export function setRoutineTime(dir, id, time, enabled) {
  need(ROUTINES[id], '아침(morning)·저녁(evening) 중 하나를 골라 주세요.');
  let t = null;
  if (time != null && time !== '') {
    const m = String(time).trim().match(/^(\d{1,2}):?(\d{2})$/);
    need(m && Number(m[1]) <= 23 && Number(m[2]) <= 59, '시각은 08:00 처럼 적어 주세요.');
    t = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  saveRoutine(dir, (cfg) => ({ ...cfg, [id]: { time: t || (cfg[id] && cfg[id].time) || DEFAULT_TIMES[id], enabled: enabled ?? (cfg[id] ? cfg[id].enabled !== false : true) } }));
  return getRoutine(dir);
}

export function testRoutine(dir, id) {
  need(ROUTINES[id], '아침(morning)·저녁(evening) 중 하나를 골라 주세요.');
  need(readObj(f(dir).routines).chat_id, '먼저 보고 받을 곳을 정해 주세요.');
  saveRoutine(dir, (cfg) => ({ ...cfg, test: { id, at: nowIso() } }));
  return getRoutine(dir);
}

// 화면용 한 번에 묶음
export function legacyView(dir, teams) {
  return { rooms: listRooms(dir, teams), routine: getRoutine(dir), teams };
}
