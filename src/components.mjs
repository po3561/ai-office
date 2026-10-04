// 컴포넌트 관리자: 앱이 쓰는 외부 도구(Bun · Claude Code · Codex · Ollama · Hermes)를 감지하고, 사용자가 누르면 설치한다.
// - 내려받는 곳은 공식 호스트(download.mjs 의 허용 목록)뿐이다. 공식 설치 스크립트(Claude·Hermes)는 그 도구의 문서가 안내하는 방식 그대로 실행한다.
// - 이미 설치된 것은 건너뛰고, 진행 상황은 jobs.mjs 의 작업 기록으로 화면에 보여 준다.
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { TOOLS_DIR } from './paths.mjs';
import { run, isFile, isDir, isWindows, need, psQuote, HttpError } from './util.mjs';
import { download } from './download.mjs';
import { toolDirs } from './toolpath.mjs';

const localApp = () => process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const roaming = () => process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');

export const OFFICIAL = {
  bun: 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip',
  codex: 'https://github.com/openai/codex/releases/latest/download/codex-x86_64-pc-windows-msvc.exe.zip',
  ollama: 'https://ollama.com/download/OllamaSetup.exe',
  claudeScript: 'https://claude.ai/install.ps1',
  hermesScript: 'https://hermes-agent.nousresearch.com/install.ps1',
};

const firstLine = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';
const semver = (s) => /\d+\.\d+(?:\.\d+)?/.exec(String(s || ''))?.[0] || '';

// 화면에 보여 줄 설명(왜 필요한지, 얼마나 받는지)
export const META = {
  bun: { name: 'Bun', desc: '텔레그램 연결 부품을 실행하는 데 필요합니다.', size: '약 40MB', needs: 'Claude Office 봇' },
  claude: { name: 'Claude Code', desc: 'Claude 계정으로 일하는 사무실의 두뇌입니다. 파일·도구까지 쓰는 가장 강력한 엔진입니다.', size: '약 200MB', needs: 'Claude Office 봇' },
  codex: { name: 'Codex (ChatGPT)', desc: 'ChatGPT 계정으로 로그인해 GPT를 봇의 엔진으로 씁니다.', size: '약 160MB', needs: 'GPT 엔진' },
  ollama: { name: 'Ollama', desc: '내 PC에서 직접 돌리는 무료 AI(로컬 모델)입니다. 인터넷 없이 쓸 수 있습니다.', size: '약 1.5GB (모델은 별도)', needs: '로컬 AI 봇' },
  hermes: { name: 'Hermes', desc: '스스로 배우는 개인 비서 에이전트입니다. 텔레그램 게이트웨이를 내장하고 있습니다.', size: '약 1GB', needs: 'Hermes 봇' },
};
export const ORDER = ['claude', 'bun', 'codex', 'ollama', 'hermes'];

