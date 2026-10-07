// 부서(팀) 관리: 추가·수정·삭제. 부서는 사무실 폴더의 .claude/agents/<key>.md (Claude Code 서브에이전트)이며,
// 목록의 기준은 <사무실>/.ai-office/office.json 이다. 바꿀 때마다 CLAUDE.md 의 조직도 표도 함께 맞춘다.
// 삭제는 파일을 지우지 않고 <사무실>/보관함/부서보관/ 으로 옮긴다.
import { join, basename } from 'node:path';
import { readdirSync, mkdirSync, renameSync, copyFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { readText, readJson, writeJson, writeAtomic, isDir, isFile, nowIso, stamp, localDate, need, slug } from './util.mjs';
import { parseFrontmatter } from './skills.mjs';
import { presetByKey } from './presets.mjs';
import { readDurableJson, writeDurableJson } from './durable-json.mjs';

export const officeJsonPath = (folder) => join(folder, '.ai-office', 'office.json');
export const agentsDir = (folder) => join(folder, '.claude', 'agents');
const COLORS = ['blue', 'green', 'purple', 'orange', 'pink', 'cyan', 'yellow', 'red'];
const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;
const MARK_START = '<!-- AI-OFFICE:TEAMS:START';
const MARK_END = '<!-- AI-OFFICE:TEAMS:END -->';

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const oneLine = (s, max) => clean(s, max).replace(/\s*[\r\n]+\s*/g, ' ');

// ── 사무실 정보 읽기/쓰기 ──
function labelFrom(desc, key) {
  const m = /^([^.(（:：]+?)장?\s*[.(（:：]/.exec(desc || '');
  const n = m && m[1].trim();
  return n && n.length <= 20 ? n : key;
}
const LEGACY_EMOJI = {
  'policy-planner': '📋', 'event-planner': '🎪', 'event-operator': '🧭', 'pr-marketer': '📣', 'community-manager': '💬',
  'rental-manager': '📦', developer: '💻', researcher: '🔎', 'qa-reviewer': '✅',
};

// 이미 있는 사무실(office.json 이 없는 폴더)은 에이전트 파일에서 부서 목록을 읽어 온다.
function scanAgentTeams(folder) {
  const dir = agentsDir(folder);
  if (!isDir(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const fm = parseFrontmatter(readText(join(dir, f)));
    const key = fm.name || basename(f, '.md');
    const desc = fm.description || '';
    out.push({
      key, name: labelFrom(desc, key), emoji: LEGACY_EMOJI[key] || presetByKey(key)?.emoji || '🏷️',
      role: oneLine(desc.replace(/^[^.]*\.\s*/, ''), 160) || desc, description: desc,
      model: fm.model || 'inherit', color: fm.color || '', managed: false,
    });
  }
  return out;
}

export function loadOffice(folder) {
  const { value: saved, status } = readDurableJson(officeJsonPath(folder), validOffice);
  const retiredDocument = readDurableJson(retiredJsonPath(folder), validRetired);
  const retiredTeams = retiredDocument.value?.retiredTeams || saved?.retiredTeams || [];
  const retired = new Set(retiredTeams.map(t => t.key));
  const scanned = scanAgentTeams(folder);
  if (saved) {
    const teams = saved.teams.filter(t => !retired.has(t.key));
    const known = new Set(teams.map(t => t.key));
    return { ...saved, retiredTeams, teams: [...teams, ...scanned.filter(t => !known.has(t.key) && !retired.has(t.key))], imported: false,
      recovery: { status, recoveredKeys: scanned.filter(t => !known.has(t.key) && !retired.has(t.key)).map(t => t.key) } };
  }
  return { version: 1, name: basename(folder), honorific: null, teams: scanned.filter(t => !retired.has(t.key)), retiredTeams, imported: true,
    recovery: { status, recoveredKeys: scanned.map(t => t.key) } };
}

const retiredJsonPath = folder => join(folder, '.ai-office', 'retired-teams.json');
const validRetired = o => Boolean(o && Array.isArray(o.retiredTeams) && o.retiredTeams.every(t => t && typeof t.key === 'string'));

const validOffice = o => Boolean(o && Array.isArray(o.teams) && o.teams.every(t => t && typeof t.key === 'string' && /^[a-zA-Z0-9_-]+$/.test(t.key))
  && new Set(o.teams.map(t => t.key)).size === o.teams.length && (!o.retiredTeams || Array.isArray(o.retiredTeams)));

export function saveOffice(folder, office) {
  const current = readDurableJson(officeJsonPath(folder), validOffice);
  need(current.status !== 'damaged' || office.teams?.length, '조직 설정이 손상되어 빈 조직으로 덮어쓰지 않습니다. 먼저 복구해 주세요.', 409);
  const { imported, recovery, ...rest } = office;
  // Keep deletion decisions independent of an older organization recovery copy.
  writeDurableJson(retiredJsonPath(folder), { retiredTeams: rest.retiredTeams || [] }, validRetired);
  writeDurableJson(officeJsonPath(folder), { ...rest, updatedAt: nowIso() }, validOffice);
}

function ensureSaved(folder) {
  const office = loadOffice(folder);
  if (office.imported) { office.imported = false; saveOffice(folder, office); }
  return office;
}

// ── 변경 이력 ──
export function logChange(folder, type, name, summary, request = '') {
  const dir = join(folder, '업무데이터', '맞춤설정');
  const file = join(dir, '변경이력.csv');
  try {
    mkdirSync(dir, { recursive: true });
    if (!isFile(file)) writeFileSync(file, '﻿날짜,구분,이름,내용,요청\r\n', 'utf8');
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    appendFileSync(file, [localDate(), type, name, summary, request].map(q).join(',') + '\r\n', 'utf8');
  } catch { /* 이력은 보조 기능이라 실패해도 본 작업은 계속한다 */ }
}

// ── 에이전트 파일 만들기 ──
export function renderAgent(office, team) {
  const honorific = office.honorific || '사용자님';
  const desc = oneLine(team.description || `${team.name}장. ${team.role} 일을 맡길 때 쓴다.`, 400);
  return [
    '---',
    `name: ${team.key}`,
    `description: ${desc}`,
    `model: ${team.model || 'sonnet'}`,
    `color: ${team.color || 'blue'}`,
    'disallowedTools: mcp__plugin_telegram_telegram',
    '---',
    '',
    `너는 ${office.name || 'AI-Office'}의 **${team.name}** 팀장이다.`,
    `담당 업무: ${team.role}`,
    '',
    team.instructions ? team.instructions.trim() : '- 요청받은 일을 정확하고 간결하게 처리한다.',
    '',
    '## 공통 규칙',
    `- 사용자는 "${honorific}"이라고 부른다.`,
    '- 텔레그램에는 직접 글을 보내지 않는다. 결과는 비서실장이 보고한다.',
    '- 산출물은 `결과물/YYYY-MM-DD_업무명/` 폴더에 저장하고, 마지막에 파일 경로를 알려준다.',
    '- 파일은 삭제하지 않는다. 필요 없으면 `보관함/`으로 옮긴다.',
    '- 모르는 것은 추측하지 말고 "확인 필요"로 표시한다. 개인정보는 최소한으로 다룬다.',
    '- 끝나면 ① 만든 파일 경로 ② 핵심 결과 3줄 ③ 확인이 필요한 사항 순서로 돌려준다.',
    '',
  ].join('\n');
}

const agentFile = (folder, key) => join(agentsDir(folder), `${key}.md`);

function makeKey(name, office) {
  let base = slug(name);
  if (!/^[a-z]/.test(base)) base = base ? `d-${base}` : `dept-${Math.random().toString(36).slice(2, 6)}`;
  if (base.length < 2) base = `dept-${base}`;
  let key = base, n = 2;
  while (office.teams.some((t) => t.key === key)) key = `${base}-${n++}`;
  return key;
}

// ── 조직도 표를 CLAUDE.md 에 반영 ──
export function renderTeamsBlock(teams) {
  const rows = teams.map((t) => `| ${t.name} | \`${t.key}\` | ${oneLine(t.role, 200).replace(/\|/g, '/')} |`);
  return [`${MARK_START} (자동 생성: 현황판의 부서 관리나 \`ai-office team\` 명령으로 바꿉니다) -->`,
    '| 팀 | 에이전트 | 담당 업무 |', '|---|---|---|', ...rows, MARK_END].join('\n');
}

export function syncClaudeMd(folder) {
  const f = join(folder, 'CLAUDE.md');
  if (!isFile(f)) return false;
  let text = readText(f);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const block = renderTeamsBlock(loadOffice(folder).teams);
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`);
  if (re.test(text)) {
    text = text.replace(re, () => block.replace(/\n/g, nl));
  } else {
    // 표식이 없는 기존 사무실: '## 조직도' 아래 첫 번째 표를 표식이 든 표로 바꾼다(원본은 한 번 백업).
    const lines = text.split(/\r?\n/);
    const h = lines.findIndex((l) => /^##\s*조직도/.test(l));
    if (h < 0) return false;
    let s = -1, e = -1;
    for (let j = h + 1; j < lines.length; j++) {
      if (/^\s*\|/.test(lines[j])) { if (s < 0) s = j; e = j; }
      else if (s >= 0) break;
      else if (/^##\s/.test(lines[j])) break;
    }
    if (s < 0) return false;
    const bak = `${f}.bak-${localDate()}`;
    if (!isFile(bak)) copyFileSync(f, bak);
    lines.splice(s, e - s + 1, ...block.split('\n'));
    text = lines.join(nl);
  }
  writeAtomic(f, text);
  return true;
}

// ── 목록·상세 ──
export function listTeams(folder) {
  return loadOffice(folder).teams.map((t) => ({ ...t, fileExists: isFile(agentFile(folder, t.key)) }));
}

export function getTeamDetail(folder, key) {
  const t = loadOffice(folder).teams.find((x) => x.key === key);
  need(t, `없는 부서입니다: ${key}`, 404);
  let instructions = t.instructions || '';
  if (t.managed === false) {
    try { const text = readText(agentFile(folder, key)); instructions = text.slice(parseFrontmatter(text).bodyStart).trim(); } catch { instructions = ''; }
  }
  return { ...t, instructions, fileExists: isFile(agentFile(folder, key)) };
}

// ── 추가·수정·삭제 ──
export function addTeam(folder, input = {}) {
  need(isDir(folder), '사무실 폴더를 찾을 수 없습니다.', 404);
  const office = ensureSaved(folder);
  const preset = input.preset ? presetByKey(input.preset) : null;
  need(!input.preset || preset, `없는 추천 부서입니다: ${input.preset}`);
  const name = oneLine(input.name ?? preset?.name, 30);
  need(name, '부서 이름을 적어 주세요.');
  const role = oneLine(input.role ?? preset?.role, 200);
  need(role, '담당 업무를 한 줄로 적어 주세요.');
  const key = String(input.key ?? preset?.key ?? makeKey(name, office)).toLowerCase();
  need(KEY_RE.test(key), '부서 키는 영문 소문자로 시작하는 2~31자(영문·숫자·하이픈)여야 합니다.');
  need(!office.teams.some((t) => t.key === key), `이미 있는 부서입니다: ${key}`);
  need(!isFile(agentFile(folder, key)), `같은 이름의 에이전트 파일이 이미 있습니다: ${key}.md`);
  const team = {
    key, name, emoji: clean(input.emoji ?? preset?.emoji ?? '🏷️', 8) || '🏷️', role,
    description: oneLine(input.description ?? preset?.description ?? '', 400) || `${name}장. ${role} 일을 맡길 때 쓴다.`,
    instructions: clean(input.instructions ?? preset?.instructions ?? '', 4000),
    model: ['sonnet', 'opus', 'haiku', 'inherit'].includes(input.model) ? input.model : 'sonnet',
    color: COLORS[office.teams.length % COLORS.length], managed: true, addedAt: nowIso(),
  };
  mkdirSync(agentsDir(folder), { recursive: true });
  writeAtomic(agentFile(folder, key), renderAgent(office, team));
  office.teams.push(team);
  office.retiredTeams = (office.retiredTeams || []).filter(t => t.key !== key);
  saveOffice(folder, office);
  syncClaudeMd(folder);
  logChange(folder, '부서 추가', team.name, team.role, input.request || '');
  return team;
}

export function updateTeam(folder, key, patch = {}) {
  const office = ensureSaved(folder);
  const t = office.teams.find((x) => x.key === key);
  need(t, `없는 부서입니다: ${key}`, 404);
  if ('name' in patch) { t.name = oneLine(patch.name, 30); need(t.name, '부서 이름을 적어 주세요.'); }
  if ('role' in patch) { t.role = oneLine(patch.role, 200); need(t.role, '담당 업무를 적어 주세요.'); }
  if ('emoji' in patch) t.emoji = clean(patch.emoji, 8) || t.emoji;
  if ('description' in patch && patch.description) t.description = oneLine(patch.description, 400);
  if ('model' in patch && ['sonnet', 'opus', 'haiku', 'inherit'].includes(patch.model)) t.model = patch.model;
  if (t.managed !== false) {
    if ('instructions' in patch) t.instructions = clean(patch.instructions, 4000);
    writeAtomic(agentFile(folder, key), renderAgent(office, t));
  } else if ('instructions' in patch) {
    // 직접 쓴 에이전트 파일: 본문만 바꾸고 원본은 백업한다.
    const file = agentFile(folder, key);
    const text = readText(file);
    const bak = join(folder, '보관함', '맞춤설정_백업');
    mkdirSync(bak, { recursive: true });
    copyFileSync(file, join(bak, `${stamp()}_${key}.md`));
    writeAtomic(file, text.slice(0, parseFrontmatter(text).bodyStart) + '\n\n' + clean(patch.instructions, 8000) + '\n');
  }
  saveOffice(folder, office);
  syncClaudeMd(folder);
  logChange(folder, '부서 수정', t.name, t.role, patch.request || '');
  return t;
}

export function removeTeam(folder, key, request = '') {
  const office = ensureSaved(folder);
  const i = office.teams.findIndex((x) => x.key === key);
  need(i >= 0, `없는 부서입니다: ${key}`, 404);
  const [t] = office.teams.splice(i, 1);
  office.retiredTeams = [...(office.retiredTeams || []).filter(x => x.key !== key), { key, retiredAt: nowIso() }];
  const file = agentFile(folder, key);
  if (isFile(file)) {
    const dir = join(folder, '보관함', '부서보관');
    mkdirSync(dir, { recursive: true });
    renameSync(file, join(dir, `${key}_${stamp()}.md`));
  }
  saveOffice(folder, office);
  syncClaudeMd(folder);
  logChange(folder, '부서 삭제', t.name, '보관함/부서보관으로 이동', request);
  return t;
}
