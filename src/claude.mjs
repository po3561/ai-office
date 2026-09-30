// Claude Code 설치 확인과 계정 로그인 상태.
// 로그인은 Claude Code 자신의 공식 로그인(`claude auth login`, 브라우저 인증)만 사용한다.
// 이 프로그램은 비밀번호·토큰을 입력받거나 저장하지 않고, 로그인 파일도 읽지 않는다.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { run, isFile, isDir, isWindows, need, psQuote } from './util.mjs';

let cachedBin = null;
let brokenBin = null;      // 파일은 있는데 실행되지 않는 경우(원인 표시용)
let authCache = { at: 0, value: null };

const firstLine = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';

// 실행 파일을 직접 돌려 본다. .cmd/.bat 는 cmd.exe 를 거쳐야 한다.
function exec(bin, args, opts = {}) {
  // /s 는 명령 전체를 감싼 바깥 따옴표 한 쌍을 벗기므로, 공백·한글 경로를 위해 한 번 더 감싼다.
  if (bin.cmd) return run('cmd.exe', ['/d', '/s', '/c', `""${bin.path}" ${args.join(' ')}"`], { ...opts, verbatim: true });
  return run(bin.path, args, opts);
}

async function candidates() {
  const c = [];
  if (process.env.AI_OFFICE_CLAUDE) c.push(process.env.AI_OFFICE_CLAUDE);
  if (isWindows) {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    c.push(join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    const w = await run('where.exe', ['claude.exe']);
    if (w.code === 0) c.push(...w.stdout.split(/\r?\n/).filter(Boolean));
    c.push(join(homedir(), '.local', 'bin', 'claude.exe'));
    const cmd = await run('where.exe', ['claude.cmd']);
    if (cmd.code === 0) c.push(...cmd.stdout.split(/\r?\n/).filter(Boolean));
    // Claude 데스크톱 앱이 함께 설치하는 Claude Code(가장 높은 버전부터)
    const bundled = join(appdata, 'Claude', 'claude-code');
    if (isDir(bundled)) {
      const vers = readdirSync(bundled).filter((v) => isFile(join(bundled, v, 'claude.exe')))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      c.push(...vers.map((v) => join(bundled, v, 'claude.exe')));
    }
  } else {
    const w = await run('which', ['claude']);
    if (w.code === 0) c.push(w.stdout.trim());
    c.push(join(homedir(), '.local', 'bin', 'claude'));
  }
  return [...new Set(c.filter((p) => p && isFile(p)))];
}

// 후보를 차례로 실제 실행해 보고, 버전이 나오는 첫 번째를 쓴다.
export async function findClaude() {
  if (cachedBin && isFile(cachedBin.path)) return cachedBin;
  cachedBin = null; brokenBin = null;
  for (const path of await candidates()) {
    const bin = { path, cmd: /\.(cmd|bat)$/i.test(path) };
    const r = await exec(bin, ['--version'], { timeout: 12000 });
    const m = /\d+\.\d+\.\d+/.exec(r.stdout);
    if (r.code === 0 && m) { cachedBin = { ...bin, version: m[0] }; return cachedBin; }
    brokenBin ||= { path, error: firstLine(r.stderr) || firstLine(r.stdout) || (r.timedOut ? '응답이 없습니다(시간 초과)' : `실행하지 못했습니다(종료 코드 ${r.code})`) };
  }
  return null;
}

export async function claudeInfo({ fresh = false } = {}) {
  if (fresh) { cachedBin = null; }
  const bin = await findClaude();
  if (!bin) return { installed: false, broken: brokenBin, auth: { loggedIn: false } };
  if (!fresh && Date.now() - authCache.at < 8000 && authCache.value) return authCache.value;
  const a = await exec(bin, ['auth', 'status', '--json'], { timeout: 20000 });
  let auth = { loggedIn: false };
  try {
    const j = JSON.parse(a.stdout);
    auth = {
      loggedIn: Boolean(j.loggedIn), method: j.authMethod || '', email: j.email || '', org: j.orgName || '',
      plan: j.subscriptionType || '', provider: j.apiProvider || '',
    };
  } catch {
    // 출력을 읽지 못하면 로그인 안 됨으로 보되, 이유를 함께 알려 준다.
    auth = { loggedIn: false, error: firstLine(a.stderr) || firstLine(a.stdout) || (a.timedOut ? '로그인 상태 확인이 시간 안에 끝나지 않았습니다.' : '') };
  }
  const value = { installed: true, path: bin.path, version: bin.version, auth };
  authCache = { at: Date.now(), value };
  return value;
}

// 보이는 PowerShell 창에서 스크립트를 실행한다. 한글·공백 경로가 깨지지 않도록 인코딩된 명령으로 넘긴다.
function launchConsole(title, lines) {
  const script = [`$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`, ...lines].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const cmd = `Start-Process powershell.exe -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${b64}'`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// 새 콘솔 창에서 공식 로그인 절차를 시작한다(브라우저가 열리고, 끝나면 창을 닫으면 된다).
export async function startLogin(method = 'claudeai') {
  const bin = await findClaude();
  need(bin, brokenBin
    ? `Claude Code가 실행되지 않습니다(${brokenBin.error}). 「Claude Code 설치」로 다시 설치해 주세요.`
    : 'Claude Code가 설치되어 있지 않습니다. 먼저 설치해 주세요.', 409);
  need(['claudeai', 'console'].includes(method), '로그인 방식은 claudeai 또는 console 입니다.');
  need(isWindows, '이 기능은 Windows에서만 지원합니다. 터미널에서 `claude auth login` 을 실행해 주세요.', 501);
  const flag = method === 'console' ? '--console' : '--claudeai';
  launchConsole('Claude 로그인', [
    `& ${psQuote(bin.path)} auth login ${flag}`,
    "Write-Host ''",
    "Write-Host '로그인이 끝났으면 이 창을 닫고, 대시보드에서 「다시 확인」을 눌러 주세요.'",
  ]);
  authCache = { at: 0, value: null };
  return { started: true };
}

export async function logout() {
  const bin = await findClaude();
  need(bin, 'Claude Code를 찾을 수 없습니다.', 409);
  const r = await exec(bin, ['auth', 'logout'], { timeout: 20000 });
  authCache = { at: 0, value: null };
  need(r.code === 0, '로그아웃하지 못했습니다.', 500);
  return { ok: true };
}

// Claude Code 설치(npm). 사용자가 버튼을 눌렀을 때만 실행하고, 진행 상황이 보이도록 콘솔 창을 연다.
export async function startInstall() {
  need(isWindows, '이 기능은 Windows에서만 지원합니다. `npm install -g @anthropic-ai/claude-code` 를 실행해 주세요.', 501);
  launchConsole('Claude Code 설치', [
    'npm install -g @anthropic-ai/claude-code',
    "Write-Host ''",
    "Write-Host '설치가 끝났습니다. 이 창을 닫고 대시보드에서 「다시 확인」을 눌러 주세요.'",
  ]);
  cachedBin = null; brokenBin = null;
  return { started: true };
}

export const _test = { launchConsole };
