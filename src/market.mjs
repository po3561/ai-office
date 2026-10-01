// 스킬 마켓: 여러 PC 가 같은 (비공개) git 저장소를 통해 스킬을 선택적으로 주고받는다.
//
//  · 게시(publish)   내 스킬 폴더 → 검사 → 저장소의 skills/<id>/ 로 올림(사용자가 화면에서 확인한 뒤에만)
//  · 설치(install)   저장소의 skills/<id>/ → 미리보기·위험 확인 → 선택한 사무실의 .claude/skills/<id>/ 에 복사
//  · 회수(revoke)    게시한 사람이 마켓에서 내림(이미 설치된 곳에는 경고만 표시)
//
// 저장소 구조(레지스트리 파일은 두지 않는다 — 두 PC 가 동시에 게시할 때 병합 충돌이 나기 때문):
//   skills/<id>/SKILL.md, (딸린 파일), .market.json   ← 게시 정보(버전·게시자·sha256 …)
//   revoked.json                                      ← 회수 목록 { <id>: { reason, at, by } }
//   .gitattributes                                    ← "* -text" (줄바꿈 변환으로 해시가 달라지는 것을 막는다)
//
// 보안 원칙: 토큰을 받거나 저장하지 않는다(PC 에 이미 있는 git·gh 로그인을 그대로 쓴다). 자동 설치·자동 업데이트는 없다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { run as defaultRun, readJson, writeJson, need, HttpError, isDir, nowIso, stamp } from './util.mjs';
import { LIMITS, scanFiles, fileKind } from './market-scan.mjs';
import { parseFrontmatter } from './skills.mjs';

export const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,47}$/u;
const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export const MARKET_FILE = '.market.json';
export const INSTALLED_FILE = '.market-installed.json';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);

// ── 저장소 주소 ──
// 허용: owner/저장소(GitHub 약칭) · https://… · git@호스트:… · file://… · 로컬/네트워크 폴더(bare 저장소)
// 주소에 아이디·비밀번호를 넣는 형태(https://user:token@…)와 옵션처럼 보이는 값(-…)은 거절한다.
export function normalizeRepo(input) {
  const s = String(input ?? '').trim();
  need(s && s.length <= 300 && !/[\s\x00-\x1f]/.test(s) && !s.startsWith('-'), '저장소 주소를 확인해 주세요.');
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s) || s.startsWith('/') || /^file:\/\//i.test(s)) return s;
  if (/^https:\/\/[^@\s/]+\/\S+$/i.test(s)) return s;
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(s)) return s;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) && !/^\.\.?\//.test(s)) return `https://github.com/${s.replace(/\.git$/i, '')}.git`;
  throw new HttpError(400, '지원하는 주소 형식이 아닙니다. 예: 내계정/ai-office-skills, https://github.com/내계정/저장소.git, 또는 공유 폴더 경로');
}
const githubSlug = (repo) => { const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(repo); return m ? `${m[1]}/${m[2]}` : ''; };

// ── 버전 ──
export const isSemver = (v) => SEMVER.test(String(v));
export function semverCmp(a, b) {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
export const nextPatch = (v) => { const m = SEMVER.exec(v); return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0'; };

// ── 경로 안전 ──
export function safeParts(rel) {
  need(typeof rel === 'string' && rel && rel.length <= 200, '파일 경로가 올바르지 않습니다.');
  const parts = rel.split('/');
  for (const p of parts) need(p && p !== '.' && p !== '..' && !/[<>:"|?*\\\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !RESERVED.test(p), `사용할 수 없는 파일 이름입니다: ${rel}`);
  return parts;
}
const insideOf = (base, target) => { const b = resolve(base), t = resolve(target); return t === b || t.startsWith(b + sep); };

// ── 패키지(스킬 폴더) ──
// 폴더를 읽어 파일 목록을 만든다. 점(.)으로 시작하는 파일·폴더(.git, .market-installed.json 등)는 건너뛰고,
// 바로가기(링크)·너무 큰 파일·너무 깊은 폴더는 오류로 알린다.
export function collectPackage(dir) {
  const files = [], errors = [];
  let total = 0;
  const walk = (d, rel, depth) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { errors.push(`폴더를 읽을 수 없습니다: ${rel || '.'}`); return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      try { safeParts(r); } catch (x) { errors.push(x.message); continue; }
      if (e.isSymbolicLink()) { errors.push(`바로가기(링크)는 넣을 수 없습니다: ${r}`); continue; }
      if (e.isDirectory()) { if (depth >= LIMITS.maxDepth) errors.push(`폴더가 너무 깊습니다: ${r}`); else walk(p, r, depth + 1); continue; }
      if (!e.isFile()) continue;
      const size = statSync(p).size;
      if (size > LIMITS.maxFileBytes) { errors.push(`파일이 너무 큽니다(파일당 최대 ${LIMITS.maxFileBytes / 1_000_000}MB): ${r}`); continue; }
      total += size;
      if (files.length >= LIMITS.maxFiles) { errors.push(`파일이 너무 많습니다(최대 ${LIMITS.maxFiles}개).`); return; }
      files.push({ path: r, buf: readFileSync(p) });
    }
  };
  walk(dir, '', 0);
  if (total > LIMITS.maxTotalBytes) errors.push(`전체 크기가 너무 큽니다(최대 ${LIMITS.maxTotalBytes / 1_000_000}MB).`);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, errors };
}

export function packageHash(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) h.update(`${f.path}\0${sha(f.buf)}\n`);
  return h.digest('hex');
}

// 사무실의 skills 폴더에서 스킬 폴더(분류 폴더 한 단계까지)를 찾는다.
export function findSkillDirs(skillsDir) {
  const out = [];
  if (!isDir(skillsDir)) return out;
  const walk = (d, depth, cat) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sub = join(d, e.name);
      if (existsSync(join(sub, 'SKILL.md'))) out.push({ id: e.name, dir: sub, category: cat });
      else if (depth < 1) walk(sub, depth + 1, e.name);
    }
  };
  walk(skillsDir, 0, '');
  return out;
}

