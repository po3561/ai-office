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
