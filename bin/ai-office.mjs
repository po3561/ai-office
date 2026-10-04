#!/usr/bin/env node
// AI-Office 명령줄
//   ai-office serve [--port N]        대시보드 서버 실행(창 없이)
//   ai-office open                    서버가 없으면 켜고, 대시보드 창을 연다
//   ai-office app [--tray]            앱 실행: 엔진과 LAPIS 대시보드를 창 없이 켜고 앱 창을 연다(--tray 는 창 없이 켜기만)
//   ai-office stop                    서버 끄기(엔진·대시보드)
//   ai-office office list|create|import|remove|restart …
//   ai-office team   list|add|update|remove|presets --office <id> …   (비서실장 봇도 이 명령으로 부서를 관리한다)
//   ai-office permit list|add|remove --office <id> …   (사용자가 텔레그램으로 허용한 좁은 규칙만 봇이 이 명령으로 연다)
//   ai-office drive  list|grant|revoke --office <id> …  (D 드라이브 등을 사무실이 읽고·쓰고·지울 수 있게 사용자가 직접 맡긴다)
//   ai-office doctor                  설치·로그인·텔레그램 상태 점검
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CLI, APP_HOME, DATA_HOME, LOG_DIR } from '../src/paths.mjs';
const DASH_PORT = Number(process.env.LAPIS_DASHBOARD_PORT) || 4310;
const DASH_ENTRY = join(APP_HOME, 'dashboard', 'src', 'server.mjs');
import { getConfig } from '../src/config.mjs';
import { PRESETS } from '../src/presets.mjs';
import { isWindows, run, HttpError, isDir } from '../src/util.mjs';
import { mkdirSync, openSync, existsSync } from 'node:fs';

const [, , cmd, sub, ...rest] = process.argv;

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

const fail = (msg, code = 1) => { console.error(`⚠️ ${msg}`); process.exit(code); };

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.app === 'ai-office' ? j : null;
  } catch { return null; }
}

async function ensureServer(port) {
  if (await ping(port)) return true;
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'server.log'), 'a');
  spawn(process.execPath, [CLI, 'serve', '--port', String(port)], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 300)); if (await ping(port)) return true; }
  return false;
}

