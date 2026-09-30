// Claude Code 설치 확인과 계정 로그인 상태.
// 로그인은 Claude Code 자신의 공식 로그인(`claude auth login`, 브라우저 인증)만 사용한다.
// 이 프로그램은 비밀번호·토큰을 입력받거나 저장하지 않고, 로그인 파일도 읽지 않는다.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { run, isFile, isWindows, need } from './util.mjs';
import { RUN_DIR } from './paths.mjs';

let cachedBin = null;
let authCache = { at: 0, value: null };

export async function findClaude() {
  if (cachedBin && isFile(cachedBin.path)) return cachedBin;
  const cands = [];
  if (process.env.AI_OFFICE_CLAUDE) cands.push(process.env.AI_OFFICE_CLAUDE);
  if (isWindows) {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    cands.push(join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    const w = await run('where.exe', ['claude.exe']);
    if (w.code === 0) cands.push(...w.stdout.split(/\r?\n/).filter(Boolean));
    cands.push(join(homedir(), '.local', 'bin', 'claude.exe'));
    const c = await run('where.exe', ['claude.cmd']);
    if (c.code === 0) cands.push(...c.stdout.split(/\r?\n/).filter(Boolean));
  } else {
    const w = await run('which', ['claude']);
    if (w.code === 0) cands.push(w.stdout.trim());
    cands.push(join(homedir(), '.local', 'bin', 'claude'));
  }
  const path = cands.find((p) => isFile(p));
  cachedBin = path ? { path, cmd: /\.(cmd|bat)$/i.test(path) } : null;
  return cachedBin;
}

const exec = async (args, opts) => {
  const bin = await findClaude();
  if (!bin) return { code: -1, stdout: '', stderr: 'not installed', timedOut: false };
  return bin.cmd
    ? run('cmd.exe', ['/c', bin.path, ...args], opts)
    : run(bin.path, args, opts);
};

export async function claudeInfo({ fresh = false } = {}) {
  const bin = await findClaude();
  if (!bin) return { installed: false, auth: { loggedIn: false } };
  if (!fresh && Date.now() - authCache.at < 8000 && authCache.value) return authCache.value;
  const [v, a] = await Promise.all([exec(['--version'], { timeout: 10000 }), exec(['auth', 'status', '--json'], { timeout: 20000 })]);
  let auth = { loggedIn: false };
  try {
    const j = JSON.parse(a.stdout);
    auth = {
      loggedIn: Boolean(j.loggedIn), method: j.authMethod || '', email: j.email || '', org: j.orgName || '',
      plan: j.subscriptionType || '', provider: j.apiProvider || '',
    };
  } catch { /* 로그인 전이거나 출력 형식이 다르면 로그인 안 됨으로 본다 */ }
  const value = { installed: true, path: bin.path, version: v.stdout.trim().replace(/\s*\(Claude Code\)/, ''), auth };
  authCache = { at: Date.now(), value };
  return value;
}

const CRLF = String.fromCharCode(13, 10);

// 보이는 콘솔 창에서 배치 파일을 실행한다(따옴표·& 문제를 피하려고 명령을 파일로 만들어 실행).
function launchConsole(name, lines) {
  mkdirSync(RUN_DIR, { recursive: true });
  const file = join(RUN_DIR, `${name}.cmd`);
  writeFileSync(file, ['@echo off', 'chcp 65001 >nul', ...lines, ''].join(CRLF), 'utf8');
  spawn('cmd.exe', ['/c', 'start', `"${name}"`, `"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

// 새 콘솔 창에서 공식 로그인 절차를 시작한다(브라우저가 열리고, 끝나면 창을 닫으면 된다).
export async function startLogin(method = 'claudeai') {
  const bin = await findClaude();
  need(bin, 'Claude Code가 설치되어 있지 않습니다. 먼저 설치해 주세요.', 409);
  need(['claudeai', 'console'].includes(method), '로그인 방식은 claudeai 또는 console 입니다.');
  need(isWindows, '이 기능은 Windows에서만 지원합니다. 터미널에서 `claude auth login` 을 실행해 주세요.', 501);
  const flag = method === 'console' ? '--console' : '--claudeai';
  launchConsole('claude-login', [
    'title Claude 로그인',
    `"${bin.path}" auth login ${flag}`,
    'echo.',
    'echo 로그인이 끝났으면 이 창을 닫고, 대시보드에서 「다시 확인」을 눌러 주세요.',
    'pause',
  ]);
  authCache = { at: 0, value: null };
  return { started: true };
}

export async function logout() {
  const r = await exec(['auth', 'logout'], { timeout: 20000 });
  authCache = { at: 0, value: null };
  need(r.code === 0, '로그아웃하지 못했습니다.', 500);
  return { ok: true };
}

// Claude Code 설치(npm). 사용자가 버튼을 눌렀을 때만 실행하고, 진행 상황이 보이도록 콘솔 창을 연다.
export async function startInstall() {
  need(isWindows, '이 기능은 Windows에서만 지원합니다. `npm install -g @anthropic-ai/claude-code` 를 실행해 주세요.', 501);
  launchConsole('claude-install', [
    'title Claude Code 설치',
    'call npm install -g @anthropic-ai/claude-code',
    'echo.',
    'echo 설치가 끝났습니다. 이 창을 닫고 대시보드로 돌아가세요.',
    'pause',
  ]);
  cachedBin = null;
  return { started: true };
}
export const _test = { launchConsole };
