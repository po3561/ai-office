// 대시보드(프로그램) 업데이트: 새 버전 감지 → 사용자가 누르면 내려받아 교체하고 서버를 다시 시작한다.
// - 새 버전은 GitHub 릴리스(ai-office-app.zip)에서만 받는다. 주소는 이 저장소의 릴리스 경로로 고정하고, 릴리스가 알려 주는 sha256 이 있으면 검증한다.
// - 설치된 프로그램(<설치폴더>\app)만 교체한다. 소스에서 바로 실행 중이면 감지만 하고 `git pull` 을 안내한다.
// - 교체 전에 현재 프로그램을 백업하고, 새 파일 검사나 복사가 실패하면 되돌린다. 사무실(봇)과 데이터는 건드리지 않는다.
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { APP_HOME, DATA_HOME, UPDATE_DIR } from './paths.mjs';
import { readJson, writeJson, copyTree, isFile, isDir, need, run, ps, psQuote, isWindows, nowIso, stamp, HttpError } from './util.mjs';

export const REPO = 'po3561/ai-office';
const ASSET = 'ai-office-app.zip';
const MAX_ZIP = 40 * 1024 * 1024;
const APP_ITEMS = ['bin', 'src', 'web', 'dashboard', 'templates', 'scripts', 'assets'];       // install.ps1 과 같은 구성
const APP_FILES = ['package.json', 'README.md', 'LICENSE', 'install.ps1', 'uninstall.ps1'];

// "v0.3.1" / "0.3.1" → [0,3,1]. 알아볼 수 없으면 null (미리보기 같은 "-beta" 꼬리표는 버린다).
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// GitHub 릴리스 JSON → 업데이트 정보. 이 저장소의 릴리스 주소가 아니거나 zip 이 없으면 null.
export function parseRelease(rel, repo = REPO) {
  if (!rel || rel.draft || rel.prerelease || !parseVersion(rel.tag_name)) return null;
  const asset = (rel.assets || []).find((a) => a && a.name === ASSET);
  const prefix = `https://github.com/${repo}/releases/download/`;
  if (!asset || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith(prefix)) return null;
  if (!Number.isFinite(asset.size) || asset.size <= 0 || asset.size > MAX_ZIP) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  return {
    version: parseVersion(rel.tag_name).join('.'), tag: rel.tag_name, url: asset.browser_download_url, size: asset.size,
    sha256: digest ? digest[1].toLowerCase() : '', notes: String(rel.body || '').slice(0, 2000), page: String(rel.html_url || ''), publishedAt: rel.published_at || '',
  };
}