async function pingDashboard() {
  try {
    const r = await fetch(`http://127.0.0.1:${DASH_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'lapis-office-dashboard';
  } catch { return false; }
}

// LAPIS 대시보드(화면)를 창 없이 켠다. 엔진 주소와 데이터 폴더는 환경 값으로 넘긴다.
async function ensureDashboard(enginePort) {
  if (await pingDashboard()) return true;
  if (!existsSync(DASH_ENTRY)) return false;
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, 'dashboard.log'), 'a');
  const env = { ...process.env, LAPIS_DASHBOARD_PORT: String(DASH_PORT), LAPIS_OFFICE_URL: `http://127.0.0.1:${enginePort}`, LAPIS_DATA_DIR: join(DATA_HOME, 'lapis'), LAPIS_CONFIG: process.env.LAPIS_CONFIG || join(DATA_HOME, 'lapis-config.json') };
  spawn(process.execPath, ['--no-warnings', DASH_ENTRY], { cwd: join(APP_HOME, 'dashboard'), env, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 300)); if (await pingDashboard()) return true; }
  return false;
}

// 앱 창(주소창 없는 창)으로 연다. Edge → Chrome → 기본 브라우저 순서.
function openWindow(url) {
  if (!isWindows) { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref(); return; }
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const cands = pf.flatMap((p) => [join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
  import('node:fs').then(({ existsSync }) => {
    const exe = cands.find((c) => existsSync(c));
    if (exe) spawn(exe, [`--app=${url}`, '--window-size=1280,860', `--user-data-dir=${join(DATA_HOME, 'window')}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
}

const line = (s = '') => console.log(s);

async function main() {
  const cfg = getConfig();
  switch (cmd) {
    case 'serve': {
      const f = flags([sub, ...rest].filter(Boolean));
      const port = Number(f.port) || cfg.port;
      if (await ping(port)) { line(`이미 실행 중입니다: http://127.0.0.1:${port}`); return; }
      const { startServer } = await import('../src/server.mjs');
      try { await startServer({ port }); } catch (e) {
        if (e.code === 'EADDRINUSE') fail(`포트 ${port} 를 다른 프로그램이 쓰고 있습니다. 설정에서 포트를 바꿔 주세요.`);
        throw e;
      }
      line(`AI-Office 대시보드: http://127.0.0.1:${port}`);
      return;   // 서버가 계속 살아 있다
    }
    case 'open': {
      if (!(await ensureServer(cfg.port))) fail('대시보드 서버를 시작하지 못했습니다. 로그: ' + join(LOG_DIR, 'server.log'));
      openWindow(`http://127.0.0.1:${cfg.port}/`);
      return;
    }
    case 'app': {
      const f = flags([sub, ...rest].filter(Boolean));
      if (!(await ensureServer(cfg.port))) fail('엔진을 시작하지 못했습니다. 로그: ' + join(LOG_DIR, 'server.log'));
      const dash = await ensureDashboard(cfg.port);
      if (!dash) { line('LAPIS 화면 파일이 없어 기본 대시보드를 엽니다.'); if (!f.tray) openWindow(`http://127.0.0.1:${cfg.port}/`); return; }
      if (!f.tray) openWindow(`http://127.0.0.1:${DASH_PORT}/`);
      return;
    }
    case 'stop': {
      // 우리 서버로 확인된 포트만 끈다(다른 프로그램이 쓰는 포트는 건드리지 않는다).
      const ports = [];
      if (await ping(cfg.port)) ports.push(cfg.port);
      if (await pingDashboard()) ports.push(DASH_PORT);
      if (!ports.length) { line('실행 중인 서버가 없습니다.'); return; }
      if (isWindows) {
        const r = await run('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${ports.join(',')} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`]);
        line(r.code === 0 ? '서버를 껐습니다.' : '서버를 끄지 못했습니다.');
      } else line('터미널에서 서버 프로세스를 종료해 주세요.');
      return;
    }
    case 'office': return officeCmd(sub, flags(rest));
    case 'team': return teamCmd(sub, flags(rest));
    case 'permit': return permitCmd(sub, flags(rest));
    case 'drive': return driveCmd(sub, flags(rest));
    case 'doctor': return doctor();
    default:
      line('사용법: ai-office <app|serve|open|stop|office|team|permit|drive|doctor>');
      line('  office list | create --name 이름 [--honorific 호칭] [--presets a,b] | import --folder 경로 [--name 이름] | remove --office id | restart --office id [--delay 초]');
      line('  team   list|add|update|remove|presets --office id …');
      line('  permit list|add|remove --office id [--rule 규칙 --reason 이유 --approved 사용자 승인 답장]');
      line('  drive  list|grant|revoke --office id [--path D:\\ --level readwrite|full --yes]   (사용자가 직접 실행. 봇은 쓸 수 없다)');
      process.exit(cmd ? 1 : 0);
  }
}

async function officeCmd(action, f) {
  const O = await import('../src/offices.mjs');
  const R = await import('../src/runner.mjs');
  switch (action) {
    case 'list': {
      const list = O.listOffices();
      if (!list.length) return line('등록된 사무실이 없습니다. `ai-office office create --name 이름` 으로 만들 수 있습니다.');
      for (const o of list) line(`- ${o.id}  ${o.name}  [${o.kind}${o.readonly || o.kind === 'hermes' ? ', 읽기 전용' : ''}]\n    ${o.folder}`);
      return;
    }
    case 'create': {
      const o = O.createOffice({ name: f.name, honorific: f.honorific, presets: f.presets ? String(f.presets).split(',').map((s) => s.trim()).filter(Boolean) : undefined });
      line(`사무실을 만들었습니다: ${o.name} (${o.id})\n  폴더: ${o.folder}`);
      return;
    }
    case 'import': {
      const o = O.importOffice({ name: f.name, folder: f.folder, kind: f.kind });
      line(`불러왔습니다: ${o.name} (${o.id}) [${o.kind}${o.readonly ? ', 읽기 전용' : ''}]`);
      return;
    }
    case 'remove': line(`등록을 해제했습니다(폴더는 그대로): ${O.unregisterOffice(need(f.office, '--office 가 필요합니다')).name}`); return;
    case 'restart': {
      const r = R.requestRestart(await resolveOffice(f.office), f.delay);
      await ensureServer(cfg.port);   // 재시작은 대시보드 서버가 처리하므로 꺼져 있으면 켠다
      line(`${r.inSec}초 안에 다시 출근해 변경 사항을 적용합니다.`);
      return;
    }
    default: fail('office 하위 명령: list | create | import | remove | restart');
  }
}

function need(v, msg) { if (!v || v === true) fail(msg); return v; }

// --office 를 생략하면, 사무실 폴더 안에서 실행한 경우 그 폴더의 사무실을 쓴다(비서실장 봇이 이 경우).
function resolveOffice(id) {
  return import('../src/offices.mjs').then((O) => {
    const list = O.listOffices();
    if (id && id !== true) { const hit = list.find((o) => o.id === id || o.name === id); if (hit) return hit.id; fail(`등록되지 않은 사무실입니다: ${id}`); }
    const here = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).toLowerCase();
    const hit = list.find((o) => here.startsWith(o.folder.toLowerCase()));
    if (hit) return hit.id;
    if (list.length === 1) return list[0].id;
    fail('--office <id> 를 지정해 주세요. (`ai-office office list` 로 확인)');
  });
}

async function teamCmd(action, f) {
  const T = await import('../src/teams.mjs');
  const O = await import('../src/offices.mjs');
  if (action === 'presets') {
    for (const p of PRESETS) line(`${p.emoji} ${p.key.padEnd(12)} ${p.name} — ${p.role}`);
    return;
  }
  const id = await resolveOffice(f.office);
  const office = O.mutable(id);
  switch (action) {
    case 'list': {
      const teams = T.listTeams(office.folder);
      line(`${office.name} — 부서 ${teams.length}개`);
      for (const t of teams) line(`${t.emoji} ${t.key.padEnd(18)} ${t.name} — ${t.role}`);
      return;
    }
    case 'add': {
      const t = T.addTeam(office.folder, { preset: f.preset, key: f.key, name: f.name, role: f.role, emoji: f.emoji, instructions: f.instructions, model: f.model, request: f.request });
      line(`부서를 추가했습니다: ${t.emoji} ${t.name} (${t.key}) — ${t.role}`);
      line('새 부서는 사무실을 다시 출근시킨 뒤부터 호출할 수 있습니다. (`ai-office office restart`)');
      return;
    }
    case 'update': {
      const patch = {};
      for (const k of ['name', 'role', 'emoji', 'instructions', 'model', 'description']) if (typeof f[k] === 'string') patch[k] = f[k];
      const t = T.updateTeam(office.folder, need(f.key, '--key 가 필요합니다'), patch);
      line(`부서를 수정했습니다: ${t.emoji} ${t.name} (${t.key})`);
      return;
    }
    case 'remove': {
      const t = T.removeTeam(office.folder, need(f.key, '--key 가 필요합니다'), f.request || '');
      line(`부서를 없앴습니다(파일은 보관함/부서보관에 있습니다): ${t.name} (${t.key})`);
      return;
    }
    default: fail('team 하위 명령: list | add | update | remove | presets');
  }
}

// 막힌 작업을 풀 허용 규칙. 봇은 사용자가 텔레그램으로 허용한 뒤에만 add 를 실행한다(지침 CLAUDE.md "권한 열기").
async function permitCmd(action, f) {
  const P = await import('../src/permits.mjs');
  const O = await import('../src/offices.mjs');
  const office = O.mutable(await resolveOffice(f.office));
  const str = (v) => (typeof v === 'string' ? v : '');
  switch (action) {
    case 'list': {
      const rules = P.listPermits(office.folder);
      line(`${office.name} — 따로 열어 둔 허용 규칙 ${rules.length}개`);
      for (const r of rules) line(`- ${r}`);
      return;
    }
    case 'add': {
      const r = P.addPermit(office.folder, { rule: str(f.rule), reason: str(f.reason), approved: str(f.approved) });
      line(r.added ? `허용 규칙을 열었습니다: ${r.rule}` : `이미 열려 있는 규칙입니다: ${r.rule}`);
      line('보통 바로 적용됩니다. 그래도 같은 작업이 막히면 `ai-office office restart` 로 다시 출근시켜 주세요.');
      return;
    }
    case 'remove': {
      const r = P.removePermit(office.folder, str(f.rule));
      line(`허용 규칙을 닫았습니다: ${r.rule}`);
      return;
    }
    default: fail('permit 하위 명령: list | add | remove');
  }
}

// 드라이브 접근 부여. 사용자가 직접 실행한다(견본이 봇의 이 명령 실행을 막는다). 대시보드 「설정 → 드라이브 접근」과 같은 기능이다.
async function driveCmd(action, f) {
  const D = await import('../src/drives.mjs');
  const O = await import('../src/offices.mjs');
  const office = O.mutable(await resolveOffice(f.office));
  const str = (v) => (typeof v === 'string' ? v : '');
  switch (action) {
    case 'list': {
      const grants = D.listGrants(office.folder);
      line(`${office.name} — 접근을 맡긴 위치 ${grants.length}곳`);
      for (const g of grants) line(`- ${g.path}  ${D.LEVELS[g.level]}`);
      return;
    }
    case 'grant': {
      const level = str(f.level) || 'readwrite';
      if (level === 'full' && f.yes !== true) fail('삭제까지 맡기는 것은 되돌릴 수 없는 권한입니다. 확인했다면 --yes 를 붙여 다시 실행해 주세요.');
      const g = D.setGrant(office.folder, { path: str(f.path), level, via: '터미널' });
      line(`접근을 맡겼습니다: ${g.path} — ${D.LEVELS[g.level]}`);
      line('사무실이 근무 중이면 `ai-office office restart` 로 다시 출근시켜야 새 지침이 적용됩니다.');
      return;
    }
    case 'revoke': {
      const r = D.removeGrant(office.folder, str(f.path), '터미널');
      line(`접근을 거뒀습니다: ${r.path}`);
      line('사무실이 근무 중이면 `ai-office office restart` 로 다시 출근시켜 주세요.');
      return;
    }
    default: fail('drive 하위 명령: list | grant | revoke');
  }
}

async function doctor() {
  const { claudeInfo } = await import('../src/claude.mjs');
  const T = await import('../src/telegram.mjs');
  const O = await import('../src/offices.mjs');
  line(`AI-Office ${(await import('node:fs')).readFileSync(join(APP_HOME, 'package.json'), 'utf8').match(/"version": "([^"]+)"/)[1]}`);
  line(`프로그램: ${APP_HOME}\n데이터:   ${DATA_HOME}`);
  line(`Node.js:  ${process.version}`);
  const c = await claudeInfo({ fresh: true });
  line(c.installed ? `Claude Code: ${c.version} — ${c.auth.loggedIn ? `로그인됨(${c.auth.email}, ${c.auth.plan || c.auth.method})` : '로그인 필요 (`claude auth login`)'}` : 'Claude Code: 설치 안 됨 (`npm install -g @anthropic-ai/claude-code`)');
  const bun = await run(isWindows ? 'where.exe' : 'which', ['bun']);
  line(`Bun(텔레그램 플러그인 실행에 필요): ${bun.code === 0 ? bun.stdout.split(/\r?\n/)[0] : '없음 — winget install Oven-sh.Bun'}`);
  if (T.globalPluginEnabled()) line('⚠️ 텔레그램 플러그인이 전역으로 켜져 있어 다른 Claude 창이 수신을 가로챌 수 있습니다. 대시보드 「연결」에서 끌 수 있습니다.');
  const d = await T.listPollers();
  const rogue = (d.pollers || []).filter((p) => !p.legit);
  line(`텔레그램 수신 프로세스: ${(d.pollers || []).length}개${rogue.length ? ` — 사무실이 아닌 곳에서 띄운 것 ${rogue.length}개(수신을 가로챌 수 있음)` : ''}`);
  line(`사무실 ${O.listOffices().length}개 등록`);
  if (!isDir(DATA_HOME)) line('(아직 데이터 폴더가 없습니다. 첫 실행 때 만들어집니다.)');
}

main().catch((e) => {
  if (e instanceof HttpError) fail(e.message);
  console.error(e); process.exit(1);
});
