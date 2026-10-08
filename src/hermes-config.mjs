// Hermes 설정(config.yaml) 중 이 프로그램이 바꿀 수 있는 몇 곳만 고친다: 텔레그램에서 쓰는 기능 묶음(platform_toolsets.telegram),
// 한 번에 할 수 있는 단계 수(agent.max_turns), 기억 켜기(memory.memory_enabled), 커넥터(mcp_servers — 표식 사이 블록).
// YAML 라이브러리 없이 줄 단위로 고치므로, 알아볼 수 있는 모양일 때만 고치고 그 밖에는 손대지 않고 오류를 낸다.
// 사용자가 화면에서 직접 누른 변경만 쓰며, 쓰기 전에 원본을 이 프로그램의 데이터 폴더에 백업한다.
import { join } from 'node:path';
import { mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { CONNECTORS_DIR } from './paths.mjs';
import { readText, writeAtomic, isFile, need, stamp } from './util.mjs';

// 텔레그램에서 켜고 끌 수 있는 Hermes 기능 묶음. risk 는 화면에서 한 번 더 확인받는다.
export const HERMES_TOOLSETS = [
  { key: 'search', label: '웹 검색', desc: '인터넷에서 검색만 해요(페이지 내용은 안 읽어요).' },
  { key: 'web', label: '웹 검색 + 페이지 읽기', desc: '검색한 페이지의 내용까지 읽어서 정리해요.' },
  { key: 'browser', label: '브라우저 조작', desc: '웹 페이지를 열고 눌러 보며 일해요. Hermes 의 브라우저 설정(browser.backend)이 꺼져 있으면 동작하지 않아요.' },
  { key: 'file', label: '파일 읽기·쓰기', desc: '작업 폴더의 파일을 읽고 고쳐요.' },
  { key: 'skills', label: '스킬', desc: '설치된 스킬(업무 매뉴얼)을 찾아 쓰고, 새 스킬을 만들어요.' },
  { key: 'kanban', label: '칸반 보드', desc: '업무 카드를 만들고 옮겨요.' },
  { key: 'todo', label: '단계별 계획', desc: '긴 일을 단계로 나눠 계획하고 진행 상황을 챙겨요.' },
  { key: 'cronjob', label: '예약 작업·알림', desc: '"매일 아침 9시에 보고해 줘"처럼 정해진 시간에 스스로 일해요.' },
  { key: 'memory', label: '기억', desc: '사용자 정보와 메모를 대화가 끝나도 기억해요(기억 기능도 함께 켜요).' },
  { key: 'session_search', label: '지난 대화 찾기', desc: '예전 대화에서 필요한 내용을 찾아 요약해요.' },
  { key: 'vision', label: '사진 보기', desc: '보낸 사진·이미지를 보고 설명하거나 글자를 읽어요.' },
  { key: 'clarify', label: '되묻기', desc: '애매하면 선택지를 주고 먼저 물어봐요.' },
  { key: 'delegation', label: '나눠 맡기기', desc: '큰 일을 하위 에이전트에게 나눠 맡겨 처리해요(사용량이 늘어요).' },
  { key: 'tts', label: '음성 답장', desc: '답을 음성으로 만들어 보내요.' },
  { key: 'image_gen', label: '이미지 만들기', desc: '그림을 만들어요. 이미지 생성 서비스 키가 있어야 해요.' },
  { key: 'code_execution', label: '파이썬 코드 실행', desc: '계산·자료 정리를 파이썬 코드로 해요.', risk: '이 PC에서 코드를 실행해요.' },
  { key: 'terminal', label: '명령 실행(터미널)', desc: '이 PC에서 명령어를 실행해요.', risk: '이 PC에서 아무 명령이나 실행할 수 있어요. 파일이 지워지거나 바뀔 수 있어요.' },
];
const KNOWN = new Set(HERMES_TOOLSETS.map((t) => t.key));
export const MAX_TURNS = { min: 2, max: 60 };

export const configFile = (o) => join(o.folder, 'config.yaml');
export function readConfig(o) {
  const f = configFile(o);
  need(isFile(f), 'Hermes 설정 파일(config.yaml)을 찾지 못했습니다.', 404);
  return readText(f);
}

// 바꾸기 전에 데이터 폴더에 백업(최근 10개만 남긴다)하고, 줄바꿈 모양은 원본을 따른다.
export function writeConfig(o, text) {
  const f = configFile(o);
  const dir = join(CONNECTORS_DIR, 'backup', o.id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(f, join(dir, `config.yaml.${stamp()}.${Date.now() % 1000}`));
  const old = readdirSync(dir).filter((n) => n.startsWith('config.yaml.')).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 10))) rmSync(join(dir, n), { force: true });
  const crlf = /\r\n/.test(readText(f));
  writeAtomic(f, crlf ? text.replace(/\r?\n/g, '\r\n') : text);
}