// ── 게시 요청(승인 대기함) ──
// 봇은 마켓을 직접 다루지 않는다. 사용자가 텔레그램으로 "이 스킬 마켓에 올려줘"라고 하면
// 봇은 사무실의 업무데이터/마켓요청/<스킬 폴더 이름>.txt 에 요청 이유만 적고, 사용자가 대시보드에서 검사 결과를 보고 승인(게시)하거나 거절한다.
export const REQUEST_DIR = ['업무데이터', '마켓요청'];
const REQ_EXT = /\.(txt|md)$/i;
export function readRequests(folder) {
  const dir = join(folder, ...REQUEST_DIR);
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !REQ_EXT.test(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    let note = '', at = '';
    try { const st = statSync(p); at = st.mtime.toISOString(); if (st.size <= 64_000) note = readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { continue; }
    out.push({ skillId: e.name.replace(REQ_EXT, ''), file: e.name, note: clean(note), at });
    if (out.length >= 50) break;
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}
// 처리한 요청 파일은 지우지 않고 보관함/마켓요청_처리 로 옮긴다. 화면이 보낸 이름으로 경로를 만들지 않고 목록에서 찾는다.
export function resolveRequest(folder, skillId, outcome) {
  const hit = readRequests(folder).filter((r) => r.skillId.toLowerCase() === String(skillId || '').toLowerCase());
  if (!hit.length) return 0;
  const bak = join(folder, '보관함', '마켓요청_처리');
  mkdirSync(bak, { recursive: true });
  for (const r of hit) renameSync(join(folder, ...REQUEST_DIR, r.file), join(bak, `${r.skillId}_${stamp()}_${outcome}${r.file.slice(r.skillId.length)}`));
  return hit.length;
}

export function readInstalledMarker(skillDir) {
  const m = readJson(join(skillDir, INSTALLED_FILE), null);
  return m && m.schema === 1 && typeof m.id === 'string' && isSemver(m.version) && HEX64.test(m.sha256 || '') ? m : null;
}

// ── 마켓 ──
// home: 데이터 폴더(DATA_HOME). settings(): { enabled, repo, alias }. log(폴더, 구분, 이름, 내용): 변경 이력 기록.
// identity: 테스트용 git 사용자({name,email}). 없으면 PC 의 git 설정을 쓴다.
// builtin(): AI-Office 가 모든 사무실에 기본으로 넣는 스킬 이름들(공유 대상이 아니다).
export function createMarket({ home, settings, log = () => {}, run = defaultRun, identity = null, useGh = true, builtin = () => [] }) {
  const root = join(home, 'market');
  const stateFile = join(root, 'state.json');
  const gitEnv = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ALLOW_PROTOCOL: 'file:https:ssh', GIT_ASKPASS: '' };

  // 같은 저장소 복제본을 동시에 건드리지 않도록 순서대로 처리한다.
  let chain = Promise.resolve();
  const locked = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  // ── git 도구 ──
  let gitInfo;
  async function findGit() {
    if (gitInfo) return gitInfo;
    const cands = ['git'];
    if (process.platform === 'win32') {
      const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', la = process.env.LOCALAPPDATA || '';
      cands.push(join(pf, 'Git', 'cmd', 'git.exe'), join(pf86, 'Git', 'cmd', 'git.exe'), join(la, 'Programs', 'Git', 'cmd', 'git.exe'));
      try { for (const e of readdirSync(join(la, 'GitHubDesktop'))) if (/^app-/.test(e)) cands.push(join(la, 'GitHubDesktop', e, 'resources', 'app', 'git', 'cmd', 'git.exe')); } catch { /* GitHub Desktop 없음 */ }
    }
    for (const c of cands) {
      const r = await run(c, ['--version'], { timeout: 8000 });
      if (r.code === 0) { gitInfo = { path: c, version: clean(r.stdout) }; return gitInfo; }
    }
    return null;
  }
  let ghLogged;
  async function ghReady() {
    if (!useGh) return false;
    if (ghLogged === undefined) ghLogged = (await run('gh', ['auth', 'status'], { timeout: 8000 })).code === 0;
    return ghLogged;
  }
  // GitHub 저장소는 PC 에 이미 로그인된 gh 를 자격 증명으로 쓴다(토큰은 이 프로그램이 만지지 않는다).
  async function credArgs(repo) {
    return /^https:\/\/github\.com\//i.test(repo) && await ghReady() ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
  }
  async function git(args, { cwd, timeout = 90000, repo } = {}) {
    const g = await findGit();
    need(g, 'git 을 찾을 수 없습니다. git(또는 GitHub Desktop)을 설치한 뒤 다시 시도해 주세요.', 409);
    const id = identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [];
    const cred = repo ? await credArgs(repo) : [];
    // 저장소가 .gitattributes 로 외부 필터(git-lfs 등)를 부르지 못하게 끄고, 줄바꿈 변환을 막는다(해시가 달라지므로).
    const safe = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=off', '-c', 'core.longpaths=true', '-c', 'filter.lfs.required=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'core.fsmonitor=false'];
    return run(g.path, [...safe, ...cred, ...id, ...args], { cwd, timeout, env: gitEnv });
  }
  async function gitOk(args, opts, what) {
    const r = await git(args, opts);
    if (r.code !== 0) throw new HttpError(502, `${what}: ${clean(r.stderr || r.stdout) || (r.timedOut ? '시간이 초과되었습니다' : '알 수 없는 오류')}`);
    return r;
  }
  async function myName() {
    if (identity) return identity.name;
    const r = await git(['config', 'user.name']);
    return r.code === 0 ? clean(r.stdout) : '';
  }

  // ── 저장소 복제본(cache) ──
  const cacheDirFor = (repo) => join(root, 'cache', `${createHash('sha1').update(repo).digest('hex').slice(0, 10)}`);
  const state = () => readJson(stateFile, {});
  const saveState = (patch) => { mkdirSync(root, { recursive: true }); writeJson(stateFile, { ...state(), ...patch }); };

  async function ensureCache(repo) {
    const dir = cacheDirFor(repo);
    if (!isDir(join(dir, '.git'))) {
      mkdirSync(join(root, 'cache'), { recursive: true });
      const r = await git(['clone', '--quiet', '--', repo, dir], { cwd: root, repo, timeout: 120000 });
      if (r.code !== 0) throw new HttpError(502, `저장소에 연결하지 못했습니다. 주소와 접근 권한(git·gh 로그인)을 확인해 주세요. (${clean(r.stderr)})`);
    }
    return dir;
  }
  async function remoteBranch(dir) {
    const r = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], { cwd: dir });
    const names = r.stdout.split(/\r?\n/).map((s) => s.trim().replace(/^origin\//, '')).filter((s) => s && s !== 'HEAD' && s !== 'origin');
    return names.includes('main') ? 'main' : names.includes('master') ? 'master' : (names[0] || '');
  }
  async function localBranch(dir) {
    const r = await git(['symbolic-ref', '--short', 'HEAD'], { cwd: dir });
    return r.code === 0 ? clean(r.stdout) : 'main';
  }
  // 원격의 최신 상태로 복제본을 맞춘다. 복제본은 이 프로그램만 쓰는 읽기용 캐시라 강제로 맞춰도 안전하다.
  async function syncDir(repo) {
    const dir = await ensureCache(repo);
    await gitOk(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir, repo, timeout: 120000 }, '마켓을 새로 불러오지 못했습니다');
    const b = await remoteBranch(dir);
    if (b) {
      await gitOk(['checkout', '-q', '-f', '-B', b, `origin/${b}`], { cwd: dir }, '마켓 파일을 맞추지 못했습니다');
      await git(['clean', '-fdq'], { cwd: dir });
    }
    saveState({ lastSync: nowIso() });
    return dir;
  }
  async function visibility(repo) {
    const slug = githubSlug(repo);
    if (!slug || !(await ghReady())) return 'unknown';
    const r = await run('gh', ['api', `repos/${slug}`, '--jq', '.private'], { timeout: 15000 });
    return r.code === 0 ? (clean(r.stdout) === 'true' ? 'private' : clean(r.stdout) === 'false' ? 'public' : 'unknown') : 'unknown';
  }

  const conf = () => settings() || {};
  const builtinIds = () => new Set([...builtin()].map((x) => String(x).toLowerCase()));
  const requireReady = () => {
    const s = conf();
    need(s.enabled && s.repo, '스킬 마켓이 연결되어 있지 않습니다. 「스킬 마켓 → 연결·설정」에서 저장소를 연결해 주세요.', 409);
    const dir = cacheDirFor(s.repo);
    need(isDir(join(dir, '.git')), '마켓 저장소를 아직 불러오지 않았습니다. 「새로고침」을 눌러 주세요.', 409);
    return { s, dir };
  };

  // ── 목록 읽기 ──
  function readEntries(dir) {
    const out = [];
    const base = join(dir, 'skills');
    let names = [];
    try { names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
    for (const id of names) {
      const m = readJson(join(base, id, MARKET_FILE), null);
      if (!m || m.schema !== 1 || m.id !== id || !ID_RE.test(id) || !isSemver(m.version) || !HEX64.test(m.sha256 || '')) continue;
      out.push({
        id, name: String(m.name || id), description: String(m.description || ''), category: String(m.category || ''), tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 10) : [],
        version: m.version, publisher: String(m.publisher || ''), sourceAlias: String(m.sourceAlias || ''), publishedAt: String(m.publishedAt || ''),
        sha256: m.sha256, notes: String(m.notes || ''), fileCount: Array.isArray(m.files) ? m.files.length : 0, riskLevel: ['safe', 'caution', 'danger'].includes(m.riskLevel) ? m.riskLevel : 'caution',
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }
  const readRevoked = (dir) => { const r = readJson(join(dir, 'revoked.json'), {}); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; };

  // 덮어쓰기·제거 전의 내용을 옮겨 두는 곳. 이 프로그램이 관리하는 사무실은 사무실 안 보관함, 외부 봇(Hermes)은 그 봇의 폴더가 아니라 이 프로그램의 데이터 폴더.
  const backupRoot = (office) => office.backupRoot || join(office.folder, '보관함');

  // 사무실들에 이 스킬이 마켓에서 설치되어 있는지
  function installsOf(id, offices = []) {
    const out = [];
    for (const o of offices) {
      const d = join(o.skillsDir, id);
      const mk = readInstalledMarker(d);
      if (!mk || mk.id !== id) continue;
      const { files } = collectPackage(d);
      out.push({ office: o.id, officeName: o.name, version: mk.version, publisher: mk.publisher || '', modified: packageHash(files) !== mk.sha256 });
    }
    return out;
  }

  // ── 공개 기능 ──
  async function status() {
    const s = conf(), g = await findGit(), st = state();
    const out = { enabled: Boolean(s.enabled && s.repo), repo: s.repo || '', alias: s.alias || '', git: g ? { available: true, version: g.version } : { available: false }, gh: await ghReady(), ready: false, entries: 0, lastSync: '', visibility: st.visibility || 'unknown', publisher: '', lastError: st.lastError || '' };
    if (g) out.publisher = await myName();
    if (out.enabled) {
      const dir = cacheDirFor(s.repo);
      if (isDir(join(dir, '.git'))) { out.ready = true; out.entries = readEntries(dir).length; out.lastSync = st.lastSync || ''; }
    }
    return out;
  }

  // 저장소에 연결하고 목록을 처음 불러온다. 성공하면 호출한 쪽이 설정(config)에 저장한다.
  const connect = ({ repo, alias }) => locked(async () => {
    const r = normalizeRepo(repo);
    const a = String(alias ?? '').trim();
    need(a.length >= 1 && a.length <= 20 && !/[<>&"\r\n]/.test(a), 'PC 별칭은 1~20자, 특수기호(<>&")는 쓸 수 없습니다. (예: 메인PC, 서브PC)');
    const dir = await syncDir(r);
    const vis = await visibility(r);
    saveState({ visibility: vis, lastError: '' });
    return { repo: r, alias: a, entries: readEntries(dir).length, visibility: vis };
  });

  const refresh = () => locked(async () => {
    const s = conf();
    need(s.enabled && s.repo, '스킬 마켓이 연결되어 있지 않습니다.', 409);
    try {
      const dir = await syncDir(s.repo);
      saveState({ visibility: await visibility(s.repo), lastError: '' });
      return { entries: readEntries(dir).length };
    } catch (e) { saveState({ lastError: clean(e.message), lastErrorAt: nowIso() }); throw e; }
  });

  // 대시보드 서버가 주기적으로 부른다: 연결되어 있고 마지막 새로고침이 오래됐으면 원격의 새 스킬·새 버전을 받아 온다(설치는 하지 않는다).
  async function autoSync(maxAgeMs = 10 * 60 * 1000) {
    const s = conf();
    if (!s.enabled || !s.repo || !isDir(join(cacheDirFor(s.repo), '.git'))) return false;
    const st = state();
    const last = Math.max(Date.parse(st.lastSync || '') || 0, Date.parse(st.lastErrorAt || '') || 0);
    if (Date.now() - last < maxAgeMs) return false;
    await refresh();
    return true;
  }

  function list({ offices = [] } = {}) {
    const { dir } = requireReady();
    const revoked = readRevoked(dir);
    return readEntries(dir).map((e) => ({ ...e, revoked: Boolean(revoked[e.id]), revokedReason: revoked[e.id] ? String(revoked[e.id].reason || '') : '', installs: installsOf(e.id, offices) }));
  }

  async function detail(id, { offices = [] } = {}) {
    const { dir } = requireReady();
    const entry = readEntries(dir).find((e) => e.id === id);
    need(entry, '마켓에 없는 스킬입니다.', 404);
    const { files, errors } = collectPackage(join(dir, 'skills', id));
    const scan = scanFiles(files);
    const skill = files.find((f) => f.path === 'SKILL.md');
    const revoked = readRevoked(dir)[id];
    return {
      ...entry, verified: !errors.length && packageHash(files) === entry.sha256, errors, revoked: Boolean(revoked), revokedReason: revoked ? String(revoked.reason || '') : '',
      findings: scan.findings, riskLevel: scan.riskLevel,
      skillMd: skill ? skill.buf.toString('utf8').replace(/^﻿/, '').slice(0, 30000) : '',
      files: files.map((f) => ({ path: f.path, size: f.buf.length, kind: fileKind(f.path) })),
      installs: installsOf(id, offices),
    };
  }

  // 내 사무실의 스킬들과 공유 상태(비공개 / 게시됨 / 게시 후 변경됨 / 이름 충돌 / 마켓에서 받음)
  async function shareable({ offices = [] } = {}) {
    const s = conf();
    const dir = s.enabled && s.repo && isDir(join(cacheDirFor(s.repo), '.git')) ? cacheDirFor(s.repo) : '';
    const entries = dir ? readEntries(dir) : [];
    const revoked = dir ? readRevoked(dir) : {};
    const me = dir ? await myName() : '';
    return offices.map((o) => {
      const reqs = o.folder && !o.external ? readRequests(o.folder) : [];
      const dirs = findSkillDirs(o.skillsDir);
      const reqOf = (id) => reqs.find((r) => r.skillId.toLowerCase() === id.toLowerCase()) || null;
      return {
      office: o.id, officeName: o.name,
      requests: reqs.map((r) => ({ skillId: r.skillId, note: r.note, at: r.at, known: dirs.some((k) => k.id.toLowerCase() === r.skillId.toLowerCase()) })),
      skills: dirs.map((k) => {
        const item = { id: k.id, marketId: k.id.toLowerCase(), category: k.category, name: k.id, description: '', status: 'private', version: '', reason: '', requested: reqOf(k.id) };
        const fm = (() => { try { return parseFrontmatter(readFileSync(join(k.dir, 'SKILL.md'), 'utf8').replace(/^﻿/, '')); } catch { return {}; } })();
        item.name = fm.name || k.id; item.description = fm.description || '';
        if (builtinIds().has(item.marketId)) return { ...item, status: 'builtin', reason: 'AI-Office 기본 스킬입니다(모든 사무실에 이미 들어 있어 공유하지 않습니다).' };
        const mk = readInstalledMarker(k.dir);
        if (mk) return { ...item, status: 'from-market', version: mk.version, reason: `마켓에서 받은 스킬입니다(게시: ${mk.publisher || '알 수 없음'})` };
        if (!ID_RE.test(item.marketId)) return { ...item, status: 'unsharable', reason: '폴더 이름에 마켓에서 쓸 수 없는 문자가 있습니다(글자·숫자·하이픈만).' };
        const { files, errors } = collectPackage(k.dir);
        if (errors.length) return { ...item, status: 'unsharable', reason: errors[0] };
        const e = entries.find((x) => x.id === item.marketId);
        if (!e) return item;
        item.version = e.version;
        if (revoked[e.id]) return { ...item, status: 'revoked', reason: '마켓에서 회수된 스킬입니다.' };
        if (me && e.publisher !== me) return { ...item, status: 'conflict', reason: `같은 이름의 스킬을 다른 게시자(${e.publisher})가 이미 올렸습니다.` };
        return { ...item, status: packageHash(files) === e.sha256 ? 'published' : 'changed' };
      }),
      };
    });
  }

  // 게시 전 검사(저장소에 아무것도 올리지 않는다)
  async function inspect({ skillDir, id, honorifics = [] }) {
    const marketId = String(id || '').toLowerCase();
    need(ID_RE.test(marketId), '스킬 이름(폴더 이름)에는 글자·숫자·하이픈만 쓸 수 있습니다.');
    const { files, errors } = collectPackage(skillDir);
    const scan = scanFiles(files, { honorifics });
    for (const e of errors) scan.findings.unshift({ level: 'block', code: 'package', file: '', line: 0, message: e, sample: '' });
    const blockers = scan.findings.filter((f) => f.level === 'block');
    const s = conf();
    let existing = null;
    if (s.enabled && s.repo && isDir(join(cacheDirFor(s.repo), '.git'))) {
      const dir = cacheDirFor(s.repo);
      const e = readEntries(dir).find((x) => x.id === marketId);
      if (e) existing = { version: e.version, publisher: e.publisher, mine: e.publisher === (await myName()), same: e.sha256 === packageHash(files), revoked: Boolean(readRevoked(dir)[marketId]) };
    }
    return {
      id: marketId, files: files.map((f) => ({ path: f.path, size: f.buf.length, kind: fileKind(f.path) })), findings: scan.findings, blockers, riskLevel: scan.riskLevel,
      warnings: scan.findings.filter((f) => f.level === 'warn'), risks: scan.findings.filter((f) => f.level === 'risk'),
      existing, suggestedVersion: existing ? nextPatch(existing.version) : '1.0.0', publishable: !blockers.length,
    };
  }

  const publish = ({ skillDir, id, version, notes = '', honorifics = [], confirmWarnings = false, confirmRisks = false }) => locked(async () => {
    const s = conf();
    need(s.enabled && s.repo, '스킬 마켓이 연결되어 있지 않습니다.', 409);
    need(isSemver(version), '버전은 1.0.0 처럼 숫자 세 개(점으로 구분)로 적어 주세요.');
    const marketId = String(id || '').toLowerCase();
    need(!builtinIds().has(marketId), 'AI-Office 기본 스킬은 공유하지 않습니다.', 409);
    const info = await inspect({ skillDir, id: marketId, honorifics });
    need(!info.blockers.length, '공유할 수 없는 내용이 있어 게시하지 않았습니다.', 422, info);
    need(!info.warnings.length || confirmWarnings, '개인정보로 보이는 내용이 있습니다. 확인 후 다시 게시해 주세요.', 409, { ...info, needsConfirm: 'warnings' });
    need(!info.risks.length || confirmRisks, '설치하는 쪽에서 위험할 수 있는 내용(스크립트 등)이 있습니다. 확인 후 다시 게시해 주세요.', 409, { ...info, needsConfirm: 'risks' });
    const publisher = await myName();
    need(publisher, 'git 사용자 이름이 설정되어 있지 않습니다. 터미널에서 git config --global user.name "이름" 을 실행해 주세요.', 409);

    const dir = await syncDir(s.repo);      // 최신 상태에서 시작
    const cur = readEntries(dir).find((e) => e.id === marketId);
    need(!readRevoked(dir)[marketId], '회수된 스킬 이름입니다. 다른 이름으로 게시해 주세요.', 409);
    if (cur) {
      need(cur.publisher === publisher, `같은 이름의 스킬을 다른 게시자(${cur.publisher})가 이미 올렸습니다. 이름을 바꿔 주세요.`, 409);
      need(semverCmp(version, cur.version) > 0, `이미 게시된 버전(${cur.version})보다 높은 버전이어야 합니다. (예: ${nextPatch(cur.version)})`, 409);
    }
    const { files } = collectPackage(skillDir);
    const skillMd = files.find((f) => f.path === 'SKILL.md');
    const fm = parseFrontmatter(skillMd.buf.toString('utf8').replace(/^﻿/, ''));
    const tags = String(fm.meta.tags || '').replace(/[[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10);
    const meta = {
      schema: 1, id: marketId, version, name: fm.name || marketId, description: String(fm.description || '').slice(0, 400), category: fm.meta.category || '', tags,
      publisher, sourceAlias: s.alias || '', publishedAt: nowIso(), sha256: packageHash(files), notes: String(notes || '').slice(0, 500),
      files: files.map((f) => ({ path: f.path, size: f.buf.length })), riskLevel: info.riskLevel,
    };

    const dest = join(dir, 'skills', marketId);
    rmSync(dest, { recursive: true, force: true });
    for (const f of files) {
      const p = join(dest, ...safeParts(f.path));
      need(insideOf(dest, p), '파일 경로가 올바르지 않습니다.');
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, f.buf);
    }
    writeJson(join(dest, MARKET_FILE), meta);
    if (!existsSync(join(dir, '.gitattributes'))) writeFileSync(join(dir, '.gitattributes'), '* -text\n');

    await gitOk(['add', '-A'], { cwd: dir }, '게시 파일을 준비하지 못했습니다');
    const c = await git(['commit', '-q', '-m', `publish ${marketId} ${version} (${s.alias || 'PC'})`], { cwd: dir });
    if (c.code !== 0) { await syncDir(s.repo); throw new HttpError(409, `게시할 변경이 없습니다: ${clean(c.stdout || c.stderr)}`); }
    const branch = (await remoteBranch(dir)) || (await localBranch(dir));
    let p = await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, repo: s.repo, timeout: 120000 });
    if (p.code !== 0) {                      // 다른 PC 가 먼저 올렸으면 그 위에 얹어서 한 번 더 시도
      const f = await git(['fetch', '-q', 'origin'], { cwd: dir, repo: s.repo, timeout: 120000 });
      const rb = f.code === 0 ? await git(['rebase', `origin/${branch}`], { cwd: dir }) : f;
      p = rb.code === 0 ? await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, repo: s.repo, timeout: 120000 }) : rb;
      if (p.code !== 0) { await git(['rebase', '--abort'], { cwd: dir }); await syncDir(s.repo).catch(() => {}); throw new HttpError(409, `게시하지 못했습니다. 다른 PC 가 동시에 올렸거나 권한이 없을 수 있습니다. 새로고침 후 다시 시도해 주세요. (${clean(p.stderr)})`); }
    }
    return { id: marketId, version, sha256: meta.sha256, publisher, updated: Boolean(cur) };
  });

  const revoke = ({ id, reason = '' }) => locked(async () => {
    const s = conf();
    need(s.enabled && s.repo, '스킬 마켓이 연결되어 있지 않습니다.', 409);
    const marketId = String(id || '').toLowerCase();
    const publisher = await myName();
    const dir = await syncDir(s.repo);
    const cur = readEntries(dir).find((e) => e.id === marketId);
    need(cur, '마켓에 없는 스킬입니다.', 404);
    need(cur.publisher === publisher, '게시한 사람만 회수할 수 있습니다.', 403);
    const rv = readRevoked(dir);
    need(!rv[marketId], '이미 회수된 스킬입니다.', 409);
    rv[marketId] = { reason: String(reason || '').slice(0, 200), at: nowIso(), by: publisher };
    writeJson(join(dir, 'revoked.json'), rv);
    await gitOk(['add', '-A'], { cwd: dir }, '회수 파일을 준비하지 못했습니다');
    await gitOk(['commit', '-q', '-m', `revoke ${marketId} (${s.alias || 'PC'})`], { cwd: dir }, '회수 내용을 기록하지 못했습니다');
    const branch = (await remoteBranch(dir)) || (await localBranch(dir));
    const p = await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir, repo: s.repo, timeout: 120000 });
    if (p.code !== 0) { await syncDir(s.repo).catch(() => {}); throw new HttpError(409, `회수하지 못했습니다. 새로고침 후 다시 시도해 주세요. (${clean(p.stderr)})`); }
    return { id: marketId, revoked: true };
  });

  // 설치·업데이트(같은 함수). 기본 규칙: 위험 요소가 있으면 사용자가 확인해야 하고, 내가 고친 스킬은 확인 없이 덮어쓰지 않는다.
  const install = ({ id, office, allowRisk = false, overwrite = false }) => locked(async () => {
    const { s, dir } = requireReady();
    const marketId = String(id || '').toLowerCase();
    need(ID_RE.test(marketId), '스킬 이름이 올바르지 않습니다.');
    const entry = readEntries(dir).find((e) => e.id === marketId);
    need(entry, '마켓에 없는 스킬입니다.', 404);
    const rv = readRevoked(dir)[marketId];
    need(!rv, `회수된 스킬이라 설치할 수 없습니다.${rv && rv.reason ? ` 사유: ${rv.reason}` : ''}`, 409);
    const { files, errors } = collectPackage(join(dir, 'skills', marketId));
    need(!errors.length && files.some((f) => f.path === 'SKILL.md'), '스킬 파일이 올바르지 않습니다.', 409, { errors });
    need(packageHash(files) === entry.sha256, '무결성 검사에 실패했습니다. 게시된 뒤 내용이 바뀌었습니다. 설치하지 않았습니다.', 409);
    const scan = scanFiles(files);
    need(!scan.blockers.length, '허용되지 않는 내용이 들어 있어 설치하지 않았습니다.', 409, { findings: scan.findings });
    need(!scan.risks.length || allowRisk, '위험할 수 있는 내용이 있습니다. 내용을 확인한 뒤 허용해 주세요.', 409, { needsConfirm: 'risks', findings: scan.findings });

    mkdirSync(office.skillsDir, { recursive: true });
    const dest = join(office.skillsDir, marketId);
    need(insideOf(office.skillsDir, dest) && dest !== resolve(office.skillsDir), '설치 위치가 올바르지 않습니다.');
    let updated = false;
    if (existsSync(dest)) {
      const mk = readInstalledMarker(dest);
      need(mk && mk.id === marketId, `이 사무실에 같은 이름의 스킬(${marketId})이 이미 있습니다. 마켓에서 받은 스킬이 아니라서 덮어쓰지 않습니다.`, 409);
      const cur = collectPackage(dest).files;
      const modified = packageHash(cur) !== mk.sha256;
      need(!(semverCmp(entry.version, mk.version) === 0 && !modified), `이미 최신 버전(${mk.version})이 설치되어 있습니다.`, 409);
      if (modified && !overwrite) {
        const before = new Map(cur.map((f) => [f.path, sha(f.buf)])), after = new Map(files.map((f) => [f.path, sha(f.buf)]));
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
        throw new HttpError(409, '설치한 뒤 직접 고친 내용이 있습니다. 덮어쓰면 고친 내용은 보관함으로 옮겨집니다.', { needsConfirm: 'overwrite', changed });
      }
      updated = true;
    }
    const tmp = join(office.skillsDir, `.market-tmp-${marketId}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    try {
      for (const f of files) {
        const p = join(tmp, ...safeParts(f.path));
        need(insideOf(tmp, p), '파일 경로가 올바르지 않습니다.');
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, f.buf);
      }
      writeJson(join(tmp, INSTALLED_FILE), { schema: 1, id: marketId, version: entry.version, sha256: entry.sha256, publisher: entry.publisher, sourceAlias: entry.sourceAlias, name: entry.name, installedAt: nowIso() });
      if (updated) {
        const bak = join(backupRoot(office), '맞춤설정_백업');
        mkdirSync(bak, { recursive: true });
        renameSync(dest, join(bak, `skill-${marketId}_${stamp()}`));
      }
      renameSync(tmp, dest);
    } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
    if (!office.external) log(office.folder, updated ? '스킬 업데이트' : '스킬 설치', entry.name, `마켓 ${marketId} v${entry.version} (게시: ${entry.publisher})`, '');
    return { id: marketId, version: entry.version, updated, needsRestart: true };
  });

  // 마켓에서 받은 스킬 제거: 지우지 않고 보관함으로 옮긴다.
  const uninstall = ({ id, office }) => locked(async () => {
    const marketId = String(id || '').toLowerCase();
    need(ID_RE.test(marketId), '스킬 이름이 올바르지 않습니다.');
    const dest = join(office.skillsDir, marketId);
    const mk = isDir(dest) ? readInstalledMarker(dest) : null;
    need(mk && mk.id === marketId, '마켓에서 받은 스킬이 아니라서 여기서 제거하지 않습니다.', 409);
    const bak = join(backupRoot(office), '스킬제거');
    mkdirSync(bak, { recursive: true });
    const to = join(bak, `${marketId}_${stamp()}`);
    renameSync(dest, to);
    if (!office.external) log(office.folder, '스킬 제거', mk.name || marketId, `마켓 ${marketId} v${mk.version} → 보관함`, '');
    return { id: marketId, movedTo: to, needsRestart: true };
  });

  // 연결을 끊는다. 복제본(cache)은 마켓에서 내려받은 사본일 뿐이라 지워도 스킬·게시 내용에는 영향이 없다.
  const purgeCache = (repo) => { rmSync(cacheDirFor(repo), { recursive: true, force: true }); };

  return { status, connect, refresh, autoSync, list, detail, shareable, inspect, publish, revoke, install, uninstall, purgeCache, _test: { cacheDirFor, readEntries, syncDir } };
}
