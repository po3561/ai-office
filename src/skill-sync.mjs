// Claude(전역·사무실)와 Codex 의 스킬 폴더를 같은 세트로 맞춘다.
// - 스킬 = SKILL.md 가 든 폴더. 없는 쪽에는 복사하고, 어느 쪽도 지우지 않는다.
// - 양쪽에 있는데 내용이 다르면 기본은 "충돌"로 알리기만 한다. prefer: 'newer' 면 더 최근에 고친 쪽으로 덮어쓰되,
//   덮이는 쪽 원본은 <스킬 폴더>/.sync-backup/ 에 보관한다.
// - 이 프로그램이 관리하는 폴더(.system, synced 등 점으로 시작하거나 제외 목록에 있는 것)와 마켓 설치 기록은 건드리지 않는다.
import { readdirSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isDir, isFile, readJson, copyTree, stamp } from './util.mjs';
import { CLAUDE_HOME, FILES } from './paths.mjs';

export const DEFAULT_EXCLUDE = ['synced', 'codex-primary-runtime'];
const IGNORED_FILES = new Set(['.market-installed.json', '.DS_Store', 'Thumbs.db']);

export const codexSkillsDir = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');

// 동기화 대상 폴더 목록: Claude 전역, Codex, 등록된 Claude 사무실(Hermes 같은 외부 봇은 제외)
export function defaultRoots() {
  const roots = [
    { id: 'claude', label: 'Claude 전역', dir: join(CLAUDE_HOME, 'skills') },
    { id: 'codex', label: 'Codex', dir: codexSkillsDir() },
  ];
  const reg = readJson(FILES.offices, { offices: [] });
  for (const o of reg.offices || []) {
    if (!o || o.readonly || o.kind === 'hermes' || !o.folder) continue;
    roots.push({ id: `office:${o.id}`, label: `사무실 ${o.name || o.id}`, dir: join(o.folder, '.claude', 'skills') });
  }
  return roots;
}

function listSkills(dir, exclude) {
  if (!isDir(dir)) return new Map();
  const out = new Map();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || exclude.has(e.name)) continue;
    if (isFile(join(dir, e.name, 'SKILL.md'))) out.set(e.name, join(dir, e.name));
  }
  return out;
}

// 폴더 안 모든 파일(경로+내용)의 해시와 가장 최근 수정 시각
function fingerprint(skillDir) {
  const h = createHash('sha256');
  let newest = 0;
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (IGNORED_FILES.has(e.name)) continue;
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        h.update(r + '\0'); h.update(readFileSync(p)); h.update('\0');
        newest = Math.max(newest, statSync(p).mtimeMs);
      }
    }
  };
  walk(skillDir, '');
  return { hash: h.digest('hex'), mtimeMs: newest };
}

const skipMarket = (p) => !p.endsWith('.market-installed.json');

/**
 * 사무실에만 있는 스킬(업무 전용)은 기본적으로 Claude 전역(모든 프로젝트)으로 올리지 않는다. officeToGlobal 로 허용한다.
 * @param {{roots?: {id:string,label:string,dir:string}[], exclude?: string[], dryRun?: boolean, prefer?: 'newer'|null, officeToGlobal?: boolean}} opt
 * @returns {{copied: object[], updated: object[], conflicts: object[], same: number, roots: object[]}}
 */
export function syncSkills({ roots = defaultRoots(), exclude = [], dryRun = false, prefer = null, officeToGlobal = false } = {}) {
  const ex = new Set([...DEFAULT_EXCLUDE, ...exclude]);
  // 스킬 폴더가 아직 없는 사무실은 건너뛴다(사무실 폴더가 없으면 만들지 않는다). Claude 전역·Codex 는 상위 폴더가 있으면 만든다.
  const live = roots.filter((r) => isDir(join(r.dir, '..')));
  const state = live.map((r) => ({ ...r, skills: listSkills(r.dir, ex) }));
  const names = [...new Set(state.flatMap((r) => [...r.skills.keys()]))].sort();
  const res = { copied: [], updated: [], conflicts: [], same: 0, roots: live.map((r) => ({ id: r.id, label: r.label, dir: r.dir })) };

  for (const name of names) {
    const have = state.filter((r) => r.skills.has(name)).map((r) => ({ r, fp: fingerprint(r.skills.get(name)) }));
    const distinct = new Set(have.map((x) => x.fp.hash));
    let source = have[0];
    if (distinct.size > 1) {
      const newest = [...have].sort((a, b) => b.fp.mtimeMs - a.fp.mtimeMs)[0];
      if (prefer !== 'newer') {
        res.conflicts.push({ name, versions: have.map((x) => ({ root: x.r.id, modifiedAt: new Date(x.fp.mtimeMs).toISOString(), newest: x === newest })) });
        source = null;
      } else source = newest;
    }
    if (!source) continue;
    let allSame = true;
    for (const r of state) {
      const dest = join(r.dir, name);
      const cur = have.find((x) => x.r === r);
      if (cur && cur.fp.hash === source.fp.hash) continue;
      if (!officeToGlobal && !cur && r.id === 'claude' && have.every((x) => x.r.id.startsWith('office:') || x.r.id === 'codex') && have.some((x) => x.r.id.startsWith('office:'))) continue;
      allSame = false;
      const item = { name, from: source.r.id, to: r.id };
      if (cur) {   // 덮어쓰기: 원본은 .sync-backup 에 보관
        if (!dryRun) {
          const bak = join(r.dir, '.sync-backup', `${name}-${stamp()}`);
          copyTree(dest, bak, skipMarket);
          copyTree(source.r.skills.get(name), dest, skipMarket);
        }
        res.updated.push(item);
      } else {
        if (!dryRun) { mkdirSync(r.dir, { recursive: true }); copyTree(source.r.skills.get(name), dest, skipMarket); }
        res.copied.push(item);
      }
    }
    if (allSame) res.same++;
  }
  return res;
}

export function formatReport(res, { dryRun = false } = {}) {
  const lines = [];
  const tag = dryRun ? '(미리보기) ' : '';
  lines.push(`${tag}대상 ${res.roots.length}곳: ${res.roots.map((r) => r.label).join(', ')}`);
  for (const c of res.copied) lines.push(`${tag}+ ${c.name}  ${c.from} → ${c.to}`);
  for (const c of res.updated) lines.push(`${tag}↻ ${c.name}  ${c.from} → ${c.to} (원본은 .sync-backup 에 보관)`);
  for (const c of res.conflicts) lines.push(`⚠️ 충돌 ${c.name}: ${c.versions.map((v) => `${v.root}${v.newest ? '(최신)' : ''}`).join(' / ')} — 직접 고르거나 --prefer newer`);
  lines.push(`${tag}복사 ${res.copied.length} · 덮어씀 ${res.updated.length} · 충돌 ${res.conflicts.length} · 이미 같음 ${res.same}`);
  return lines.join('\n');
}
