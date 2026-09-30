// 사무실(=봇 하나가 일하는 분리된 환경 폴더) 등록부: 만들기·불러오기·찾기·해제·점검.
//   claude-office : Claude Code 로 돌아가는 사무실. 이 프로그램이 만들거나(managed) 기존 폴더를 불러온 것.
//   hermes        : Hermes(라피스 등) 같은 별개의 봇. **읽기 전용** — 인식해서 보여 주기만 하고 어떤 것도 바꾸거나 실행하지 않는다.
import { join, resolve, basename } from 'node:path';
import { readdirSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { FILES, OFFICES_DIR, TEMPLATES, CLI, STATUS_HOOK, DEFAULT_TG_STATE } from './paths.mjs';
import { readText, readJson, writeJson, writeAtomic, isDir, isFile, nowIso, localDate, need, slug, fwd, HttpError } from './util.mjs';
import { getConfig } from './config.mjs';
import { addTeam, saveOffice, loadOffice, renderTeamsBlock, syncClaudeMd } from './teams.mjs';
import { DEFAULT_PRESETS } from './presets.mjs';

const KINDS = ['claude-office', 'hermes'];
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// ── 등록부 ──
export function readRegistry() {
  const r = readJson(FILES.offices, null);
  return r && Array.isArray(r.offices) ? r : { offices: [] };
}
const writeRegistry = (r) => writeJson(FILES.offices, r);

export const listOffices = () => readRegistry().offices;

export function getOffice(id) {
  const o = listOffices().find((x) => x.id === id);
  need(o, `등록되지 않은 사무실입니다: ${id}`, 404);
  return o;
}

// 읽기 전용 봇에 대한 모든 변경 시도를 여기서 막는다.
export function mutable(id) {
  const o = getOffice(id);
  need(o.kind !== 'hermes' && !o.readonly, `"${o.name}"은(는) 별개의 봇이라 읽기 전용입니다. 이 프로그램은 인식만 하고 바꾸지 않습니다.`, 403);
  return o;
}

export function updateOffice(id, patch) {
  const reg = readRegistry();
  const o = reg.offices.find((x) => x.id === id);
  need(o, `등록되지 않은 사무실입니다: ${id}`, 404);
  if ('name' in patch) { const n = String(patch.name || '').trim(); need(n && n.length <= 40, '이름은 1~40자로 적어 주세요.'); o.name = n; }
  if ('autoStart' in patch) o.autoStart = Boolean(patch.autoStart);
  writeRegistry(reg);
  return o;
}

export function unregisterOffice(id) {
  const reg = readRegistry();
  const i = reg.offices.findIndex((x) => x.id === id);
  need(i >= 0, `등록되지 않은 사무실입니다: ${id}`, 404);
  const [gone] = reg.offices.splice(i, 1);
  writeRegistry(reg);
  return gone;
}

function uniqueId(base, reg) {
  let id = slug(base) || 'office', n = 2;
  const taken = (x) => reg.offices.some((o) => o.id === x) || isDir(join(OFFICES_DIR, x));
  const root = id;
  while (taken(id)) id = `${root}-${n++}`;
  return id;
}

// ── 견본 복사 ──
const TEXT_EXT = /\.(md|json|txt|csv)$/i;

export function renderTemplate(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function copyTemplate(src, dst, vars) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name), to = join(dst, e.name);
    if (e.isDirectory()) copyTemplate(from, to, vars);
    else if (TEXT_EXT.test(e.name)) writeAtomic(to, renderTemplate(readText(from), vars));
    else copyFileSync(from, to);
  }
}

function templateVars(office) {
  const d = new Date();
  return {
    OFFICE_NAME: office.name, HONORIFIC: office.honorific, OFFICE_ID: office.id,
    CLI: fwd(CLI), HOOK: fwd(STATUS_HOOK), TODAY: localDate(d),
    TODAY_LONG: `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.(${WEEKDAY[d.getDay()]})`,
    TEAMS_BLOCK: renderTeamsBlock([]),
  };
}

