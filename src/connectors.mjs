// 커넥터: 봇(Claude 사무실·Hermes)이 바깥 서비스를 도구(MCP 서버)로 쓰게 한다.
//   - LAPIS 커넥터(기본 제공): 이 앱의 MCP 서버(src/connectors/lapis-mcp.mjs). 라피스 계정의 Google 연결로 드라이브 검색·읽기,
//     시트·문서·슬라이드 쓰기(미리보기 → 확인 → 적용)와 LAPIS 일정·할 일을 쓴다. 실제 호출은 대시보드(127.0.0.1)가 대신 한다.
//   - 직접 추가: 사용자가 적은 MCP 서버(주소 또는 명령).
// 설정은 <데이터>\connectors.json 에 두고, 봇 쪽에는 이렇게 적용한다.
//   Claude 사무실 : 사무실 폴더의 .mcp.json(서버 목록) + .claude/settings.local.json(enabledMcpjsonServers, permissions.allow 의 mcp__이름)
//   Hermes        : config.yaml 의 mcp_servers(표식 사이 블록만)
// 이 모듈이 더한 항목만 기억했다가 바꿀 때 걷어낸다(사용자가 직접 넣은 서버·규칙은 건드리지 않는다). 봇은 다시 시작해야 새 커넥터를 읽는다.
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { APP_HOME, FILES, CONNECTORS_DIR } from './paths.mjs';
import { readText, readJson, writeJson, writeAtomic, isFile, need, nowIso } from './util.mjs';
import { getOffice, listOffices, isReadonly } from './offices.mjs';
import { settingsFile, readLocalSettings } from './drives.mjs';
import { logChange } from './teams.mjs';
import * as H from './hermes-config.mjs';

export const LAPIS = 'lapis';   // 기본 제공 커넥터 이름(.mcp.json·mcp_servers 의 키)
export const GOOGLE_LEVELS = { off: '끔', read: '읽기만', chat: '읽기·쓰기 (채팅에서 확인 후 적용)', app: '읽기·쓰기 (LAPIS 앱에서 승인해야 적용)' };
export const MAX_CUSTOM = 8;
export const MCP_SCRIPT = join(APP_HOME, 'src', 'connectors', 'lapis-mcp.mjs');
const MASK = '********';
const dashboardUrl = () => `http://127.0.0.1:${Number(process.env.LAPIS_DASHBOARD_PORT) || 4310}`;
export const tokenFile = (id) => join(CONNECTORS_DIR, `${id}.token`);
const hash = (s) => createHash('sha256').update(s).digest('hex');

// ── 저장소 ──
export function readStore() {
  const s = readJson(FILES.connectors, null);
  return s && s.version === 1 && s.bots && typeof s.bots === 'object' ? s : { version: 1, bots: {} };
}
const writeStore = (s) => writeJson(FILES.connectors, s);
const blankLapis = () => ({ enabled: false, google: 'chat', calendar: true, tasks: true });

// 커넥터를 둘 수 있는 봇: Claude 사무실(읽기 전용 제외)과 Hermes(모드와 상관없이 — 사용자가 직접 누른 변경만, 백업 후 적용).
function target(id) {
  const o = getOffice(id);
  if (o.kind === 'hermes') return o;
  need(!isReadonly(o), `"${o.name}"은(는) 읽기 전용이라 커넥터를 바꾸지 않습니다.`, 403);
  return o;
}

// ── 검사 ──
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
function cleanMap(raw, what, old = {}) {
  if (raw === undefined || raw === null) return {};
  need(raw && typeof raw === 'object' && !Array.isArray(raw), `${what} 형식이 올바르지 않습니다.`);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    need(/^[A-Za-z0-9_.-]{1,64}$/.test(key), `${what} 이름이 올바르지 않습니다: ${key}`);
    const val = String(v ?? '');
    need(val.length <= 2000 && !/[\r\n\0]/.test(val), `${what} 값이 너무 길거나 줄바꿈이 들어 있습니다: ${key}`);
    out[key] = val === MASK ? String(old[key] ?? '') : val;   // 화면에 가려 보낸 값은 저장된 값을 그대로 쓴다
  }
  need(Object.keys(out).length <= 20, `${what}은(는) 20개까지 넣을 수 있습니다.`);
  return out;
}

