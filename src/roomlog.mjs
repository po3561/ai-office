// 방·주제의 최근 대화: 텔레그램 Bot API 는 지난 대화를 돌려주지 않으므로, 이 PC에 이미 남아 있는 기록에서 읽는다(읽기만 한다).
//  - LAPIS 봇: 봇 폴더의 history/<방>_<주제>.json (대화 기억. 최근 20개)
//  - Claude 사무실: 사무실의 Claude 대화 기록(~/.claude/projects/<폴더>/*.jsonl) 안의 텔레그램 수신 메시지와 reply 도구 호출
// 대화 기록 파일은 수십 MB 까지 커지므로 파일별로 읽은 위치를 기억해 두고, 새로 붙은 부분만 읽는다.
import { join } from 'node:path';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { CLAUDE_HOME } from './paths.mjs';
import { readJson } from './util.mjs';

const KEEP = 80;          // 방·주제마다 메모리에 들고 있는 최근 대화 수
const MAX_TEXT = 1200;    // 한 메시지에서 보여 줄 글자 수
const MAX_CHUNK = 64 * 1024 * 1024;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

// 텔레그램 HTML(<b>, <blockquote> …)을 보기 좋은 글로.
export function plain(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|blockquote|pre|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]).replace(/\n{3,}/g, '\n\n').trim();
}

// 사무실이 수신 메시지 뒤에 덧붙이는 맥락(〔…〕로 시작하는 줄들)은 사람이 쓴 글이 아니므로 뺀다.
export function inboundText(raw) {
  const cut = String(raw ?? '').split(/\n\s*\n〔/)[0];
  return cut.replace(/<\/channel>\s*$/, '').trim();
}

const attrs = (tag) => { const o = {}; for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) o[m[1]] = m[2]; return o; };
const CHANNEL = /<channel\b([^>]*)>([\s\S]*)$/;

// 대화 기록의 한 줄(JSON 문자열)에서 텔레그램 메시지를 뽑는다. 해당 없으면 null.
export function parseLine(line) {
  if (!line.includes('telegram')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  // 수신: 큐에 들어갈 때(queue-operation.content) 또는 실행 대기열(queued_command.prompt) 에 <channel …>본문</channel> 로 남는다.
  const raw = typeof o.content === 'string' && o.type === 'queue-operation' && o.operation === 'enqueue' ? o.content
    : o.type === 'attachment' && o.attachment?.type === 'queued_command' && typeof o.attachment.prompt === 'string' ? o.attachment.prompt : '';
  if (raw) {
    const m = CHANNEL.exec(raw);
    if (!m) return null;
    const a = attrs(m[1]);
    if (!a.chat_id || !a.message_id) return null;
    const text = inboundText(m[2]);
    if (!text) return null;
    return { key: `${a.chat_id}:${a.message_id}`, chat: a.chat_id, thread: a.thread_id || '', at: a.ts || o.timestamp || '', role: 'user', who: a.user_name || (/^\d+$/.test(a.user || '') ? '' : a.user || ''), text: clip(text, MAX_TEXT), topic: a.topic || '', topicTeam: a.topic_team || '' };
  }
  // 발신: assistant 의 telegram reply 도구 호출
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const c of o.message.content) {
      if (c?.type === 'tool_use' && /telegram__reply$/.test(c.name || '') && c.input?.chat_id && typeof c.input.text === 'string') {
        const text = c.input.format === 'html' ? plain(c.input.text) : c.input.text.trim();
        if (!text) continue;
        return { key: `reply:${c.id}`, chat: String(c.input.chat_id), thread: c.input.thread_id ? String(c.input.thread_id) : '', at: o.timestamp || '', role: 'bot', who: '', text: clip(text, MAX_TEXT) };
      }
    }
  }
  return null;
}

// ── 파일별 증분 읽기 ──
const files = new Map();   // 경로 → { size, offset, tail, seen:Set, byRoom: Map<chat, {all:[], threads:Map<thread,[]>}> }

function readRange(file, from, to) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, from + got); if (!n) break; got += n; }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

function add(st, m) {
  if (st.seen.has(m.key)) return;
  st.seen.add(m.key);
  const room = st.byRoom.get(m.chat) || { all: [], threads: new Map() };
  st.byRoom.set(m.chat, room);
  const push = (list) => { list.push(m); if (list.length > KEEP * 2) list.splice(0, list.length - KEEP); };
  push(room.all);
  const t = m.thread || '';
  const list = room.threads.get(t) || [];
  room.threads.set(t, list);
  push(list);
}

