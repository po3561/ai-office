// AI-Office 대시보드 서버(127.0.0.1 전용). 화면(web/)과 JSON API를 제공한다.
// 보안: 이 PC 안에서만 접속되고, 변경 요청은 대시보드 화면이 보낸 것(헤더·Origin 확인)만 받는다.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { WEB, APP_HOME, CLI, DATA_HOME, OFFICES_DIR, SHARED_SKILLS, TEMPLATES, MARKET_DIR } from './paths.mjs';
import { getConfig, setConfig } from './config.mjs';
import { readJson, HttpError, need, isDir, isWindows, run } from './util.mjs';
import { PRESETS } from './presets.mjs';
import { claudeInfo, claudeDiagnose, startLogin, logout, startInstall } from './claude.mjs';
import { listGrants as listDriveGrants, setGrant as setDriveGrant, removeGrant as removeDriveGrant } from './drives.mjs';
import { listOffices, getOffice, mutable, controllable, isReadonly, removeOffice, createOffice, importOffice, unregisterOffice, closeOffice, checkClosable, isClosable, updateOffice, discover, repairOffices, migrateOffice, relocateOffice, moveCandidates, autoRelink } from './offices.mjs';
import { listTeams, getTeamDetail, addTeam, updateTeam, removeTeam, loadOffice, logChange } from './teams.mjs';
import { createMarket, findSkillDirs, resolveRequest } from './market.mjs';
import { scanSkills, readChanges } from './skills.mjs';
import { readStatus, summarize } from './status.mjs';
import { runtime, startOffice, stopOffice, requestRestart, watchdogTick, forgetRuntime } from './runner.mjs';
import { createUpdater, restartEngine } from './updater.mjs';
import * as tg from './telegram.mjs';
import * as lr from './rooms-legacy.mjs';
import * as RV from './roomsview.mjs';
import * as RL from './roomlog.mjs';
import { createJobs } from './jobs.mjs';
import { createComponents } from './components.mjs';
import { createOllama, RECOMMENDED as OLLAMA_RECOMMENDED } from './ollama.mjs';
import { createSecrets } from './secrets.mjs';
import { createConnections } from './connections.mjs';
import { createTgApi } from './tgapi.mjs';
import { createEngines, ENGINE_TYPES } from './engines.mjs';
import { createBots, AGENT_PRESETS } from './bots.mjs';
import { createRuntime, buildSystem, pickAgent } from './runtime.mjs';
import { createPublisher } from './publish.mjs';
import { createStaleWatcher } from './engine-guard.mjs';
import { createUsage } from './usage.mjs';

const pkg = readJson(join(APP_HOME, 'package.json'), { version: '0.0.0' });
let updater = createUpdater({ current: pkg.version });
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };

// ── 진단 캐시(프로세스 목록 조회는 무거워서 몇 초에 한 번만) ──
let diag = { at: 0, value: { supported: true, pollers: [] }, busy: null };
async function diagnostics(force = false) {
  if (!force && Date.now() - diag.at < 12000) return diag.value;
  if (diag.busy) return diag.busy;
  // 조회가 실패하면(느린 PC 의 시간 초과 등) 직전의 좋은 결과를 유지한다. 실패를 "수신 프로세스 0개"로 보면 근무 중인 사무실을 꺼진 것으로 착각해 감시가 창을 또 띄운다.
  diag.busy = tg.listPollers().then((v) => {
    const keep = v.error && diag.value && !diag.value.error ? { ...diag.value, stale: true } : v;
    diag = { at: Date.now(), value: keep, busy: null }; return keep;
  }, () => { diag.busy = null; return diag.value; });
  return diag.busy;
}
const legitCount = (d) => (d.pollers || []).filter((p) => p.legit).length;

// ── 사무실 요약·상세 ──
const skillsDirOf = (o) => (o.kind === 'hermes' ? join(o.folder, 'skills') : join(o.folder, '.claude', 'skills'));

function summary(o, d) {
  const rt = runtime(o, { legitPollers: legitCount(d) });
  const base = {
    id: o.id, name: o.name, kind: o.kind, readonly: isReadonly(o), mode: o.kind === 'hermes' ? (isReadonly(o) ? 'readonly' : 'office') : 'office', managed: Boolean(o.managed),
    folder: o.folder, autoStart: Boolean(o.autoStart), running: rt.running, detail: rt.detail, exists: isDir(o.folder),
    closable: isClosable(o), removeKind: isClosable(o) ? 'close' : 'unregister', legacyLaunch: Boolean(o.launch), moveCandidates: moveCandidates(o), sharedTelegramState: Boolean(o.sharedTelegramState), note: o.note || '',
  };
  if (!base.exists) return { ...base, running: false, detail: '폴더를 찾을 수 없음', teamsCount: 0, skillsCount: 0, workingTeams: 0, doneToday: 0, telegram: { set: false } };
  const skills = scanSkills(skillsDirOf(o));
  if (o.kind === 'hermes') return { ...base, teamsCount: 0, skillsCount: skills.length, workingTeams: 0, doneToday: 0, telegram: { set: false } };
  const st = summarize(readStatus(o.folder));
  const office = loadOffice(o.folder);
  return { ...base, recovery: office.recovery, teamsCount: office.teams.length, skillsCount: skills.length, workingTeams: st.workingTeams, doneToday: st.doneToday, chiefState: st.chiefState, updatedAt: st.updatedAt, telegram: tg.tokenStatus(o.stateDir) };
}