export function cleanCustom(raw, old = []) {
  need(raw && typeof raw === 'object', '커넥터 형식이 올바르지 않습니다.');
  const name = String(raw.name || '').trim().toLowerCase();
  need(NAME_RE.test(name), '커넥터 이름은 영어 소문자로 시작하는 2~32자(소문자·숫자·-)로 적어 주세요. 예: github');
  need(name !== LAPIS, `"${LAPIS}"는 기본 제공 커넥터 이름이라 쓸 수 없습니다.`);
  const prev = old.find((c) => c.name === name) || {};
  if (raw.url !== undefined && String(raw.url).trim()) {
    let u;
    try { u = new URL(String(raw.url).trim()); } catch { u = null; }
    need(u && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))), '주소는 https:// 로 시작해야 합니다. (이 PC 안의 서버만 http://127.0.0.1 을 쓸 수 있어요)');
    need(u.href.length <= 500, '주소가 너무 깁니다.');
    return { name, url: u.href, headers: cleanMap(raw.headers, '헤더', prev.headers) };
  }
  const command = String(raw.command || '').trim();
  need(command && command.length <= 300 && !/[\r\n\0]/.test(command), '주소(URL) 또는 실행할 명령을 적어 주세요.');
  const args = raw.args === undefined ? [] : raw.args;
  need(Array.isArray(args) && args.length <= 30 && args.every((a) => typeof a === 'string' && a.length <= 500 && !/[\r\n\0]/.test(a)), '명령 인자 형식이 올바르지 않습니다.');
  return { name, command, args, env: cleanMap(raw.env, '환경 값', prev.env) };
}

function cleanLapis(raw, old) {
  const v = { ...blankLapis(), ...old, ...(raw || {}) };
  need(v.google in GOOGLE_LEVELS, 'Google 사용 범위가 올바르지 않습니다.');
  return { enabled: v.enabled === true, google: v.google, calendar: v.calendar === true, tasks: v.tasks === true };
}

// ── 봇 설정에 넣을 서버 정의 ──
// LAPIS 커넥터는 이 앱의 node 로 MCP 스크립트를 실행한다. 대시보드 주소와 호출 키 파일 위치만 넘기고, 키 자체는 설정 파일에 적지 않는다.
export function lapisServer(id) {
  return { command: process.execPath, args: [MCP_SCRIPT], env: { LAPIS_CONNECTOR_URL: dashboardUrl(), LAPIS_CONNECTOR_TOKEN_FILE: tokenFile(id), LAPIS_CONNECTOR_BOT: id } };
}
function serversOf(id, entry) {
  const out = {};
  if (entry.lapis?.enabled) out[LAPIS] = lapisServer(id);
  for (const c of entry.custom || []) out[c.name] = c.url ? { url: c.url, ...(Object.keys(c.headers || {}).length ? { headers: c.headers } : {}) } : { command: c.command, args: c.args || [], ...(Object.keys(c.env || {}).length ? { env: c.env } : {}) };
  return out;
}

// 호출 키: 봇마다 하나. 파일에는 키, 저장소에는 해시만 둔다(대시보드는 해시로 확인한다).
function ensureToken(id, entry) {
  const f = tokenFile(id);
  let tok = isFile(f) ? readText(f).trim() : '';
  if (!/^[A-Za-z0-9_-]{40,}$/.test(tok) || entry.tokenHash !== hash(tok)) {
    tok = randomBytes(32).toString('base64url');
    writeAtomic(f, tok, 0o600);
    entry.tokenHash = hash(tok);
  }
}

// ── 적용 ──
function applyClaude(o, servers, prevNames) {
  const mcpFile = join(o.folder, '.mcp.json');
  let doc = {};
  if (isFile(mcpFile)) {
    try { doc = JSON.parse(readText(mcpFile)); } catch { doc = null; }
    need(doc && typeof doc === 'object' && !Array.isArray(doc) && (doc.mcpServers === undefined || (doc.mcpServers && typeof doc.mcpServers === 'object')), '사무실의 .mcp.json 을 읽을 수 없어 건드리지 않았습니다. 파일을 확인해 주세요.', 409);
  }
  const mcp = { ...(doc.mcpServers || {}) };
  const names = Object.keys(servers);
  const clash = names.filter((n) => mcp[n] && !prevNames.includes(n));
  need(!clash.length, `.mcp.json 에 같은 이름의 서버가 이미 있습니다: ${clash.join(', ')}. 다른 이름을 쓰거나 그 서버를 지워 주세요.`, 409);
  for (const n of prevNames) delete mcp[n];
  for (const n of names) mcp[n] = servers[n].url ? { type: 'http', ...servers[n] } : servers[n];
  if (names.length || isFile(mcpFile)) writeJson(mcpFile, { ...doc, mcpServers: mcp });

  const cur = readLocalSettings(o.folder);
  const rule = (n) => `mcp__${n}`;
  const enabled = (Array.isArray(cur.enabledMcpjsonServers) ? cur.enabledMcpjsonServers : []).filter((n) => !prevNames.includes(n));
  cur.enabledMcpjsonServers = [...enabled, ...names.filter((n) => !enabled.includes(n))];
  if (!cur.enabledMcpjsonServers.length) delete cur.enabledMcpjsonServers;
  if (names.length || cur.permissions?.allow) {
    cur.permissions ||= {};
    const allow = (cur.permissions.allow || []).filter((a) => !prevNames.map(rule).includes(a));
    cur.permissions.allow = [...allow, ...names.map(rule).filter((r) => !allow.includes(r))];
  }
  writeJson(settingsFile(o.folder), cur);
}

function applyHermes(o, servers) {
  const text = H.readConfig(o);
  const next = H.writeMcpServers(text, servers);
  if (next !== text.replace(/\r\n/g, '\n')) H.writeConfig(o, next);
}