function refresh(file) {
  let size;
  try { size = statSync(file).size; } catch { files.delete(file); return null; }
  let st = files.get(file);
  if (!st || size < st.offset) { st = { offset: 0, tail: Buffer.alloc(0), seen: new Set(), byRoom: new Map() }; files.set(file, st); }
  if (size > st.offset) {
    const end = Math.min(size, st.offset + MAX_CHUNK);
    const data = Buffer.concat([st.tail, readRange(file, st.offset, end)]);
    const lastNl = data.lastIndexOf(0x0a);
    const body = lastNl < 0 ? Buffer.alloc(0) : data.subarray(0, lastNl);
    st.tail = lastNl < 0 ? data : data.subarray(lastNl + 1);
    st.offset = end;
    for (const line of body.toString('utf8').split('\n')) { const m = line && parseLine(line); if (m) add(st, m); }
  }
  return st;
}

// Claude 가 폴더 경로를 프로젝트 폴더 이름으로 바꾸는 규칙: 영문·숫자 말고는 모두 '-'.
export const projectSlug = (folder) => String(folder).replace(/[^A-Za-z0-9]/g, '-');

export function officeProjectDirs(office, claudeHome = CLAUDE_HOME) {
  const folders = [office.folder, office.previousFolder].filter(Boolean);
  return folders.map((f) => join(claudeHome, 'projects', projectSlug(f)));
}

function collect(dirs) {
  const states = [];
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) { const st = refresh(join(dir, n)); if (st) states.push(st); }
  }
  return states;
}

const newestLast = (list) => list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const strip = ({ key, ...rest }) => rest;   // eslint-disable-line no-unused-vars

// Claude 사무실의 한 방(주제)의 최근 대화. thread 가 undefined 면 방 전체, '' 면 주제 밖(일반) 대화.
export function officeActivity(dirs, chat, thread, limit = 30) {
  const merged = new Map();
  for (const st of collect(dirs)) {
    const room = st.byRoom.get(String(chat));
    if (!room) continue;
    for (const m of (thread === undefined ? room.all : room.threads.get(String(thread)) || [])) merged.set(m.key, m);
  }
  return newestLast([...merged.values()]).slice(-limit).map(strip);
}

// 방 목록에 붙일 요약: { [chat]: { last, topics: { [thread]: { last, count } } } }
export function officeSummary(dirs) {
  const rooms = new Map();
  for (const st of collect(dirs)) {
    for (const [chat, room] of st.byRoom) {
      const r = rooms.get(chat) || { all: new Map(), threads: new Map() };
      rooms.set(chat, r);
      for (const m of room.all) r.all.set(m.key, m);
      for (const [t, list] of room.threads) { const tm = r.threads.get(t) || new Map(); r.threads.set(t, tm); for (const m of list) tm.set(m.key, m); }
    }
  }
  const out = {};
  const lastOf = (map) => { const l = newestLast([...map.values()]); const m = l[l.length - 1]; return m ? { at: m.at, role: m.role, text: clip(m.text.replace(/\s+/g, ' '), 140) } : null; };
  for (const [chat, r] of rooms) {
    out[chat] = { last: lastOf(r.all), topics: Object.fromEntries([...r.threads].filter(([t]) => t).map(([t, map]) => [t, { last: lastOf(map), count: map.size }])) };
  }
  return out;
}

// ── LAPIS 봇: 대화 기억(history) ──
export function botActivity(botFolder, chat, thread, limit = 30) {
  const file = join(botFolder, 'history', `${chat}_${thread || 0}.json`);
  const list = readJson(file, []);
  let at = '';
  try { at = statSync(file).mtime.toISOString(); } catch { /* 없음 */ }
  if (!Array.isArray(list)) return [];
  // 시각은 파일에 없어 마지막 갱신 시각만 안다 — 마지막 메시지에만 붙이고 나머지는 순서로 보여 준다.
  return list.slice(-limit).map((m, i, arr) => ({ at: i === arr.length - 1 ? at : '', role: m.role === 'assistant' ? 'bot' : 'user', who: '', text: clip(String(m.content ?? ''), MAX_TEXT), chat: String(chat), thread: String(thread || '') }));
}

export function botSummary(botFolder, rooms) {
  const out = {};
  for (const r of rooms) {
    const one = (thread) => { const l = botActivity(botFolder, r.id, thread, 1); const m = l[0]; return m ? { at: m.at, role: m.role, text: clip(m.text.replace(/\s+/g, ' '), 140) } : null; };
    out[r.id] = { last: one(0), topics: Object.fromEntries(r.topics.map((t) => [t.id, { last: one(t.id), count: 0 }])) };
  }
  return out;
}