export function createComponents({ jobs, fetchImpl = fetch, toolsDir = TOOLS_DIR, urls = OFFICIAL, downloadOpts = {}, runImpl = run, onChange = () => {} } = {}) {
  const cache = new Map();

  // ── 찾기 ──
  async function where(name) {
    if (!isWindows) { const r = await runImpl('which', [name], { timeout: 5000 }); return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : []; }
    const r = await runImpl('where.exe', [name], { timeout: 8000 });
    return r.code === 0 ? r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
  }
  const LOCATE = {
    bun: async () => [join(toolsDir, 'bun', 'bun.exe'), ...(await where('bun.exe')), join(homedir(), '.bun', 'bin', 'bun.exe'), join(localApp(), 'Microsoft', 'WinGet', 'Links', 'bun.exe')],
    claude: async () => {
      const { findClaude } = await import('./claude.mjs');
      const b = await findClaude();
      return b ? [b.path] : [];
    },
    codex: async () => [join(toolsDir, 'codex', 'codex.exe'), ...(await where('codex.exe')), ...(await where('codex.cmd')), join(roaming(), 'npm', 'codex.cmd')],
    ollama: async () => [join(localApp(), 'Programs', 'Ollama', 'ollama.exe'), ...(await where('ollama.exe'))],
    hermes: async () => [join(localApp(), 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'), join(localApp(), 'hermes', 'bin', 'hermes.exe'), ...(await where('hermes.exe'))],
  };
  const VERSION_ARGS = { bun: ['--version'], claude: ['--version'], codex: ['--version'], ollama: ['--version'], hermes: ['--version'] };

  const exec = (path, args, opts) => (/\.(cmd|bat)$/i.test(path)
    ? runImpl('cmd.exe', ['/d', '/s', '/c', `""${path}" ${args.join(' ')}"`], { ...opts, verbatim: true })
    : runImpl(path, args, opts));

  async function detect(id, { fresh = false } = {}) {
    need(LOCATE[id], '알 수 없는 구성 요소입니다.', 404);
    const hit = cache.get(id);
    if (!fresh && hit && Date.now() - hit.at < 15000) return hit.value;
    let value = { id, installed: false, path: '', version: '' };
    const seen = new Set();
    for (const path of await LOCATE[id]()) {
      const k = path.toLowerCase();
      if (!path || seen.has(k) || !isFile(path)) continue;
      seen.add(k);
      const r = await exec(path, VERSION_ARGS[id], { timeout: 20000 });
      const version = semver(r.stdout + ' ' + r.stderr);
      if (r.code === 0 && version) { value = { id, installed: true, path, version }; break; }
    }
    cache.set(id, { at: Date.now(), value });
    return value;
  }
  const forget = (id) => { cache.delete(id); };

  async function list({ fresh = false } = {}) {
    const items = await Promise.all(ORDER.map(async (id) => ({ ...META[id], ...(await detect(id, { fresh })), busy: jobs.running('component:' + id) })));
    return items;
  }

  const extraPath = async () => toolDirs(toolsDir);

  // ── 설치 ──
  const extract = async (zip, dest, ctx) => {
    mkdirSync(dest, { recursive: true });
    // Git 의 GNU tar 가 PATH 에 있으면 'C:' 를 원격 주소로 읽으므로, Windows 기본 bsdtar 를 전체 경로로 부른다.
    const tar = isWindows ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    let r = await runImpl(tar, ['-xf', zip, '-C', dest], { timeout: 600000 });
    if (r.code !== 0 && isWindows) r = await runImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`], { timeout: 600000 });
    if (r.code !== 0) throw new HttpError(500, '압축을 풀지 못했습니다: ' + (firstLine(r.stderr) || firstLine(r.stdout)));
    ctx.log('압축을 풀었습니다.');
  };
  const findFile = (dir, name) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
      if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    }
    return '';
  };
  const fetchTo = (url, dest, ctx, label) => {
    ctx.step(label);
    return download(url, dest, { fetchImpl, ...downloadOpts, onProgress: (d, t) => ctx.progress(d, t) });
  };
  const withTemp = async (fn) => {
    const tmp = mkdtempSync(join(tmpdir(), 'lapis-dl-'));
    try { return await fn(tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
  };

  // 줄 단위로 출력을 작업 기록에 흘려 보내며 명령을 실행한다.
  function runStream(cmd, args, ctx, { timeout = 30 * 60 * 1000, cwd } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(cmd, args, { cwd, windowsHide: true }); } catch (e) { return reject(new HttpError(500, e.message)); }
      let buf = '';
      const feed = (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach((l) => ctx.log(l)); };
      child.stdout.on('data', feed); child.stderr.on('data', feed);
      const timer = setTimeout(() => { try { child.kill(); } catch { } reject(new HttpError(504, '설치가 너무 오래 걸려 중단했습니다.')); }, timeout);
      child.on('error', (e) => { clearTimeout(timer); reject(new HttpError(500, e.message)); });
      child.on('close', (code) => { clearTimeout(timer); if (buf.trim()) ctx.log(buf); code === 0 ? resolve() : reject(new HttpError(500, `설치 프로그램이 오류로 끝났습니다(종료 코드 ${code}). 위 기록을 확인해 주세요.`)); });
    });
  }
  const psScript = (script, ctx, opts) => runStream('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${script}`], ctx, opts);

  const INSTALLERS = {
    async bun(ctx) {
      await withTemp(async (tmp) => {
        const zip = join(tmp, 'bun.zip');
        await fetchTo(urls.bun, zip, ctx, 'Bun 내려받기');
        ctx.step('Bun 설치');
        await extract(zip, join(tmp, 'x'), ctx);
        const exe = findFile(join(tmp, 'x'), 'bun.exe');
        need(exe, '내려받은 파일에서 bun.exe 를 찾지 못했습니다.', 502);
        mkdirSync(join(toolsDir, 'bun'), { recursive: true });
        copyFileSync(exe, join(toolsDir, 'bun', 'bun.exe'));
      });
    },
    async codex(ctx) {
      await withTemp(async (tmp) => {
        const zip = join(tmp, 'codex.zip');
        await fetchTo(urls.codex, zip, ctx, 'Codex 내려받기');
        ctx.step('Codex 설치');
        await extract(zip, join(tmp, 'x'), ctx);
        const exe = readdirSync(join(tmp, 'x')).find((f) => /^codex.*\.exe$/i.test(f));
        need(exe, '내려받은 파일에서 codex 실행 파일을 찾지 못했습니다.', 502);
        mkdirSync(join(toolsDir, 'codex'), { recursive: true });
        copyFileSync(join(tmp, 'x', exe), join(toolsDir, 'codex', 'codex.exe'));
      });
    },
    async ollama(ctx) {
      await withTemp(async (tmp) => {
        const exe = join(tmp, 'OllamaSetup.exe');
        await fetchTo(urls.ollama, exe, ctx, 'Ollama 내려받기 (큰 파일입니다)');
        ctx.step('Ollama 설치');
        const r = await runImpl(exe, ['/SILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { timeout: 15 * 60 * 1000 });
        need(r.code === 0, `Ollama 설치가 끝나지 않았습니다(종료 코드 ${r.code}).`, 500);
      });
    },
    async claude(ctx) {
      need(isWindows, 'Windows 에서만 자동 설치합니다. 공식 안내(claude.ai/install.sh)를 따라 주세요.', 501);
      ctx.step('Claude Code 설치 (공식 설치 스크립트)');
      await psScript(`irm ${psQuote(urls.claudeScript)} | iex`, ctx);
    },
    async hermes(ctx) {
      need(isWindows, 'Windows 에서만 자동 설치합니다. 공식 안내를 따라 주세요.', 501);
      ctx.step('Hermes 설치 (공식 설치 스크립트, 몇 분 걸립니다)');
      await psScript(`& ([scriptblock]::Create((irm ${psQuote(urls.hermesScript)}))) -NonInteractive`, ctx);
    },
  };

  function install(id) {
    need(INSTALLERS[id], '알 수 없는 구성 요소입니다.', 404);
    return jobs.start('component:' + id, `${META[id].name} 설치`, async (ctx) => {
      const before = await detect(id, { fresh: true });
      if (before.installed) { ctx.log(`이미 설치되어 있습니다 (${before.version}).`); return before; }
      await INSTALLERS[id](ctx);
      forget(id);
      if (id === 'claude') { try { await (await import('./claude.mjs')).claudeInfo({ fresh: true }); } catch { } }
      const after = await detect(id, { fresh: true });
      need(after.installed, `${META[id].name} 설치를 마쳤지만 아직 찾을 수 없습니다. 앱을 다시 시작하면 인식될 수 있습니다.`, 500);
      onChange(id, after);
      ctx.log(`${META[id].name} ${after.version} 설치 확인.`);
      return after;
    });
  }

  return { detect, list, install, extraPath, forget, ids: ORDER };
}

export const _test = { semver };