async function detail(o, d) {
  const s = summary(o, d);
  if (!s.exists) return s;
  const skills = scanSkills(skillsDirOf(o));
  if (o.kind === 'hermes') return { ...s, teams: [], skills, changes: [], events: [] };
  const status = readStatus(o.folder);
  const teams = listTeams(o.folder).map((t) => ({ ...t, ...pickStatus(status.teams[t.key]) }));
  const office = loadOffice(o.folder);
  const bot = s.telegram.set ? await tg.botInfo(o.stateDir) : null;
  return {
    ...s, teams, skills, changes: readChanges(o.folder), events: (status.events || []).slice(0, 30), chief: status.chief || { state: 'idle' },
    honorific: office.honorific, importedTeams: office.imported, drives: listDriveGrants(o.folder),
    telegram: { ...s.telegram, bot, access: tg.accessInfo(o.stateDir), rooms: tg.roomsInfo(o.stateDir), legacy: lr.isLegacy(o.stateDir) ? lr.legacyView(o.stateDir, teamList(teams)) : null },
  };
}

const teamList = (teams) => teams.map((t) => ({ key: t.key, name: t.name, emoji: t.emoji }));
const pickStatus = (t = {}) => ({ state: t.state || 'idle', task: t.task || '', since: t.since || '', lastDone: t.lastDone || '', lastDoneAt: t.lastDoneAt || '', doneToday: t.doneToday || 0 });

async function overview() {
  const d = await diagnostics();
  const offices = listOffices().map((o) => summary(o, d));
  return {
    update: updater.view(),
    app: { version: pkg.version, appHome: APP_HOME, dataHome: DATA_HOME, officesDir: OFFICES_DIR, sharedSkills: SHARED_SKILLS },
    config: getConfig(),
    claude: await claudeInfo(),
    offices,
    diag: {
      supported: d.supported !== false, pollers: d.pollers || [], rogue: (d.pollers || []).filter((p) => !p.legit).length,
      globalPlugin: tg.globalPluginEnabled(),
    },
  };
}

