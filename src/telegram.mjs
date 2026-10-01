// 텔레그램 연결: 봇 토큰 저장, 페어링(접근 허용), 수신 프로세스 진단.
// 사무실마다 상태 폴더(TELEGRAM_STATE_DIR)가 따로 있어서 봇과 사무실이 서로 섞이지 않는다.
// 토큰은 그 폴더의 .env 에만 저장하고, 화면·로그·API 응답에는 절대 내보내지 않는다(앞·뒤 일부만 가림).
import { join } from 'node:path';
import { readdirSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { readText, readJson, writeJson, isFile, isDir, ps, need, run, isWindows, nowIso } from './util.mjs';
import { CLAUDE_USER_SETTINGS, TG_PLUGIN } from './paths.mjs';

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

// ── 토큰 ──
function readToken(stateDir) {
  try {
    const m = /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(readText(join(stateDir, '.env')));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

const mask = (t) => (t ? `${t.split(':')[0]}:••••${t.slice(-4)}` : '');

async function getMe(token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return { ok: false, error: j.description || `오류 ${r.status}` };
    return { ok: true, username: j.result.username, name: j.result.first_name, id: j.result.id };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '텔레그램에 연결하지 못했습니다(시간 초과).' : '텔레그램에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  } finally { clearTimeout(timer); }
}

const botCache = new Map();
export async function botInfo(stateDir) {
  const token = readToken(stateDir);
  if (!token) return null;
  const hit = botCache.get(token);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
  const me = await getMe(token);
  const value = me.ok ? { username: me.username, name: me.name } : { error: me.error };
  botCache.set(token, { at: Date.now(), value });
  return value;
}

export function tokenStatus(stateDir) {
  const t = readToken(stateDir);
  return { set: Boolean(t), masked: mask(t) };
}

export async function saveToken(stateDir, token) {
  token = String(token || '').trim();
  need(TOKEN_RE.test(token), '봇 토큰 형식이 올바르지 않습니다. BotFather가 알려 준 123456789:AAH… 형태 전체를 붙여 넣어 주세요.');
  const me = await getMe(token);
  need(me.ok, `토큰을 확인하지 못했습니다: ${me.error}`);
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, '.env');
  writeFileSync(file, `TELEGRAM_BOT_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { }
  botCache.delete(token);
  return { username: me.username, name: me.name };
}

export function clearToken(stateDir) {
  rmSync(join(stateDir, '.env'), { force: true });
}

// ── 접근 허용(페어링). Telegram 플러그인의 /telegram:access 와 같은 규칙으로 access.json 을 다룬다. ──
const accessFile = (d) => join(d, 'access.json');
const defaultAccess = () => ({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} });

function loadAccess(stateDir) {
  const a = readJson(accessFile(stateDir), null) || {};
  return { ...defaultAccess(), ...a, allowFrom: a.allowFrom || [], groups: a.groups || {}, pending: a.pending || {} };
}

export function accessInfo(stateDir) {
  const a = loadAccess(stateDir);
  const now = Date.now();
  return {
    dmPolicy: a.dmPolicy,
    allowFrom: a.allowFrom,
    groups: Object.keys(a.groups),
    pending: Object.entries(a.pending)
      .filter(([, p]) => !p.expiresAt || p.expiresAt > now)
      .map(([code, p]) => ({ code, senderId: p.senderId, ageSec: Math.round((now - (p.createdAt || now)) / 1000) })),
  };
}

export function pair(stateDir, code) {
  code = String(code || '').trim().toLowerCase();
  need(/^[a-z0-9]{4,10}$/.test(code), '페어링 코드를 확인해 주세요. 봇이 알려 준 6자리 코드입니다.');
  const a = loadAccess(stateDir);
  const p = a.pending[code];
  need(p && (!p.expiresAt || p.expiresAt > Date.now()), '없거나 만료된 코드입니다. 봇에게 메시지를 다시 보내 새 코드를 받아 주세요.', 404);
  if (!a.allowFrom.includes(p.senderId)) a.allowFrom.push(p.senderId);
  delete a.pending[code];
  writeJson(accessFile(stateDir), a);
  const dir = join(stateDir, 'approved');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(p.senderId)), String(p.chatId ?? p.senderId), 'utf8');   // 플러그인이 이 파일을 보고 "연결됐습니다" 안내를 보낸다
  return { senderId: p.senderId };
}

export function deny(stateDir, code) {
  const a = loadAccess(stateDir);
  delete a.pending[String(code || '').trim().toLowerCase()];
  writeJson(accessFile(stateDir), a);
}

export function removeSender(stateDir, senderId) {
  const a = loadAccess(stateDir);
  a.allowFrom = a.allowFrom.filter((x) => x !== String(senderId));
  writeJson(accessFile(stateDir), a);
}

export function setPolicy(stateDir, mode) {
  need(['pairing', 'allowlist', 'disabled'].includes(mode), '허용 방식은 pairing, allowlist, disabled 중 하나입니다.');
  const a = loadAccess(stateDir);
  a.dmPolicy = mode;
  writeJson(accessFile(stateDir), a);
}

// ── 그룹방·주제별 업무 ──
// 봇(플러그인)이 초대된 방과 본 주제를 rooms.json 에 기록하고, 대시보드는 그걸 읽어 보여 주며
// 업무 지정·연결(허용)·정리를 한다. 봇은 파일이 바뀌면 다시 읽으므로 서로 덮어쓰지 않는다.
// 방 연결 = access.json 의 groups 에 올리는 것. 기본값은 플러그인과 같다(멘션 없이도 응답, 허용된 계정만 발언).
const roomsFile = (d) => join(d, 'rooms.json');
const MAX_TASK = 800;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const THREAD_ID_RE = /^\d{1,12}$/;
const clipTask = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK);

// 알 수 없는 필드도 그대로 보존하려고 원본 객체를 읽어 고친 뒤 되쓴다.
function loadRoomsRaw(stateDir) {
  const r = readJson(roomsFile(stateDir), null) || {};
  if (!r.rooms || typeof r.rooms !== 'object') r.rooms = {};
  return r;
}

export function roomsInfo(stateDir) {
  const db = loadRoomsRaw(stateDir), a = loadAccess(stateDir);
  const rooms = Object.values(db.rooms).sort((x, y) => (x.firstSeen || 0) - (y.firstSeen || 0)).map((r) => {
    const g = a.groups[r.id];
    return {
      id: String(r.id), title: r.title || String(r.id), type: r.type || '', isForum: Boolean(r.isForum),
      botStatus: r.botStatus || 'unknown', checkError: r.checkError || '',
      invitedBy: r.invitedBy ? { id: String(r.invitedBy.id), name: r.invitedBy.name || '' } : null, invitedAt: r.invitedAt || 0,
      task: r.task || '', connected: Boolean(g),
      requireMention: g ? g.requireMention !== false : true, allowFromCount: g ? (g.allowFrom || []).length : 0,
      topics: Object.entries(r.topics || {}).map(([id, t]) => ({ id, name: t.name || '', closed: Boolean(t.closed), task: t.task || '' })),
    };
  });
  // 예전에 손으로 등록해서 rooms.json 에는 없는 방도 보여 준다(이름은 모름).
  for (const gid of Object.keys(a.groups)) {
    if (db.rooms[gid]) continue;
    rooms.push({ id: gid, title: `(이름 모름) ${gid}`, type: '', isForum: false, botStatus: 'unknown', checkError: '', invitedBy: null, invitedAt: 0, task: '', connected: true, requireMention: a.groups[gid].requireMention !== false, allowFromCount: (a.groups[gid].allowFrom || []).length, topics: [] });
  }
  return { defaultTask: db.defaultTask || '', rooms };
}

function needRoom(db, chatId) {
  need(CHAT_ID_RE.test(String(chatId)), '방 ID가 올바르지 않습니다.');
  need(db.rooms[chatId], '봇이 아직 모르는 방입니다.', 404);
  return db.rooms[chatId];
}

// threadId 가 있으면 그 주제 전용 업무, 없으면 방 전체 업무. 빈 값이면 해제.
export function setRoomTask(stateDir, chatId, threadId, task) {
  chatId = String(chatId);
  const db = loadRoomsRaw(stateDir), room = needRoom(db, chatId);
  let target = room;
  if (threadId != null && threadId !== '') {
    need(THREAD_ID_RE.test(String(threadId)), '주제 ID가 올바르지 않습니다.');
    target = room.topics && room.topics[String(threadId)];
    need(target, '봇이 아직 모르는 주제입니다.', 404);
  }
  const t = clipTask(task);
  if (t) target.task = t; else delete target.task;
  writeJson(roomsFile(stateDir), db, 0o600);
  return { task: t };
}

export function setDefaultTask(stateDir, task) {
  const db = loadRoomsRaw(stateDir), t = clipTask(task);
  if (t) db.defaultTask = t; else delete db.defaultTask;
  writeJson(roomsFile(stateDir), db, 0o600);
  return { defaultTask: t };
}

export function connectRoom(stateDir, chatId) {
  chatId = String(chatId);
  need(CHAT_ID_RE.test(chatId), '방 ID가 올바르지 않습니다.');
  const a = loadAccess(stateDir);
  need(a.allowFrom.length > 0, '먼저 내 텔레그램 계정을 허용(페어링)해 주세요. 방에서는 허용된 계정만 봇을 부를 수 있습니다.');
  if (!a.groups[chatId]) {
    const db = loadRoomsRaw(stateDir);
    need(db.rooms[chatId], '봇이 아직 모르는 방입니다. 봇을 방에 초대하거나, 방에서 봇을 @멘션해 주세요.', 404);
    a.groups[chatId] = { requireMention: false, allowFrom: [...a.allowFrom] };
    writeJson(accessFile(stateDir), a);
    if (db.defaultTask && !db.rooms[chatId].task) { db.rooms[chatId].task = db.defaultTask; writeJson(roomsFile(stateDir), db, 0o600); }
  }
  return { ok: true };
}

export function disconnectRoom(stateDir, chatId) {
  chatId = String(chatId);
  need(CHAT_ID_RE.test(chatId), '방 ID가 올바르지 않습니다.');
  const a = loadAccess(stateDir);
  delete a.groups[chatId];
  writeJson(accessFile(stateDir), a);
}

// 봇이 이미 나간(또는 강퇴된) 방을 목록에서 지운다. 연결 중인 방과 봇이 아직 있는 방은 지우지 않는다.
export function forgetRoom(stateDir, chatId) {
  chatId = String(chatId);
  const db = loadRoomsRaw(stateDir), room = needRoom(db, chatId);
  need(room.botStatus === 'left' || room.botStatus === 'kicked', '봇이 아직 이 방에 있거나 상태를 모릅니다. 먼저 「상태 확인」을 눌러 주세요.');
  need(!loadAccess(stateDir).groups[chatId], '연결된 방입니다. 먼저 연결을 해제해 주세요.');
  delete db.rooms[chatId];
  writeJson(roomsFile(stateDir), db, 0o600);
}

// 텔레그램에 직접 물어 방 이름과 봇의 참여 상태를 새로 확인한다(토큰은 이 PC 안에서만 쓰고 응답에 싣지 않는다).
async function tgCall(token, method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}), signal: ctl.signal });
    return await r.json().catch(() => ({ ok: false, description: `오류 ${r.status}` }));
  } catch (e) {
    return { ok: false, description: e.name === 'AbortError' ? '시간 초과' : '연결 실패' };
  } finally { clearTimeout(timer); }
}

export async function refreshRooms(stateDir, fetcher = tgCall) {
  const token = readToken(stateDir);
  need(token, '봇 토큰이 아직 없습니다.');
  const me = await fetcher(token, 'getMe');
  need(me.ok, `텔레그램에 확인하지 못했습니다: ${me.description || ''}`, 502);
  const db = loadRoomsRaw(stateDir);
  const a = loadAccess(stateDir);
  let changed = 0;
  for (const room of Object.values(db.rooms)) {
    const chat = await fetcher(token, 'getChat', { chat_id: room.id });
    if (chat.ok) {
      room.title = chat.result.title || room.title; room.type = chat.result.type || room.type;
      if (chat.result.is_forum) room.isForum = true;
      const m = await fetcher(token, 'getChatMember', { chat_id: room.id, user_id: me.result.id });
      if (m.ok) { room.botStatus = m.result.status === 'restricted' && m.result.is_member === false ? 'left' : m.result.status; delete room.checkError; }
      else room.checkError = m.description || '확인 실패';
    } else {
      const to = chat.parameters && chat.parameters.migrate_to_chat_id;
      if (to) {   // 일반 그룹 → 슈퍼그룹 전환: 방 ID가 바뀐 것이므로 기록과 연결을 새 ID로 옮긴다.
        const nid = String(to);
        if (!db.rooms[nid]) db.rooms[nid] = { ...room, id: nid, type: 'supergroup' };
        delete db.rooms[room.id];
        if (a.groups[room.id]) { if (!a.groups[nid]) a.groups[nid] = a.groups[room.id]; delete a.groups[room.id]; writeJson(accessFile(stateDir), a); }
        changed++; continue;
      }
      const msg = chat.description || '확인 실패';
      if (/kicked/i.test(msg)) room.botStatus = 'kicked';
      else if (/chat not found|not a member|left/i.test(msg)) room.botStatus = 'left';
      room.checkError = msg;
    }
    changed++;
  }
  writeJson(roomsFile(stateDir), db, 0o600);
  return { checked: changed };
}

// ── 수신 프로세스 진단 ──
// 한 봇 토큰은 한 곳에서만 메시지를 받을 수 있다. 플러그인이 여러 Claude 세션에서 동시에 켜져 있으면
// 나중에 켜진 세션이 수신권을 가로채 메시지가 사무실에 도착하지 않는다.
export async function listPollers() {
  if (!isWindows) return { supported: false, pollers: [] };
  const r = await ps(
    "Get-CimInstance Win32_Process -Filter \"Name='bun.exe' or Name='claude.exe' or Name='node.exe'\" | " +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n=\'Start\';e={$_.CreationDate.ToString(\'o\')}} | ConvertTo-Json -Compress',
    { timeout: 20000 });
  let rows = [];
  try { const j = JSON.parse(r.stdout || '[]'); rows = Array.isArray(j) ? j : [j]; } catch { return { supported: true, error: '프로세스 목록을 읽지 못했습니다.', pollers: [] }; }
  const byPid = new Map(rows.map((p) => [p.ProcessId, p]));
  const pollers = [];
  for (const p of rows) {
    if (p.Name !== 'bun.exe' || !/server\.ts/i.test(p.CommandLine || '')) continue;
    if (!/telegram/i.test(p.CommandLine || '') && !/telegram/i.test(byPid.get(p.ParentProcessId)?.CommandLine || '')) continue;
    // 부모 chain 을 따라 올라가 이 수신 프로세스를 띄운 claude 를 찾는다.
    let owner = null, hop = byPid.get(p.ParentProcessId), guard = 0;
    while (hop && guard++ < 4) { if (hop.Name === 'claude.exe') { owner = hop; break; } hop = byPid.get(hop.ParentProcessId); }
    const ownerCmd = owner?.CommandLine || '';
    pollers.push({
      pid: p.ProcessId, wrapperPid: byPid.get(p.ParentProcessId)?.Name === 'bun.exe' ? p.ParentProcessId : null,
      ownerPid: owner?.ProcessId || null, startedAt: p.Start,
      // 사무실 세션은 --channels 로 텔레그램을 받도록 켜져 있다. 그렇지 않은 세션이 띄운 것은 수신을 가로채는 쪽이다.
      legit: /--channels[^\n]*telegram/i.test(ownerCmd),
      owner: owner ? (/--channels/i.test(ownerCmd) ? '사무실 세션' : '일반 Claude 세션') : '알 수 없음',
    });
  }
  return { supported: true, pollers };
}

export async function cleanRoguePollers() {
  const { pollers } = await listPollers();
  const rogue = pollers.filter((p) => !p.legit);
  const killed = [];
  for (const p of rogue) {
    for (const pid of [p.pid, p.wrapperPid].filter(Boolean)) {
      const r = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 });
      if (r.code === 0) killed.push(pid);
    }
  }
  return { killed, rogue: rogue.length };
}

// ── 전역 플러그인 설정 ──
export function globalPluginEnabled() {
  const s = readJson(CLAUDE_USER_SETTINGS, {});
  return Boolean(s.enabledPlugins && s.enabledPlugins[TG_PLUGIN] === true);
}

// 사용자 전역 설정에서 텔레그램 플러그인을 끈다(사무실 폴더의 프로젝트 설정이 따로 켜 두므로 사무실은 영향 없다).
export function disableGlobalPlugin() {
  need(isFile(CLAUDE_USER_SETTINGS), '전역 설정 파일이 없습니다.', 404);
  const raw = readText(CLAUDE_USER_SETTINGS);
  const s = JSON.parse(raw);
  need(s.enabledPlugins && s.enabledPlugins[TG_PLUGIN] === true, '이미 꺼져 있습니다.');
  writeFileSync(`${CLAUDE_USER_SETTINGS}.bak-ai-office`, raw, 'utf8');
  s.enabledPlugins[TG_PLUGIN] = false;
  writeFileSync(CLAUDE_USER_SETTINGS, JSON.stringify(s, null, 2) + '\n', 'utf8');
  return { backup: `${CLAUDE_USER_SETTINGS}.bak-ai-office`, at: nowIso() };
}

export const stateDirExists = (d) => isDir(d) && readdirSync(d).length >= 0;