// ── 줄 단위 도우미 ──
const lines = (text) => text.replace(/\r\n/g, '\n').split('\n');
const indentOf = (l) => /^ */.exec(l)[0].length;
const blankOrComment = (l) => /^\s*(#.*)?$/.test(l);
const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

// 최상위 키(들여쓰기 0) 블록의 [시작, 끝) 줄 번호. 없으면 null.
function topBlock(ls, key) {
  const start = ls.findIndex((l) => new RegExp(`^${key}:(\\s.*)?$`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < ls.length && (blankOrComment(ls[end]) || indentOf(ls[end]) > 0 || /^- /.test(ls[end]))) end++;
  while (end > start + 1 && blankOrComment(ls[end - 1])) end--;   // 블록 뒤의 빈 줄·주석은 다음 블록 몫으로 둔다
  return { start, end };
}
// 블록 안의 자식 키 줄 번호(가장 얕은 들여쓰기의 자식만)
function childLine(ls, block, key) {
  let depth = null;
  for (let i = block.start + 1; i < block.end; i++) {
    if (blankOrComment(ls[i])) continue;
    const d = indentOf(ls[i]);
    if (depth === null) depth = d;
    if (d === depth && new RegExp(`^ *${key}:(\\s.*)?$`).test(ls[i])) return { i, depth };
  }
  return { i: -1, depth: depth ?? 2 };
}

// platform_toolsets.telegram 목록 읽기. 키가 없으면 null(= Hermes 기본값).
export function readToolsets(text) {
  const ls = lines(text);
  const block = topBlock(ls, 'platform_toolsets');
  if (!block) return null;
  const { i } = childLine(ls, block, 'telegram');
  if (i < 0) return null;
  const flow = /^ *telegram:\s*\[(.*)\]\s*(#.*)?$/.exec(ls[i]);
  if (flow) return flow[1].split(',').map(unquote).filter(Boolean);
  need(/^ *telegram:\s*(#.*)?$/.test(ls[i]), 'Hermes 설정의 platform_toolsets.telegram 모양을 알아보지 못해 건드리지 않았습니다.', 409);
  const out = [];
  for (let j = i + 1; j < block.end; j++) {
    if (blankOrComment(ls[j])) continue;
    const m = /^ *- +(.+?)\s*(#.*)?$/.exec(ls[j]);
    if (!m || indentOf(ls[j]) < indentOf(ls[i])) break;
    out.push(unquote(m[1]));
  }
  return out;
}

export function writeToolsets(text, list) {
  const ls = lines(text);
  const item = (pad) => list.map((k) => `${pad}- ${k}`);
  let block = topBlock(ls, 'platform_toolsets');
  if (!block) {
    while (ls.length && ls[ls.length - 1] === '') ls.pop();
    ls.push('platform_toolsets:', '  telegram:', ...item('    '), '');
    return ls.join('\n');
  }
  const { i, depth } = childLine(ls, block, 'telegram');
  const pad = ' '.repeat(depth);
  if (i < 0) { ls.splice(block.start + 1, 0, `${pad}telegram:`, ...item(pad + '  ')); return ls.join('\n'); }
  readToolsets(text);   // 모양 확인(알아볼 수 없으면 오류)
  let j = i + 1;
  while (j < block.end && (blankOrComment(ls[j]) || (/^ *- /.test(ls[j]) && indentOf(ls[j]) >= indentOf(ls[i])))) j++;
  while (j > i + 1 && blankOrComment(ls[j - 1])) j--;
  ls.splice(i, j - i, `${pad}telegram:`, ...item(pad + '  '));
  return ls.join('\n');
}

// 최상위 블록 안의 스칼라 값(예: agent.max_turns) 읽기·쓰기. 없으면 만든다.
export function readScalar(text, parent, key) {
  const ls = lines(text);
  const block = topBlock(ls, parent);
  if (!block) return undefined;
  const { i } = childLine(ls, block, key);
  if (i < 0) return undefined;
  return unquote(ls[i].replace(new RegExp(`^ *${key}:`), '').replace(/\s#.*$/, ''));
}
export function writeScalar(text, parent, key, value) {
  const ls = lines(text);
  const block = topBlock(ls, parent);
  if (!block) {
    while (ls.length && ls[ls.length - 1] === '') ls.pop();
    ls.push(`${parent}:`, `  ${key}: ${value}`, '');
    return ls.join('\n');
  }
  const { i, depth } = childLine(ls, block, key);
  if (i < 0) ls.splice(block.start + 1, 0, `${' '.repeat(depth)}${key}: ${value}`);
  else {
    need(!/:\s*$/.test(ls[i]), `Hermes 설정의 ${parent}.${key} 모양을 알아보지 못해 건드리지 않았습니다.`, 409);
    ls[i] = `${' '.repeat(depth)}${key}: ${value}`;
  }
  return ls.join('\n');
}

// ── 커넥터(mcp_servers) ──
// 이 프로그램이 쓴 블록은 표식으로 감싸 두고 그 안만 바꾼다. 사용자가 직접 적은 mcp_servers 가 있으면 덮어쓰지 않는다.
const MCP_BEGIN = '# >>> LAPIS:CONNECTORS — LAPIS 앱의 「커넥터」 화면이 관리합니다. 여기를 직접 고치면 다음 저장 때 덮어써요.';
const MCP_END = '# <<< LAPIS:CONNECTORS';

// 표식 밖에 mcp_servers 가 있으면 사용자가 직접 적은 것이다. 단, 그 안의 서버가 모두 이 프로그램이 넣었던 이름(owned)이면
// 다른 도구(예: 설정 화면이 YAML 을 다시 쓰며 주석을 지운 경우)가 표식만 지운 것이므로 우리 것으로 본다.
function ownBlock(ls, owned) {
  const block = topBlock(ls, 'mcp_servers');
  if (!block || !owned.length) return null;
  const names = [];
  for (let i = block.start + 1; i < block.end; i++) {
    if (blankOrComment(ls[i]) || indentOf(ls[i]) !== 2) continue;
    const m = /^ {2}(?:"([^"]+)"|'([^']+)'|([^\s:#'"]+)):/.exec(ls[i]);
    if (m) names.push(m[1] || m[2] || m[3]);
  }
  return names.length && names.every((n) => owned.includes(n)) ? block : null;
}
export function hasForeignMcp(text, owned = []) {
  const ls = lines(text);
  const b = ls.indexOf(MCP_BEGIN), e = ls.indexOf(MCP_END);
  const own = ownBlock(ls, owned);
  return ls.some((l, i) => /^mcp_servers:/.test(l) && !(b >= 0 && e > b && i > b && i < e) && !(own && i === own.start));
}

// servers: { 이름: {command,args,env} | {url,headers} }. 비어 있으면 블록을 지운다.
// 값은 JSON 흐름 표기로 쓴다(JSON 은 YAML 의 부분집합이라 따옴표·역슬래시가 그대로 통한다).
export function writeMcpServers(text, servers, owned = []) {
  need(!hasForeignMcp(text, owned), 'Hermes 설정에 직접 적은 mcp_servers 가 이미 있어서 건드리지 않았습니다. config.yaml 의 mcp_servers 를 지우거나 그 안에 직접 추가해 주세요.', 409);
  const ls = lines(text);
  const b = ls.indexOf(MCP_BEGIN), e = ls.indexOf(MCP_END);
  if (b >= 0 && e > b) {
    ls.splice(b, e - b + 1);
    if (ls[b] === '' && ls[b - 1] === '') ls.splice(b, 1);
  } else {
    const own = ownBlock(ls, owned);   // 표식이 지워진 우리 블록
    if (own) ls.splice(own.start, own.end - own.start);
  }
  const names = Object.keys(servers);
  if (names.length) {
    while (ls.length && ls[ls.length - 1] === '') ls.pop();
    ls.push('', MCP_BEGIN, 'mcp_servers:', ...names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(servers[n])}`), MCP_END, '');
  } else if (ls[ls.length - 1] !== '') ls.push('');
  return ls.join('\n');
}

// 화면용 요약: 켜진 기능 묶음과 단계 수
export function toolsView(text) {
  const list = readToolsets(text);
  const on = new Set(list || []);
  const turns = Number(readScalar(text, 'agent', 'max_turns'));
  const memory = String(readScalar(text, 'memory', 'memory_enabled')) === 'true';
  return {
    explicit: list !== null,
    toolsets: HERMES_TOOLSETS.map((t) => ({ ...t, on: on.has(t.key) && (t.key !== 'memory' || memory) })),
    others: (list || []).filter((k) => !KNOWN.has(k)),   // 플러그인·MCP 이름 등은 그대로 둔다
    maxTurns: Number.isInteger(turns) ? turns : null,
  };
}

// 기능 묶음·단계 수 바꾸기. 목록에 없는 항목(플러그인 등)은 그대로 둔다.
export function applyTools(text, { toolsets, maxTurns, confirmRisk } = {}) {
  let out = text;
  if (toolsets !== undefined) {
    need(Array.isArray(toolsets) && toolsets.every((k) => KNOWN.has(k)), '알 수 없는 기능이 들어 있습니다.');
    const before = new Set(readToolsets(text) || []);
    const risky = HERMES_TOOLSETS.filter((t) => t.risk && toolsets.includes(t.key) && !before.has(t.key));
    need(!risky.length || confirmRisk === true, `${risky.map((t) => t.label).join('·')}은(는) 이 PC에서 직접 실행하는 기능이라 확인이 필요합니다.`);
    // 원래 순서를 지킨다: 남는 항목(모르는 항목 포함)은 제자리, 새로 켠 것만 뒤에 붙인다.
    const cur = readToolsets(text) || [];
    const next = [...cur.filter((k) => !KNOWN.has(k) || toolsets.includes(k)), ...HERMES_TOOLSETS.map((t) => t.key).filter((k) => toolsets.includes(k) && !cur.includes(k))];
    out = writeToolsets(out, next);
    const mem = String(readScalar(out, 'memory', 'memory_enabled')) === 'true';
    if (toolsets.includes('memory') !== mem) out = writeScalar(out, 'memory', 'memory_enabled', toolsets.includes('memory') ? 'true' : 'false');
  }
  if (maxTurns !== undefined && maxTurns !== null) {
    need(Number.isInteger(maxTurns) && maxTurns >= MAX_TURNS.min && maxTurns <= MAX_TURNS.max, `단계 수는 ${MAX_TURNS.min}~${MAX_TURNS.max} 사이로 정해 주세요.`);
    out = writeScalar(out, 'agent', 'max_turns', String(maxTurns));
  }
  return out;
}