// ── 요청 처리 도구 ──
function trusted(req, port) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  return (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
    && (!origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`)
    && req.headers['x-ai-office'] === '1'
    && String(req.headers['content-type'] || '').startsWith('application/json');
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 200_000) throw new HttpError(413, '요청이 너무 큽니다.'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, '요청 형식이 올바르지 않습니다.'); }
}

function openInExplorer(path) {
  need(isWindows, '이 기능은 Windows에서만 지원합니다.', 501);
  need(isDir(path), '폴더를 찾을 수 없습니다.', 404);
  spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' }).unref();
}

// ── 경로 → 처리기 ──
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/ping', async () => ({ app: 'ai-office', version: pkg.version }));
route('GET', '/api/overview', async () => overview());
// 사무실 방 현황: 모든 봇(LAPIS 봇·Claude 사무실)이 초대되어 있는 방과 주제를 한곳에 모은다(읽기 전용).
async function roomsOverview() {
  const groups = [];
  for (const b of bots.list()) {
    const rooms = RV.lapisRooms(b);
    try { RV.attachActivity(rooms, RL.botSummary(bots.folder(b.id), rooms)); } catch (e) { console.error('[ai-office] 방 대화 요약을 읽지 못했습니다:', b.id, e.message); }
    groups.push({ source: 'lapis', id: b.id, name: b.name, username: b.telegram.username || '', running: runtimeBots.view(b.id).running, ...RV.tally(rooms), rooms });
  }
  const d = await diagnostics();
  for (const o of listOffices()) {
    if (o.kind === 'hermes' || o.readonly || !o.stateDir || !isDir(o.folder)) continue;
    let rooms = [];
    try { rooms = lr.isLegacy(o.stateDir) ? RV.legacyOfficeRooms(lr.listRooms(o.stateDir, teamList(listTeams(o.folder)))) : RV.officeRooms(tg.roomsInfo(o.stateDir)); } catch (e) { console.error('[ai-office] 방 목록을 읽지 못했습니다:', o.id, e.message); }
    try { RV.attachActivity(rooms, RL.officeSummary(RL.officeProjectDirs(o))); } catch (e) { console.error('[ai-office] 방 대화 요약을 읽지 못했습니다:', o.id, e.message); }
    groups.push({ source: 'office', id: o.id, name: o.name, username: '', running: Boolean(summary(o, d).running), ...RV.tally(rooms), rooms });
  }
  return { groups, ...RV.tally(groups.flatMap((g) => g.rooms)) };
}
route('GET', '/api/rooms', async () => roomsOverview());
// 방(주제)의 최근 대화: ?source=lapis&id=<봇>|source=office&id=<사무실>&chat=<방>&thread=<주제, 없으면 방 전체>
route('GET', '/api/rooms/activity', async ({ url }) => {
  const q = (k) => url.searchParams.get(k);
  const chat = q('chat') || '', id = q('id') || '', limit = Math.min(Math.max(Number(q('limit')) || 30, 1), 100);
  need(/^-?\d{1,20}$/.test(chat), '방 번호가 올바르지 않습니다.');
  const thread = q('thread') == null ? undefined : q('thread');
  need(thread === undefined || /^\d{0,20}$/.test(thread), '주제 번호가 올바르지 않습니다.');
  if (q('source') === 'lapis') { need(bots.list().some((b) => b.id === id), '봇을 찾을 수 없습니다.', 404); return { messages: RL.botActivity(bots.folder(id), chat, thread || 0, limit), perMessageTime: false }; }
  const o = getOffice(id);
  return { messages: RL.officeActivity(RL.officeProjectDirs(o), chat, thread, limit), perMessageTime: true };
});
route('GET', '/api/presets', async () => PRESETS.map(({ key, name, emoji, role, group, description }) => ({ key, name, emoji, role, group, description })));
route('GET', '/api/discover', async () => discover());
route('GET', '/api/offices/:id', async ({ p }) => detail(getOffice(p.id), await diagnostics()));
route('GET', '/api/offices/:id/teams/:key', async ({ p }) => getTeamDetail(getOffice(p.id).folder, p.key));

route('PATCH', '/api/config', async ({ body }) => setConfig(body));

route('POST', '/api/claude/refresh', async () => claudeInfo({ fresh: true }));
route('GET', '/api/claude/diagnose', async () => claudeDiagnose());
route('POST', '/api/claude/login', async ({ body }) => startLogin(body.method));
route('POST', '/api/claude/logout', async () => logout());
route('POST', '/api/claude/install', async () => startInstall());

route('POST', '/api/offices', async ({ body }) => createOffice(body));
route('POST', '/api/offices/import', async ({ body }) => importOffice(body));
route('DELETE', '/api/offices/:id', async ({ p }) => unregisterOffice(p.id));
// 사무실 폐쇄: 이름을 똑같이 입력해야 하고, 켜져 있으면 먼저 끈다. 폴더는 지우지 않고 보관 위치로 옮긴다.
route('POST', '/api/offices/:id/close', async ({ p, body }) => {
  const o = checkClosable(p.id, body.confirmName);   // 끄기 전에 먼저 폐쇄할 수 있는지 확인한다
  await stopOffice(o.id);
  await new Promise((r) => setTimeout(r, 1500));   // 창이 닫히며 폴더 잠금이 풀릴 시간을 준다
  const r = closeOffice(o.id, { confirmName: body.confirmName });
  forgetRuntime(o.id);
  return r;
});
// 이름·항상 켜두기·사용 모드(Hermes). 읽기 전용 봇은 모드만 바꿀 수 있다(그 밖의 변경은 updateOffice 가 막는다).
route('PATCH', '/api/offices/:id', async ({ p, body }) => { getOffice(p.id); return updateOffice(p.id, body); });
// 봇 삭제: 이름을 똑같이 입력해야 한다. 켜져 있으면 먼저 끄고, 이 프로그램이 만든 사무실만 폴더를 보관 위치로 옮긴다(불러온 폴더·Hermes 는 파일을 그대로 두고 목록에서만 뺀다).
route('POST', '/api/offices/:id/remove', async ({ p, body }) => {
  const o = getOffice(p.id);
  need(String(body.confirmName || '').trim() === o.name, '확인을 위해 이름을 똑같이 입력해 주세요.');
  if (!isReadonly(o) && runtime(o, { legitPollers: legitCount(await diagnostics()) }).running) {
    await stopOffice(o.id);
    if (isClosable(o)) await new Promise((r) => setTimeout(r, 1500));   // 창이 닫히며 폴더 잠금이 풀릴 시간을 준다
  }
  const r = removeOffice(o.id, { confirmName: body.confirmName });
  forgetRuntime(o.id);
  return r;
});
route('POST', '/api/offices/:id/start', async ({ p }) => startOffice(p.id, { legitPollers: legitCount(await diagnostics()) }));
route('POST', '/api/offices/:id/stop', async ({ p }) => stopOffice(p.id));
route('POST', '/api/offices/:id/restart', async ({ p }) => { controllable(p.id); return requestRestart(p.id, 5); });
route('POST', '/api/offices/:id/open', async ({ p }) => { openInExplorer(getOffice(p.id).folder); return { ok: true }; });
route('POST', '/api/offices/:id/migrate', async ({ p }) => migrateOffice(p.id));
route('POST', '/api/offices/:id/relocate', async ({ p, body }) => {
  const o = mutable(p.id);
  need(o.launch || !runtime(o).running, '근무 중인 사무실은 위치를 바꿀 수 없습니다. 먼저 퇴근시킨 뒤 바꿔 주세요.', 409);
  const r = relocateOffice(p.id, body.folder);
  return { ...r, running: runtime(r).running };
});
// 드라이브 접근: 사용자가 대시보드에서만 켠다(봇은 이 주소를 부를 수 없다 — 견본이 막음). 삭제 포함은 확인 표시가 있어야 한다.
route('POST', '/api/offices/:id/drives', async ({ p, body }) => {
  const o = mutable(p.id);
  need(body.level !== 'full' || body.confirmDelete === true, '삭제까지 맡기려면 확인 표시가 필요합니다.');
  const grant = setDriveGrant(o.folder, { path: body.path, level: body.level || 'readwrite' });
  return { grant, needsRestart: runtime(o).running };
});
route('DELETE', '/api/offices/:id/drives', async ({ p, body }) => {
  const o = mutable(p.id);
  const r = removeDriveGrant(o.folder, body.path);
  return { ...r, needsRestart: runtime(o).running };
});
route('POST', '/api/open-data', async () => { openInExplorer(DATA_HOME); return { ok: true }; });

route('POST', '/api/offices/:id/teams', async ({ p, body }) => { const o = mutable(p.id); const t = addTeam(o.folder, body); return { team: t, needsRestart: runtime(o).running }; });
route('PATCH', '/api/offices/:id/teams/:key', async ({ p, body }) => { const o = mutable(p.id); const t = updateTeam(o.folder, p.key, body); return { team: t, needsRestart: runtime(o).running }; });
route('DELETE', '/api/offices/:id/teams/:key', async ({ p }) => { const o = mutable(p.id); const t = removeTeam(o.folder, p.key); return { team: t, needsRestart: runtime(o).running }; });

route('POST', '/api/offices/:id/telegram/token', async ({ p, body }) => tg.saveToken(mutable(p.id).stateDir, body.token));
route('DELETE', '/api/offices/:id/telegram/token', async ({ p }) => { tg.clearToken(mutable(p.id).stateDir); return { ok: true }; });
route('POST', '/api/offices/:id/telegram/pair', async ({ p, body }) => tg.pair(mutable(p.id).stateDir, body.code));
route('POST', '/api/offices/:id/telegram/deny', async ({ p, body }) => { tg.deny(mutable(p.id).stateDir, body.code); return { ok: true }; });
route('POST', '/api/offices/:id/telegram/remove', async ({ p, body }) => { tg.removeSender(mutable(p.id).stateDir, body.senderId); return { ok: true }; });
route('POST', '/api/offices/:id/telegram/policy', async ({ p, body }) => { tg.setPolicy(mutable(p.id).stateDir, body.mode); return { ok: true }; });
// 그룹방·주제: 업무 지정, 연결(허용)·해제, 상태 확인, 정리. 봇은 rooms.json·access.json 이 바뀌면 다시 읽으므로 재출근 없이 적용된다.
// 예전 방식 사무실은 rooms.json 의 형식이 달라서, 아래 새 방식 API 가 건드리면 파일이 망가진다. 예전용 API(telegram/legacy)만 쓰게 막는다.
const newRooms = (id) => { const o = mutable(id); need(!lr.isLegacy(o.stateDir), '이 사무실은 예전 방식의 방 설정을 씁니다. 화면의 「텔레그램 방 · 주제」에서 바꿔 주세요.', 409); return o.stateDir; };
route('POST', '/api/offices/:id/telegram/rooms/refresh', async ({ p }) => tg.refreshRooms(newRooms(p.id)));
route('POST', '/api/offices/:id/telegram/rooms/task', async ({ p, body }) => tg.setRoomTask(newRooms(p.id), body.chatId, body.threadId, body.task));
route('POST', '/api/offices/:id/telegram/rooms/default-task', async ({ p, body }) => tg.setDefaultTask(newRooms(p.id), body.task));
route('POST', '/api/offices/:id/telegram/rooms/connect', async ({ p, body }) => tg.connectRoom(newRooms(p.id), body.chatId));
route('POST', '/api/offices/:id/telegram/rooms/disconnect', async ({ p, body }) => { tg.disconnectRoom(newRooms(p.id), body.chatId); return { ok: true }; });
route('POST', '/api/offices/:id/telegram/rooms/forget', async ({ p, body }) => { tg.forgetRoom(newRooms(p.id), body.chatId); return { ok: true }; });

// 예전 AI-Office 형식의 방·주제 / 정기 보고(담당 팀 지정, 주제 만들기, 호출어, 아침·저녁 보고). 예전 사무실의 플러그인이 읽는 파일을 그대로 고친다.
const LEGACY_ACTIONS = {
  refresh: (d, t) => lr.refreshRooms(d, t),
  link: (d, t, b) => lr.setLinked(d, t, b.room, true),
  unlink: (d, t, b) => lr.setLinked(d, t, b.room, false),
  topic: (d, t, b) => lr.createTopic(d, t, b.room, b.name, b.team),
  assign: (d, t, b) => lr.assignTopic(d, t, b.room, b.topic, b.team),
  options: (d, t, b) => lr.setRoomOptions(d, t, b.room, b.options || {}),
  trigger: (d, t, b) => lr.setTrigger(d, t, b.room, b.topic, b.value),
  routinetarget: (d, t, b) => lr.setRoutineTarget(d, t, b.room, b.topic),
  routinetime: (d, t, b) => lr.setRoutineTime(d, b.id, b.time, b.enabled),
  routinetest: (d, t, b) => lr.testRoutine(d, b.id),
};
route('POST', '/api/offices/:id/telegram/legacy/:action', async ({ p, body }) => {
  const o = mutable(p.id);
  need(lr.isLegacy(o.stateDir), '이 사무실은 예전 방식의 방·주제 설정을 쓰지 않습니다.', 409);
  const fn = LEGACY_ACTIONS[p.action];
  need(fn, '알 수 없는 요청입니다.', 404);
  const r = await fn(o.stateDir, teamList(listTeams(o.folder)), body);
  return { result: r, legacy: lr.legacyView(o.stateDir, teamList(listTeams(o.folder))) };
});

// ── 스킬 마켓 ──
// 게시·설치·회수는 대시보드 화면에서 사용자가 직접 누를 때만 동작한다(텔레그램 메시지로는 불가). 자동 설치·업데이트는 없다.
const builtinSkills = () => findSkillDirs(join(TEMPLATES, 'office', '.claude', 'skills')).map((k) => k.id);   // 견본 사무실에 들어 있는 기본 스킬
const market = createMarket({ home: DATA_HOME, settings: () => getConfig().market, log: logChange, builtin: builtinSkills });
const honorificOf = (o) => { try { return loadOffice(o.folder).honorific; } catch { return ''; } };
// 마켓에서 다루는 사무실: 읽기 전용(Hermes)은 제외한다.
// LAPIS 봇(런타임)은 스킬을 메시지마다 다시 읽으므로 설치해도 재출근이 필요 없다(hot).
const lapisBotTargets = () => bots.list().map((b) => ({ id: `bot-${b.id}`, name: `${b.name} (LAPIS 봇)`, folder: bots.folder(b.id), skillsDir: bots.skillsDir(b.id), honorifics: [b.honorific].filter(Boolean), hot: true }));
const marketOffices = () => [
  ...listOffices().filter((o) => o.kind !== 'hermes' && !o.readonly && isDir(o.folder))
    .map((o) => ({ id: o.id, name: o.name, folder: o.folder, skillsDir: skillsDirOf(o), honorifics: [honorificOf(o), getConfig().honorific].filter(Boolean) })),
  ...lapisBotTargets(),
];
// 마켓에서 스킬을 받을 수 있는 곳 = 내 사무실 + 읽기 전용 외부 봇(Hermes: 라피스 등).
// 외부 봇은 설치·업데이트·제거할 때만 예외로, 그 봇의 `skills/<스킬 이름>/` 폴더 안에서만 파일을 쓴다. 게시(내보내기)·부서·설정·실행은 여전히 못 한다.
const hermesTargets = () => listOffices().filter((o) => o.kind === 'hermes' && isDir(join(o.folder, 'skills')))
  .map((o) => ({ id: o.id, name: o.name, folder: o.folder, skillsDir: join(o.folder, 'skills'), honorifics: [], external: true, backupRoot: join(MARKET_DIR, 'backup', o.id) }));
const marketTargets = () => [...marketOffices(), ...hermesTargets()];
const marketTarget = (id) => { const o = marketTargets().find((x) => x.id === id); need(o, '설치할 곳을 찾을 수 없습니다.', 404); return o; };
const marketOffice = (id) => { const o = marketOffices().find((x) => x.id === id); need(o, '사무실을 찾을 수 없습니다.', 404); return o; };
const localSkill = (o, skillId) => { const k = findSkillDirs(o.skillsDir).find((x) => x.id === skillId); need(k, '이 사무실에 없는 스킬입니다.', 404); return k; };   // 화면이 보낸 이름으로 경로를 만들지 않고 목록에서 찾는다
const marketRestart = (o, r) => ({ ...r, external: Boolean(o.external), needsRestart: !o.external && !o.hot && runtime(getOffice(o.id)).running });

route('GET', '/api/market/status', async () => market.status());
route('POST', '/api/market/connect', async ({ body }) => {
  const r = await market.connect({ repo: body.repo, alias: body.alias });
  setConfig({ market: { repo: r.repo, alias: r.alias, enabled: true } });
  return { ...r, status: await market.status() };
});
route('POST', '/api/market/disconnect', async ({ body }) => {
  const repo = getConfig().market.repo;
  setConfig({ market: { enabled: false } });
  if (body.purge && repo) market.purgeCache(repo);
  return market.status();
});
route('POST', '/api/market/refresh', async () => { await market.refresh(); return market.status(); });
route('GET', '/api/market/skills', async () => market.list({ offices: marketTargets() }));
route('GET', '/api/market/skills/:id', async ({ p }) => market.detail(p.id, { offices: marketTargets() }));
route('GET', '/api/market/shareable', async () => market.shareable({ offices: marketOffices() }));
// 이 PC 의 설치 현황: 사무실뿐 아니라 외부 봇(라피스 등)이 마켓에서 받은 스킬도 함께 본다.
route('GET', '/api/market/installed', async () => market.shareable({ offices: marketTargets() }).then((r) => r.map((o) => ({ ...o, external: Boolean(marketTargets().find((t) => t.id === o.office)?.external), requests: [] }))));
route('POST', '/api/market/inspect', async ({ body }) => { const o = marketOffice(body.office); const k = localSkill(o, body.skillId); return market.inspect({ skillDir: k.dir, id: k.id, honorifics: o.honorifics }); });
route('POST', '/api/market/inspect-batch', async ({ body }) => {
  need(Array.isArray(body.items) && body.items.length && body.items.length <= 200, '검사할 항목을 1~200개 선택해 주세요.');
  const results = [];
  for (const item of body.items) {
    try { const o = marketOffice(item.office), k = localSkill(o, item.skillId); results.push({ office: o.id, skillId: k.id, ...(await market.inspect({ skillDir: k.dir, id: k.id, honorifics: o.honorifics })) }); }
    catch (e) { results.push({ office: item?.office, skillId: item?.skillId, error: e.message, status: e.status || 500 }); }
  }
  return { results };
});
route('POST', '/api/market/publish-batch', async ({ body }) => {
  need(Array.isArray(body.items) && body.items.length && body.items.length <= 200, '공유할 항목을 1~200개 선택해 주세요.');
  need(body.items.every(item => item && typeof item.office === 'string' && typeof item.skillId === 'string' && item.office.length && item.skillId.length), '공유할 사무실과 스킬 정보가 올바르지 않습니다.');
  const runBatch = async ctx => {
    ctx?.step('선택한 스킬을 검사하고 게시합니다.');
    const result = await market.publishBatch({ items: body.items, offices: marketOffices(), onProgress: (done, total) => ctx?.progress(done, total) });
    for (const item of result.published) { try { const o = marketOffice(item.office); resolveRequest(o.folder, item.skillId, '게시'); } catch { /* Publication succeeded; request cleanup is secondary. */ } }
    return result;
  };
  return body.async === true ? jobs.start('market-publish-batch', '스킬 일괄 공유', runBatch) : runBatch();
});
route('POST', '/api/market/publish', async ({ body }) => {
  const o = marketOffice(body.office), k = localSkill(o, body.skillId);
  const r = await market.publish({ skillDir: k.dir, id: k.id, version: body.version, localHash: body.localHash, notes: body.notes, honorifics: o.honorifics, confirmWarnings: body.confirmWarnings === true, confirmRisks: body.confirmRisks === true });
  try { if (resolveRequest(o.folder, k.id, '게시')) logChange(o.folder, '마켓 요청', k.id, `봇의 게시 요청을 승인해 v${r.version} 게시`, ''); } catch { /* 요청 파일 정리가 실패해도 게시는 끝났다 */ }
  return r;
});
// 봇이 남긴 게시 요청을 거절한다(요청 파일은 보관함으로 옮긴다).
route('POST', '/api/market/requests/dismiss', async ({ body }) => {
  const o = marketOffice(body.office);
  const n = resolveRequest(o.folder, String(body.skillId || ''), '거절');
  need(n, '해당 게시 요청이 없습니다.', 404);
  logChange(o.folder, '마켓 요청', String(body.skillId), '봇의 게시 요청을 거절', '');
  return { ok: true };
});
route('POST', '/api/market/revoke', async ({ body }) => market.revoke({ id: body.id, reason: body.reason }));
route('POST', '/api/market/install', async ({ body }) => { const o = marketTarget(body.office); return marketRestart(o, await market.install({ id: body.id, office: o, allowRisk: body.allowRisk === true, overwrite: body.overwrite === true })); });
route('POST', '/api/market/uninstall', async ({ body }) => { const o = marketTarget(body.office); return marketRestart(o, await market.uninstall({ id: body.id, office: o })); });

// ── 설치 도우미: 필요한 도구 감지·설치(Claude Code·Bun·Codex·Ollama·Hermes), 로컬 AI 모델 ──
// 설치는 화면에서 사용자가 누를 때만 시작하고, 진행 상황은 작업(jobs)으로 읽는다.
export const jobs = createJobs();
export const components = createComponents({ jobs });
export const ollama = createOllama({ bin: () => cachedOllamaBin });
let cachedOllamaBin = '';
components.detect('ollama').then((d) => { cachedOllamaBin = d.path; }).catch(() => {});
route('GET', '/api/components', async ({ url }) => ({ components: await components.list({ fresh: url.searchParams.get('fresh') === '1' }) }));
route('POST', '/api/components/:id/install', async ({ p }) => { const j = components.install(p.id); return j; });
route('GET', '/api/jobs', async () => ({ jobs: jobs.list() }));
route('GET', '/api/jobs/:id', async ({ p }) => jobs.get(p.id));
route('GET', '/api/ollama', async () => { const d = await components.detect('ollama'); cachedOllamaBin = d.path; return { installed: d.installed, version: d.version, recommended: OLLAMA_RECOMMENDED, ...(d.installed ? await ollama.models() : { running: false, models: [] }) }; });
route('POST', '/api/ollama/pull', async ({ body }) => { const name = String(body.name || '').trim(); return jobs.start('ollama-pull:' + name, '모델 받기: ' + name, (ctx) => ollama.pull(name, ctx)); });

// ── 연결 허브: GPT(ChatGPT 로그인·API 키)·Anthropic·Cloudflare 키. 키 값은 응답에 담지 않는다. ──
export const secrets = createSecrets();
export const connections = createConnections({ components, secrets, ollama, runImpl: run });
route('GET', '/api/connections', async () => connections.status());
route('POST', '/api/connections/codex/login', async () => connections.startCodexLogin());
route('PUT', '/api/connections/keys/:name', async ({ p, body }) => connections.setKey(p.name, body.key));
route('DELETE', '/api/connections/keys/:name', async ({ p }) => connections.clearKey(p.name));
route('GET', '/api/connections/models/:provider', async ({ p }) => connections.models(p.provider));

// ── 봇 스튜디오(LAPIS 런타임 봇): 봇·에이전트·방·주제 설정과 텔레그램 수신 ──
// 엔진은 봇·에이전트마다 고른다(로컬 AI·GPT·Claude·Hermes). 텔레그램 허용(페어링)은 이 화면에서만 바뀐다.
export const tgApi = createTgApi();
export const usage = createUsage({ home: DATA_HOME });
route('GET', '/api/usage', async ({ url }) => usage.query(Object.fromEntries(url.searchParams)));
route('PUT', '/api/usage/pricing', async ({ body }) => usage.setPricing(body));
export const engines = createEngines({ ollama, secrets, components, usage, runImpl: run,
  onAccountingError: failure => console.warn(`[ai-office] 사용량 기록 실패 (${failure.sources.join(', ')}). 원장 저장 상태를 확인해 주세요.`) });
export const bots = createBots({ secrets, tg: tgApi });
export const runtimeBots = createRuntime({ bots, engines, tg: tgApi, log: (m) => console.log(m) });
route('GET', '/api/bots', async () => ({ bots: await bots.listSummaries(), engineTypes: ENGINE_TYPES, agentPresets: AGENT_PRESETS, readiness: await connections.readiness() }));
route('POST', '/api/bots', async ({ body }) => { const b = bots.create(body); return bots.detail(b.id); });
route('GET', '/api/bots/:id', async ({ p }) => ({ ...(await bots.detail(p.id)), runtime: runtimeBots.view(p.id) }));
route('PATCH', '/api/bots/:id', async ({ p, body }) => { bots.update(p.id, body); return bots.detail(p.id); });
route('POST', '/api/bots/:id/close', async ({ p, body }) => { await runtimeBots.stop(p.id); return bots.close(p.id, body.confirmName); });
route('POST', '/api/bots/:id/start', async ({ p }) => runtimeBots.start(p.id));
route('POST', '/api/bots/:id/stop', async ({ p }) => runtimeBots.stop(p.id));
route('POST', '/api/bots/:id/agents', async ({ p, body }) => bots.addAgent(p.id, body));
route('PATCH', '/api/bots/:id/agents/:key', async ({ p, body }) => bots.updateAgent(p.id, p.key, body));
route('DELETE', '/api/bots/:id/agents/:key', async ({ p }) => bots.removeAgent(p.id, p.key));
route('POST', '/api/bots/:id/telegram/token', async ({ p, body }) => bots.saveToken(p.id, body.token));
route('DELETE', '/api/bots/:id/telegram/token', async ({ p }) => { await runtimeBots.stop(p.id); await bots.clearToken(p.id); return { ok: true }; });
route('POST', '/api/bots/:id/telegram/pair', async ({ p, body }) => bots.pair(p.id, body.code));
route('POST', '/api/bots/:id/telegram/deny', async ({ p, body }) => { bots.deny(p.id, body.code); return { ok: true }; });
route('POST', '/api/bots/:id/telegram/remove', async ({ p, body }) => { bots.removeSender(p.id, body.senderId); return { ok: true }; });
route('POST', '/api/bots/:id/telegram/policy', async ({ p, body }) => { bots.setPolicy(p.id, body.mode); return { ok: true }; });
route('POST', '/api/bots/:id/telegram/rooms/:chat', async ({ p, body }) => bots.setRoom(p.id, p.chat, body));
route('DELETE', '/api/bots/:id/telegram/rooms/:chat', async ({ p }) => { bots.forgetRoom(p.id, p.chat); return { ok: true }; });
route('POST', '/api/bots/:id/telegram/rooms/:chat/topics/:thread', async ({ p, body }) => bots.setTopic(p.id, p.chat, p.thread, body));
// LAPIS_CF_BASE 는 개발·시험용(가짜 Cloudflare 서버로 돌려 볼 때)이다.
export const publisher = createPublisher({ bots, secrets, tg: tgApi, stopLocal: (id) => runtimeBots.stop(id), cfBase: process.env.LAPIS_CF_BASE || undefined });
// 웹 배포(Cloudflare Workers): 올리기는 화면에서 사용자가 누를 때만. 비밀번호는 보기 요청(POST)으로만 돌려준다.
route('GET', '/api/bots/:id/publish', async ({ p }) => ({ plan: await publisher.plan(p.id), status: publisher.status(p.id) }));
route('POST', '/api/bots/:id/publish', async ({ p, body }) => jobs.start('publish:' + p.id, '웹 배포', (ctx) => publisher.deploy(p.id, body, ctx)));
route('POST', '/api/bots/:id/publish/password', async ({ p }) => ({ password: await publisher.revealPassword(p.id) }));
route('POST', '/api/bots/:id/publish/restore-local', async ({ p }) => publisher.restoreLocal(p.id));
route('DELETE', '/api/bots/:id/publish', async ({ p }) => publisher.remove(p.id));
route('GET', '/api/bots/:id/skills', async ({ p }) => ({ skills: bots.listSkills(p.id) }));
route('POST', '/api/bots/:id/skills', async ({ p, body }) => bots.saveSkill(p.id, body));
route('DELETE', '/api/bots/:id/skills/:skill', async ({ p }) => bots.removeSkill(p.id, p.skill));
// 텔레그램 없이 엔진 설정을 바로 시험한다(역할을 고르면 그 역할로 답한다).
route('POST', '/api/bots/:id/test', async ({ p, body }) => {
  const b = bots.load(p.id);
  const text = String(body.message || '').trim();
  need(text && text.length <= 4000, '시험 문장을 1~4,000자로 적어 주세요.');
  const picked = body.agent ? { agent: b.agents.find((a) => a.key === body.agent) || null, text } : pickAgent(b, { text });
  const engine = picked.agent?.engine?.type ? picked.agent.engine : b.engine;
  const system = buildSystem(b, { agent: picked.agent, skillsDir: bots.skillsDir(p.id) });
  const answer = await engines.complete({ engine, system, messages: [{ role: 'user', content: picked.text }], cwd: join(bots.folder(p.id), 'work'), access: picked.agent?.access || b.access,
    context: { botId: p.id, botName: b.name, agentKey: picked.agent?.key || '' } });
  return { answer, agent: picked.agent?.key || '', engine };
});

// ── 프로그램 업데이트 ── 감지는 자동(6시간마다), 설치는 사용자가 누를 때만(설정에서 「자동 설치」를 켠 경우 제외).
route('POST', '/api/update/check', async () => updater.check());
route('POST', '/api/update/apply', async () => updater.apply());

route('POST', '/api/diagnostics/refresh', async () => { const v = await diagnostics(true); return { pollers: v.pollers }; });
route('POST', '/api/diagnostics/clean-pollers', async () => { const r = await tg.cleanRoguePollers(); await diagnostics(true); return r; });
route('POST', '/api/diagnostics/disable-global-plugin', async () => tg.disableGlobalPlugin());

// ── 서버 ──
// 모든 응답에 붙이는 보안 헤더: 다른 사이트가 이 화면을 액자(iframe)로 끼워 클릭을 가로채거나, 파일 형식을 속이거나, 주소를 흘리지 못하게 한다.
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = resolve(WEB, rel);
  if (file !== resolve(WEB) && !file.startsWith(resolve(WEB) + sep)) { res.writeHead(403); return res.end(); }
  try {
    if (!statSync(file).isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}

export function startServer({ port, updater: custom, updateCheck = true } = {}) {
  port = port || getConfig().port;
  if (custom) updater = custom;   // 테스트용: 인터넷 대신 가짜 업데이트 도구를 끼운다
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(421); return res.end(); }   // DNS 리바인딩 방지
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith('/api/')) return req.method === 'GET' ? serveStatic(url, res) : (res.writeHead(405), res.end());
    try {
      let hit = null, params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { hit = r; params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); break; }
      }
      if (!hit) throw new HttpError(404, '알 수 없는 요청입니다.');
      let body = {};
      if (req.method !== 'GET') {
        if (!trusted(req, port)) throw new HttpError(403, '대시보드 화면에서만 조작할 수 있습니다.');
        body = await readBody(req);
      }
      send(res, 200, (await hit.handler({ p: params, body, url })) ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, e.details === undefined ? { error: e.message } : { error: e.message, details: e.details });
      console.error('[ai-office]', e);
      send(res, 500, { error: '처리 중 오류가 났습니다. 로그를 확인해 주세요.' });
    }
  });

  // 시작할 때 사무실 설정 경로를 현재 설치 위치로 맞추고, 주기적으로 자동 복구를 돌린다.
  const relink = () => { try { for (const r of autoRelink()) console.log(`[ai-office] 사무실 위치가 바뀐 것을 찾아 따라갔습니다: ${r.from} → ${r.to}`); } catch (e) { console.error(e); } };
  relink();
  try { for (const o of listOffices()) if (o.kind === 'claude-office' && o.stateDir && lr.repairLegacy(o.stateDir)) console.log('[ai-office] 예전 방 설정(rooms.json)의 불필요한 항목을 정리했습니다.'); } catch (e) { console.error(e); }
  try { const fixed = repairOffices(); if (fixed.length) console.log(`[ai-office] 사무실 설정 경로를 다시 맞췄습니다: ${fixed.join(', ')}`); } catch (e) { console.error(e); }
  // 업데이트 등으로 디스크의 프로그램이 이 엔진보다 새 버전이 되면(옛 코드가 계속 도는 것을 막기 위해) 스스로 새 코드로 다시 시작한다.
  const staleCheck = createStaleWatcher({ loaded: pkg.version, restart: () => restartEngine(CLI, port), busy: () => updater.view().applying, log: (m) => console.log(m) });
  const timer = setInterval(async () => {
    try {
      staleCheck();
      relink();
      const d = await diagnostics();
      const acts = await watchdogTick({ autoRestart: getConfig().autoRestart, legitPollers: legitCount(d) });
      for (const a of acts) console.log('[ai-office] 감시:', JSON.stringify(a));
    } catch (e) { console.error('[ai-office] 감시 오류', e.message); }
  }, 15000);
  timer.unref?.();
  // 스킬 마켓이 연결되어 있으면 10분마다 원격의 새 스킬·새 버전 목록만 받아 온다(설치·업데이트는 사용자가 누를 때만).
  const marketTimer = setInterval(() => { market.autoSync().catch((e) => console.error('[ai-office] 마켓 새로고침 실패', e.message)); }, 60000);
  marketTimer.unref?.();

  // 새 버전 감지: 시작 30초 뒤 한 번, 이후 6시간마다. 「자동 설치」를 켠 경우에만 감지 즉시 설치한다(같은 버전은 한 번만 시도).
  let autoTried = '';
  const updateTick = async () => {
    try {
      const v = await updater.check();
      if (getConfig().autoUpdate && v.available && v.canApply && v.latest.version !== autoTried) {
        autoTried = v.latest.version;
        console.log(`[ai-office] 새 버전 ${v.latest.version} 을 자동으로 설치합니다.`);
        await updater.apply();
      }
    } catch (e) { console.error('[ai-office] 업데이트 확인 실패', e.message); }
  };
  if (updateCheck) {
    setTimeout(updateTick, 30000).unref?.();
    setInterval(updateTick, 6 * 60 * 60 * 1000).unref?.();
  }

  components.list().catch(() => {});   // 도구 감지를 미리 데워 두면 첫 화면이 빨리 열린다
  runtimeBots.startAll().catch((e) => console.error('[ai-office] 봇 자동 시작 실패', e.message));
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok({ server, port }));
  });
}