function apply(o, entry) {
  const servers = serversOf(o.id, entry);
  if (entry.lapis?.enabled) ensureToken(o.id, entry);
  if (o.kind === 'hermes') applyHermes(o, servers);
  else applyClaude(o, servers, entry.applied || []);
  entry.applied = Object.keys(servers);
}

// ── 화면용 ──
const masked = (m) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, v ? MASK : '']));
export function getConnectors(id) {
  const o = target(id);
  const e = readStore().bots[o.id] || {};
  return {
    office: { id: o.id, name: o.name, kind: o.kind, readonly: isReadonly(o) },
    lapis: { ...blankLapis(), ...(e.lapis || {}) },
    custom: (e.custom || []).map((c) => (c.url ? { name: c.name, url: c.url, headers: masked(c.headers) } : { name: c.name, command: c.command, args: c.args || [], env: masked(c.env) })),
    applied: e.applied || [],
    appliedTo: o.kind === 'hermes' ? 'config.yaml (mcp_servers)' : '.mcp.json · .claude/settings.local.json',
    updatedAt: e.updatedAt || null,
    googleLevels: GOOGLE_LEVELS,
  };
}

export function setConnectors(id, body = {}) {
  const o = target(id);
  const store = readStore();
  const old = store.bots[o.id] || {};
  const entry = { ...old };
  if (body.lapis !== undefined) entry.lapis = cleanLapis(body.lapis, old.lapis);
  if (body.custom !== undefined) {
    need(Array.isArray(body.custom) && body.custom.length <= MAX_CUSTOM, `직접 추가한 커넥터는 ${MAX_CUSTOM}개까지 둘 수 있습니다.`);
    entry.custom = body.custom.map((c) => cleanCustom(c, old.custom || []));
    need(new Set(entry.custom.map((c) => c.name)).size === entry.custom.length, '같은 이름의 커넥터가 두 번 들어 있습니다.');
  }
  apply(o, entry);
  entry.name = o.name;   // 대시보드의 승인·사용 기록에 보여 줄 이름
  entry.updatedAt = nowIso();
  store.bots[o.id] = entry;
  writeStore(store);
  if (!entry.lapis?.enabled) rmSync(tokenFile(o.id), { force: true });   // 끈 봇의 호출 키는 바로 없앤다
  if (o.kind !== 'hermes') try { logChange(o.folder, '커넥터', entry.applied.join(', ') || '없음', '대시보드에서 커넥터 설정을 바꿈', ''); } catch { /* 기록 실패는 무시 */ }
  return { ...getConnectors(o.id), restartNeeded: true };
}

// 봇을 목록에서 지우면 커넥터 설정과 호출 키도 지운다(봇 폴더의 설정은 그대로 둔다).
export function forgetConnectors(id) {
  const store = readStore();
  if (!store.bots[id]) return;
  delete store.bots[id];
  writeStore(store);
  rmSync(tokenFile(id), { force: true });
}

// 서버가 켜질 때: 프로그램 위치(node·스크립트 경로)나 대시보드 포트가 바뀌었으면 봇 설정을 다시 맞춘다. 실패는 다음 기회로 미룬다.
export function repairConnectors() {
  const store = readStore();
  let changed = false;
  for (const o of listOffices()) {
    const e = store.bots[o.id];
    if (!e?.lapis?.enabled) continue;
    try {
      if (o.kind !== 'hermes' && isReadonly(o)) continue;
      const want = JSON.stringify(lapisServer(o.id));
      const have = o.kind === 'hermes' ? null : readJson(join(o.folder, '.mcp.json'), {})?.mcpServers?.[LAPIS];
      const fresh = o.kind === 'hermes' ? H.readConfig(o).includes(JSON.stringify(lapisServer(o.id))) : JSON.stringify(have) === want;
      if (fresh && isFile(tokenFile(o.id))) continue;
      apply(o, e);
      changed = true;
    } catch { /* 봇 폴더가 없거나 설정을 읽을 수 없으면 건너뛴다 */ }
  }
  if (changed) writeStore(store);
  return changed;
}

// ── Hermes 기능(활용 범위) ──
export function hermesTools(id) {
  const o = getOffice(id);
  need(o.kind === 'hermes', 'Hermes 봇에서만 쓸 수 있습니다.');
  return { office: { id: o.id, name: o.name, readonly: isReadonly(o) }, ...H.toolsView(H.readConfig(o)), turnsRange: H.MAX_TURNS };
}
export function setHermesTools(id, body = {}) {
  const o = getOffice(id);
  need(o.kind === 'hermes', 'Hermes 봇에서만 쓸 수 있습니다.');
  const text = H.readConfig(o).replace(/\r\n/g, '\n');
  const next = H.applyTools(text, { toolsets: body.toolsets, maxTurns: body.maxTurns, confirmRisk: body.confirmRisk });
  if (next !== text) H.writeConfig(o, next);
  return { ...hermesTools(o.id), changed: next !== text, restartNeeded: next !== text };
}