// ── 새 사무실 만들기 ──
export function createOffice({ name, honorific, presets } = {}) {
  name = String(name || '').trim();
  need(name && name.length <= 40, '사무실 이름을 1~40자로 적어 주세요.');
  honorific = String(honorific || getConfig().honorific).trim();
  need(honorific.length >= 1 && honorific.length <= 20 && !/[<>&"\n\r]/.test(honorific), '호칭은 1~20자로 적어 주세요.');
  const keys = Array.isArray(presets) ? presets : DEFAULT_PRESETS;
  const reg = readRegistry();
  const id = uniqueId(name, reg);
  const folder = join(OFFICES_DIR, id);
  const office = { id, name, kind: 'claude-office', folder, stateDir: join(folder, '.telegram'), managed: true, autoStart: false, honorific, createdAt: nowIso() };

  copyTemplate(join(TEMPLATES, 'office'), folder, templateVars(office));
  for (const d of ['결과물', '업무일지', '보관함', join('업무데이터', '맞춤설정'), '.telegram']) mkdirSync(join(folder, d), { recursive: true });
  saveOffice(folder, { version: 1, name, honorific, appHome: fwd(resolve(CLI, '..', '..')), createdAt: office.createdAt, teams: [] });
  for (const k of keys) addTeam(folder, { preset: k });

  reg.offices.push(office);
  writeRegistry(reg);
  return office;
}

// ── 기존 폴더 불러오기 ──
export function importOffice({ name, folder, kind } = {}) {
  const dir = resolve(String(folder || '').trim().replace(/^"|"$/g, ''));
  need(isDir(dir), `폴더를 찾을 수 없습니다: ${dir}`);
  const detected = detectKind(dir);
  kind = kind && kind !== 'auto' ? kind : detected;
  need(KINDS.includes(kind), '폴더 종류를 알 수 없습니다. Claude 사무실(.claude 폴더가 있는 곳)이나 Hermes 프로필 폴더를 골라 주세요.');
  const reg = readRegistry();
  need(!reg.offices.some((o) => resolve(o.folder).toLowerCase() === dir.toLowerCase()), '이미 등록된 폴더입니다.');
  const label = String(name || '').trim() || basename(dir);
  need(label.length <= 40, '이름은 40자 이내로 적어 주세요.');
  const id = uniqueId(label, reg);
  let office;
  if (kind === 'hermes') {
    office = { id, name: label, kind, folder: dir, managed: false, readonly: true, note: '별개의 봇 — 읽기 전용(인식만 합니다)', createdAt: nowIso() };
  } else {
    const own = join(dir, '.telegram');
    const script = join(dir, '.system', 'scripts', 'start-office.ps1');
    const stop = join(dir, '.system', 'scripts', 'stop-office.ps1');
    office = {
      id, name: label, kind, folder: dir, managed: false, autoStart: false, createdAt: nowIso(),
      stateDir: isDir(own) ? own : DEFAULT_TG_STATE,
      sharedTelegramState: !isDir(own),
      ...(isFile(script) ? { launch: { start: script, stop: isFile(stop) ? stop : null } } : {}),
    };
  }
  reg.offices.push(office);
  writeRegistry(reg);
  return office;
}

export function detectKind(dir) {
  if (isDir(join(dir, '.claude')) || isFile(join(dir, 'CLAUDE.md'))) return 'claude-office';
  if (isFile(join(dir, 'gateway_state.json')) || (isDir(join(dir, 'skills')) && isFile(join(dir, 'config.yaml')))) return 'hermes';
  return null;
}

// 이 PC에서 불러올 수 있는 사무실·봇 후보를 찾는다(등록은 사용자가 고른 것만).
export function discover() {
  const home = homedir();
  const roots = [join(home, 'Desktop'), join(home, 'Documents'), OFFICES_DIR];
  const seen = new Set(listOffices().map((o) => resolve(o.folder).toLowerCase()));
  const out = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let names = [];
    try { names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const n of names) {
      const dir = join(root, n);
      if (seen.has(resolve(dir).toLowerCase())) continue;
      if (isDir(join(dir, '.claude', 'agents')) && isFile(join(dir, 'CLAUDE.md'))) out.push({ kind: 'claude-office', name: n, folder: dir, reason: '에이전트(.claude/agents)와 CLAUDE.md 가 있는 사무실' });
    }
  }
  const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const profiles = join(localApp, 'hermes', 'profiles');
  if (isDir(profiles)) {
    for (const e of readdirSync(profiles, { withFileTypes: true })) {
      const dir = join(profiles, e.name);
      if (e.isDirectory() && !seen.has(resolve(dir).toLowerCase()) && isDir(join(dir, 'skills'))) out.push({ kind: 'hermes', name: e.name, folder: dir, reason: 'Hermes 봇 프로필 (읽기 전용으로만 인식)' });
    }
  }
  return out;
}

// 프로그램을 다른 위치로 옮기거나 다시 설치해도 사무실이 계속 돌아가도록,
// 이 프로그램이 만든 사무실의 훅·허용 명령 경로를 현재 설치 위치로 다시 맞춘다.
export function repairOffices() {
  const fixed = [];
  for (const o of listOffices()) {
    if (!o.managed || o.kind !== 'claude-office' || !isDir(o.folder)) continue;
    try {
      const file = join(o.folder, '.claude', 'settings.json');
      const cur = readJson(file, null);
      const office = loadOffice(o.folder);
      const vars = { ...templateVars({ ...o, honorific: office.honorific || getConfig().honorific }) };
      const tpl = JSON.parse(renderTemplate(readText(join(TEMPLATES, 'office', '.claude', 'settings.json')), vars));
      const wantHooks = JSON.stringify(tpl.hooks);
      if (cur && JSON.stringify(cur.hooks) === wantHooks && (cur.permissions?.allow || []).some((a) => a.includes(vars.CLI))) continue;
      const next = cur || tpl;
      next.hooks = tpl.hooks;
      next.permissions ||= { allow: [], deny: [] };
      const keep = (next.permissions.allow || []).filter((a) => !/ai-office\.mjs/.test(a));
      next.permissions.allow = [...keep, ...tpl.permissions.allow.filter((a) => /ai-office\.mjs/.test(a))];
      next.permissions.deny = [...new Set([...(next.permissions.deny || []), ...tpl.permissions.deny])];
      writeJson(file, next);
      saveOffice(o.folder, { ...office, appHome: fwd(resolve(CLI, '..', '..')) });
      fixed.push(o.id);
    } catch { /* 한 사무실의 문제가 다른 사무실 점검을 막지 않게 한다 */ }
  }
  return fixed;
}

// 예전 위치(바탕화면 등)의 사무실을 고정 위치로 복사해 옮긴다. 원본은 지우지 않는다.
export function migrateOffice(id) {
  const o = mutable(id);
  need(o.kind === 'claude-office', 'Claude 사무실만 옮길 수 있습니다.');
  need(!resolve(o.folder).toLowerCase().startsWith(resolve(OFFICES_DIR).toLowerCase()), '이미 고정 위치에 있습니다.');
  const target = join(OFFICES_DIR, uniqueId(basename(o.folder), readRegistry()));
  mkdirSync(OFFICES_DIR, { recursive: true });
  cpSync(o.folder, target, { recursive: true, filter: (p) => !/[\\/](node_modules|\.wrangler|\.git)([\\/]|$)/.test(p) });
  const reg = readRegistry();
  const rec = reg.offices.find((x) => x.id === id);
  rec.previousFolder = o.folder;
  rec.folder = target;
  if (rec.sharedTelegramState !== true) rec.stateDir = join(target, '.telegram');
  if (rec.launch) rec.launch = { start: join(target, '.system', 'scripts', 'start-office.ps1'), stop: rec.launch.stop ? join(target, '.system', 'scripts', 'stop-office.ps1') : null };
  writeRegistry(reg);
  return { id, from: o.folder, to: target };
}

export { HttpError, syncClaudeMd };