// 폴더 내용을 맞춘다: from 의 모든 파일을 to 에 덮어쓰고, to 에만 있는 파일은 지운다.
function mirror(from, to) {
  mkdirSync(to, { recursive: true });
  const names = new Set(readdirSync(from));
  for (const e of readdirSync(to)) if (!names.has(e)) rmSync(join(to, e), { recursive: true, force: true });
  for (const n of names) {
    const a = join(from, n), b = join(to, n);
    if (statSync(a).isDirectory()) mirror(a, b);
    else copyTree(a, b);
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// 기본 도구: 인터넷 조회·내려받기·압축 풀기·서버 다시 시작. 테스트에서는 바꿔 끼운다.
const defaults = {
  async fetchJson(url) {
    const r = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ai-office-updater' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GitHub 응답 ${r.status}`);
    return r.json();
  },
  async download(url, dest) {
    const r = await fetch(url, { headers: { 'user-agent': 'ai-office-updater' }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`내려받기 실패 (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_ZIP) throw new Error('파일이 너무 큽니다.');
    writeFileSync(dest, buf);
  },
  async extract(zip, dir) {
    mkdirSync(dir, { recursive: true });
    const r = isWindows
      ? await ps(`Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dir)} -Force`, { timeout: 120000 })
      : await run('unzip', ['-q', '-o', zip, '-d', dir], { timeout: 120000 });
    if (r.code !== 0) throw new Error(`압축을 풀지 못했습니다. ${String(r.stderr).trim().slice(0, 200)}`);
  },
  // 응답을 보낸 뒤 이 서버를 끝내고, 따로 띄운 도우미가 새 코드로 서버를 다시 시작한다.
  async restart(cli) {
    const { spawn } = await import('node:child_process');
    const script = `setTimeout(()=>{require('node:child_process').spawn(process.execPath,[${JSON.stringify(cli)},'serve'],{detached:true,stdio:'ignore',windowsHide:true}).unref();process.exit(0)},2500)`;
    spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    setTimeout(() => process.exit(0), 600).unref?.();
  },
};

export function createUpdater({ current, appHome = APP_HOME, dataHome = DATA_HOME, updateDir = UPDATE_DIR, repo = REPO, tools = {} } = {}) {
  const t = { ...defaults, ...tools };
  const installed = resolve(appHome) === resolve(join(dataHome, 'app')) && isFile(join(dataHome, 'install.json'));
  let state = { checkedAt: '', latest: null, error: '', applying: false, lastApplied: null };

  const view = () => {
    const l = state.latest;
    const available = Boolean(l) && compareVersions(l.version, current) > 0;
    return {
      current, canApply: installed, checkedAt: state.checkedAt, error: state.error, applying: state.applying, available,
      latest: l ? { version: l.version, tag: l.tag, notes: l.notes, page: l.page, publishedAt: l.publishedAt, size: l.size } : null,
      lastApplied: state.lastApplied,
      why: installed ? '' : '소스 폴더에서 직접 실행 중이라 자동으로 바꾸지 않습니다. 이 폴더에서 `git pull` 하거나 설치 프로그램으로 설치하세요.',
    };
  };

  async function check() {
    try {
      const rel = await t.fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
      state = { ...state, checkedAt: nowIso(), latest: parseRelease(rel, repo), error: '' };
    } catch (e) {
      state = { ...state, checkedAt: nowIso(), error: `새 버전을 확인하지 못했습니다 (${e.message}).` };
    }
    return view();
  }

  async function apply() {
    need(installed, view().why, 409);
    need(!state.applying, '이미 업데이트 중입니다.', 409);
    if (!state.latest) await check();
    const l = state.latest;
    need(l && compareVersions(l.version, current) > 0, '지금 설치된 것이 최신 버전입니다.', 409);
    state.applying = true;
    const work = join(updateDir, `v${l.version}`);
    const backup = join(updateDir, `backup-v${current}_${stamp()}`);
    let swapped = false;
    try {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const zip = join(work, ASSET);
      await t.download(l.url, zip);
      if (statSync(zip).size > MAX_ZIP) throw new Error('파일이 너무 큽니다.');
      if (l.sha256 && sha256(zip) !== l.sha256) throw new Error('내려받은 파일이 릴리스의 검증값(sha256)과 다릅니다. 업데이트를 중단했습니다.');
      const out = join(work, 'x');
      await t.extract(zip, out);

      // 새 파일 점검: 우리 프로그램이 맞는지, 정말 새 버전인지, 코드가 문법 오류 없이 읽히는지.
      const pkg = readJson(join(out, 'package.json'), null);
      need(pkg && pkg.name === 'ai-office' && compareVersions(pkg.version, current) > 0, '내려받은 파일이 올바른 새 버전이 아닙니다.', 502);
      for (const f of ['bin/ai-office.mjs', 'src/server.mjs', 'web/index.html', 'web/app.js']) need(isFile(join(out, f)), `내려받은 파일에 ${f} 가 없습니다.`, 502);
      for (const f of ['bin/ai-office.mjs', 'src/server.mjs', 'src/updater.mjs']) {
        if (!isFile(join(out, f))) continue;
        const r = await run(process.execPath, ['--check', join(out, f)], { timeout: 20000 });
        need(r.code === 0, `새 코드 점검에 실패했습니다 (${f}). 업데이트를 중단했습니다.`, 502);
      }

      // 교체: 현재 프로그램을 백업한 뒤 새 파일로 맞춘다. 실패하면 백업으로 되돌린다.
      mkdirSync(backup, { recursive: true });
      for (const n of [...APP_ITEMS, ...APP_FILES]) if (existsSync(join(appHome, n))) copyTree(join(appHome, n), join(backup, n));
      swapped = true;
      for (const n of APP_ITEMS) if (isDir(join(out, n))) mirror(join(out, n), join(appHome, n));
      for (const n of APP_FILES) if (isFile(join(out, n))) copyTree(join(out, n), join(appHome, n));
      const instFile = join(dataHome, 'install.json');
      writeJson(instFile, { ...readJson(instFile, {}), version: pkg.version, updatedAt: nowIso() });

      state.lastApplied = { from: current, to: pkg.version, at: nowIso(), backup };
      rmSync(work, { recursive: true, force: true });
      pruneBackups(updateDir);
      const result = { from: current, to: pkg.version, backup };
      setTimeout(() => { t.restart(join(appHome, 'bin', 'ai-office.mjs')); }, 400).unref?.();   // 응답이 먼저 나가도록
      return result;
    } catch (e) {
      if (swapped && isDir(backup)) {
        try { for (const n of [...APP_ITEMS, ...APP_FILES]) if (existsSync(join(backup, n))) { rmSync(join(appHome, n), { recursive: true, force: true }); copyTree(join(backup, n), join(appHome, n)); } } catch { /* 되돌리기도 실패하면 백업 폴더에서 직접 복구할 수 있다 */ }
      }
      rmSync(work, { recursive: true, force: true });
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `업데이트하지 못했습니다: ${e.message}${swapped ? ' (이전 버전으로 되돌렸습니다)' : ''}`);
    } finally { state.applying = false; }
  }

  return { check, apply, view, installed };
}

// 오래된 백업은 최근 3개만 남긴다.
function pruneBackups(dir) {
  try {
    const b = readdirSync(dir).filter((n) => n.startsWith('backup-')).sort();
    for (const n of b.slice(0, Math.max(0, b.length - 3))) rmSync(join(dir, n), { recursive: true, force: true });
  } catch { /* 정리는 못 해도 된다 */ }
}

export const _test = { mirror };
