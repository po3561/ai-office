// 봇이 실제로 일한 흔적을 읽어 상태와 사용량을 보여 준다. 읽기 전용이며 어떤 파일도 고치지 않는다.
//  - Claude 사무실: Claude Code 대화 기록(<CLAUDE_HOME>/projects/<폴더 이름>/*.jsonl)의 응답별 토큰, 한도 초과·API 오류, 텔레그램 수신·답장 시각
//  - Hermes: 프로필의 state.db(세션·모델별 토큰), gateway_state.json(텔레그램 연결), logs/errors.log(응답 실패·차단)
// 숫자는 공급자가 남긴 값만 쓴다. 기록이 없으면 0 이 아니라 "없음"으로 둔다.
import { openSync, readSync, closeSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.mjs';
import { officeProjectDirs } from './roomlog.mjs';

const DAY = 86400000;
const KEEP_DAYS = 40;          // 이보다 오래된 대화 기록 파일은 읽지 않는다
const TAIL_BYTES = 512 * 1024; // 오류 로그는 끝부분만 읽는다
const CONTEXT_WARN = 150000;   // 한 번 답할 때 다시 읽는 대화 길이(토큰)가 이보다 크면 알린다

const clip = (s, n = 200) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const later = (a, b) => (!a ? b : !b ? a : (Date.parse(a) >= Date.parse(b) ? a : b));
const iso = (sec) => (Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : '');
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "You've hit your weekly limit · resets Oct 10, 4pm (Asia/Seoul)" → "주간 한도 초과 · 10월 10일 오후 4시에 풀려요"
export function limitText(text) {
  const t = String(text || '');
  const kind = /weekly/i.test(t) ? '주간 한도' : /session|5-hour|hour/i.test(t) ? '5시간 한도' : /opus/i.test(t) ? 'Opus 한도' : '사용 한도';
  const m = /resets?\s+(?:on\s+)?(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
  if (!m) return `${kind} 초과`;
  let hour = Number(m[3]) % 12; if (/pm/i.test(m[5])) hour += 12;
  const when = `${m[1] && MONTHS[m[1].toLowerCase()] ? `${MONTHS[m[1].toLowerCase()]}월 ${Number(m[2])}일 ` : ''}${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}시${m[4] && m[4] !== '00' ? ` ${Number(m[4])}분` : ''}`;
  return `${kind} 초과 · ${when}에 풀려요`;
}

const isLimit = (text) => /\blimit\b/i.test(text) && /\breset/i.test(text);
const channelText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
  return '';
};

// ── Claude 대화 기록 한 파일: 새로 붙은 줄만 이어서 읽는다 ──
function freshClaudeFile() {
  return { size: 0, offset: 0, events: new Map(), incidents: [], inboundAt: '', replyAt: '', tgReplyAt: '', context: null };
}

function readClaudeLine(state, line) {
  let j; try { j = JSON.parse(line); } catch { return; }
  if (!j || typeof j !== 'object') return;
  const at = typeof j.timestamp === 'string' && Number.isFinite(Date.parse(j.timestamp)) ? j.timestamp : '';
  if (!at) return;
  if (j.type === 'user') {
    if (/^\s*<channel source="plugin:telegram/.test(channelText(j.message && j.message.content))) state.inboundAt = later(state.inboundAt, at);
    return;
  }
  if (j.type !== 'assistant' || !j.message) return;
  const m = j.message;
  const text = channelText(m.content);
  if (j.isApiErrorMessage || m.model === '<synthetic>') {
    if (text) state.incidents.push({ kind: isLimit(text) ? 'limit' : 'api-error', at, text: clip(redact(text)) });
    return;
  }
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c && c.type === 'tool_use' && /telegram/i.test(c.name || '') && /reply|send/i.test(c.name || '')) state.tgReplyAt = later(state.tgReplyAt, at);
  }
  const u = m.usage;
  if (!u || typeof m.model !== 'string' || !m.model) return;
  state.replyAt = later(state.replyAt, at);
  const read = count(u.cache_read_input_tokens), write = count(u.cache_creation_input_tokens);
  const input = count(u.input_tokens) + read + write;
  // 한 응답이 내용 조각마다 줄을 따로 남기므로(같은 id) 하나로 센다. 뒤 줄의 값이 최종값이다.
  const key = String(j.requestId || m.id || j.uuid || at);
  const prev = state.events.get(key);
  state.events.set(key, { requestId: 'claude:' + key, provider: 'claude', model: m.model, at: prev ? prev.at : at,
    status: 'measured', inputTokens: input, outputTokens: count(u.output_tokens), cacheReadTokens: read, cacheWriteTokens: write });
  if (!state.context || Date.parse(at) >= Date.parse(state.context.at)) state.context = { at, tokens: input };
}

function scanClaudeFile(file, state) {
  let st; try { st = statSync(file); } catch { return null; }
  if (!state || st.size < state.size) state = freshClaudeFile(); // 파일이 줄었으면 처음부터
  if (st.size === state.offset) { state.size = st.size; return state; }
  let fd; try { fd = openSync(file, 'r'); } catch { return state; }
  try {
    const length = st.size - state.offset;
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) { const n = readSync(fd, buf, got, length - got, state.offset + got); if (!n) break; got += n; }
    const end = buf.subarray(0, got).lastIndexOf(0x0a);   // 줄바꿈 바이트는 한글 글자 안에 나오지 않는다
    if (end >= 0) {
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) if (line.trim()) readClaudeLine(state, line);
      state.offset += end + 1;
    }
    state.size = st.size;
  } finally { closeSync(fd); }
  return state;
}

// ── Hermes 오류 로그 끝부분 ──
function tail(file, bytes = TAIL_BYTES) {
  let fd; try { fd = openSync(file, 'r'); } catch { return ''; }
  try {
    const size = statSync(file).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { closeSync(fd); }
}

// 같은 PC 의 지역 시각으로 남은 "2026-10-08 11:44:31,088 ERROR …" 줄을 사건으로 바꾼다.
export function hermesIncidents(text, { since = 0 } = {}) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),\d+ (ERROR|CRITICAL|WARNING) (.*)$/.exec(line);
    if (!m) continue;
    const ms = Date.parse(`${m[1]}T${m[2]}`);
    if (!Number.isFinite(ms) || ms < since) continue;
    const at = new Date(ms).toISOString(), msg = m[4];
    const blocked = /Blocked unauthorized user (\d+) in chat (-?\d+)/.exec(msg);
    if (blocked) { out.push({ kind: 'blocked', at, user: blocked[1], chat: blocked[2] }); continue; }
    if (m[3] === 'WARNING') continue;
    if (/API call failed after/i.test(msg)) {
      const http = /HTTP (\d{3})(?: \(([A-Z_]+)\))?/.exec(msg);
      const busy = http && (http[1] === '503' || http[1] === '529' || /high demand|overloaded/i.test(msg));
      const quota = http && http[1] === '429' || /RESOURCE_EXHAUSTED|quota/i.test(msg);
      out.push({ kind: quota ? 'quota' : busy ? 'provider-busy' : 'reply-failed', at, text: clip(redact(msg.replace(/^.*?API call failed after \d+ retries\.?\s*/i, ''))) });
      continue;
    }
    // 재시도 중간 기록과 같은 실패의 뒷이야기(스트리밍 실패 등)는 마지막 "failed after" 한 줄로 센다.
    if (/API call failed \(attempt/i.test(msg) || /HTTP (?:5\d\d|429)|high demand|overloaded|RESOURCE_EXHAUSTED/i.test(msg)) continue;
    if (/telegram\.ext: Network Retry Loop|Timed out|ConnectTimeout|NetworkError/i.test(msg)) { out.push({ kind: 'network', at, text: clip(redact(msg)) }); continue; }
    out.push({ kind: 'error', at, text: clip(redact(msg)) });
  }
  return out;
}

let sqliteCtor; // undefined = 아직 모름, null = 이 Node 에 없음
async function sqlite() {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const emit = process.emitWarning;   // 실험 기능 경고가 엔진 로그에 매번 찍히지 않게
    process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
    try { sqliteCtor = (await import('node:sqlite')).DatabaseSync; } finally { process.emitWarning = emit; }
  } catch { sqliteCtor = null; }
  return sqliteCtor;
}

function readHermesDb(Db, file, office) {
  const db = new Db(file, { readOnly: true });
  try {
    const rows = db.prepare(`select u.session_id sid, u.model, u.billing_provider provider, u.api_call_count calls, u.input_tokens input, u.output_tokens output,
      u.cache_read_tokens cread, u.cache_write_tokens cwrite, u.estimated_cost_usd est, u.actual_cost_usd actual, u.first_seen first, u.last_seen last, s.started_at started
      from session_model_usage u join sessions s on s.id = u.session_id`).all();
    const events = rows.filter((r) => count(r.calls) > 0).map((r) => {
      const read = count(r.cread), write = count(r.cwrite);
      let input = count(r.input); if (read + write > input) input += read + write;
      const cost = Number.isFinite(r.actual) && r.actual > 0 ? r.actual : Number.isFinite(r.est) ? r.est : null;
      return { requestId: `hermes:${office.id}:${r.sid}:${r.model}`, provider: String(r.provider || 'hermes'), model: String(r.model || 'unknown'),
        at: iso(r.last) || iso(r.first) || iso(r.started), calls: count(r.calls), status: 'measured', billing: 'api',
        inputTokens: input, outputTokens: count(r.output), cacheReadTokens: read, cacheWriteTokens: write, providerCostUsd: cost };
    }).filter((e) => e.at);
    const io = db.prepare(`select m.role role, max(m.timestamp) t from messages m join sessions s on s.id = m.session_id where s.source = 'telegram' and m.role in ('user','assistant') group by m.role`).all();
    const at = (role) => iso((io.find((r) => r.role === role) || {}).t);
    return { events, inboundAt: at('user'), replyAt: at('assistant') };
  } finally { db.close(); }
}

// 같은 시점의 결과를 몇 초 동안 다시 쓰고, Claude 대화 기록은 이어 읽기 상태를 기억한다.
export function createObserver({ claudeHome, now = () => Date.now(), ttlMs = 15000 } = {}) {
  const claudeFiles = new Map();   // 파일 경로 → 이어 읽기 상태
  const memo = new Map();          // 사무실 키 → { at, value }

  function claudeOffice(office) {
    const dirs = officeProjectDirs(office, claudeHome).filter((d) => existsSync(d));
    const result = { source: 'claude-log', available: false, events: [], incidents: [], inboundAt: '', replyAt: '', tgReplyAt: '', context: null };
    if (!dirs.length) return result;
    const cutoff = now() - KEEP_DAYS * DAY;
    const files = [];
    const walk = (d, depth) => {
      let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory() && depth < 2 && (depth === 0 || e.name === 'subagents')) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) { try { if (statSync(p).mtimeMs >= cutoff) files.push(p); } catch { } }
      }
    };
    for (const dir of dirs) walk(dir, 0);
    result.available = true;
    for (const file of files.slice(0, 400)) {
      const state = scanClaudeFile(file, claudeFiles.get(file));
      if (!state) continue;
      claudeFiles.set(file, state);
      result.events.push(...state.events.values());
      result.incidents.push(...state.incidents);
      result.inboundAt = later(result.inboundAt, state.inboundAt);
      result.replyAt = later(result.replyAt, state.replyAt);
      result.tgReplyAt = later(result.tgReplyAt, state.tgReplyAt);
      // 서브에이전트가 아니라 본 대화(사무실 세션)의 최근 길이만 본다
      if (state.context && !/[\\/]subagents[\\/]/.test(file) && (!result.context || Date.parse(state.context.at) > Date.parse(result.context.at))) result.context = state.context;
    }
    return result;
  }

  async function hermesOffice(office) {
    const result = { source: 'hermes-db', available: false, events: [], incidents: [], inboundAt: '', replyAt: '', error: '' };
    const dbFile = join(office.folder, 'state.db');
    if (existsSync(dbFile)) {
      const Db = await sqlite();
      if (!Db) result.error = '이 PC 의 Node 가 SQLite 를 지원하지 않아 Hermes 사용량을 읽지 못했어요.';
      else {
        try { Object.assign(result, readHermesDb(Db, dbFile, office), { available: true }); }
        catch (e) { result.error = 'Hermes 기록 DB 를 읽지 못했어요: ' + clip(redact(e.message), 120); }
      }
    }
    result.incidents = hermesIncidents(tail(join(office.folder, 'logs', 'errors.log')), { since: now() - 8 * DAY });
    return result;
  }

  async function office(o) {
    const key = `${o.kind}:${o.id}:${o.folder}`;
    const hit = memo.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = o.kind === 'hermes' ? await hermesOffice(o) : claudeOffice(o);
    for (const e of value.events) { e.botId = o.id; e.botName = o.name; e.success = true; e.modelSource = 'provider'; e.billing ||= 'subscription'; }
    memo.set(key, { at: now(), value });
    return value;
  }

  return { office };
}

// ── 판정: 사람이 바로 이해할 한 줄과 근거 ──
const sum = (events, since) => {
  const t = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const e of events) {
    if (Date.parse(e.at) < since) continue;
    t.calls += e.calls || 1; t.inputTokens += e.inputTokens || 0; t.outputTokens += e.outputTokens || 0;
    t.cacheReadTokens += e.cacheReadTokens || 0; t.cacheWriteTokens += e.cacheWriteTokens || 0;
  }
  return t;
};
const KIND_TEXT = { 'provider-busy': 'AI 모델 서버가 혼잡해 답을 못 했어요', quota: 'AI 모델 사용 한도에 걸려 답을 못 했어요', 'reply-failed': 'AI 호출이 실패해 답을 못 했어요', 'api-error': 'Claude API 오류로 답을 못 했어요', error: '오류가 기록됐어요' };
const man = (n) => (n >= 10000 ? `${Math.round(n / 1000) / 10}만` : n.toLocaleString('ko-KR'));

// names: 텔레그램 사용자 번호 → 이름(이 PC 의 다른 봇 등). 모르는 번호는 그대로 보여 준다.
export function assess({ office, runtime = {}, observed = {}, nowMs = Date.now(), names = {} }) {
  const reasons = [];
  const incidents = (observed.incidents || []).filter((i) => Date.parse(i.at) >= nowMs - DAY);
  const replyAt = observed.replyAt || '';
  const lastReply = Date.parse(replyAt) || 0;
  let state = runtime.running ? 'ok' : 'off';
  const bump = (tone) => { if (tone === 'bad' || (tone === 'warn' && state === 'ok')) state = tone; };

  if (!runtime.running) reasons.push({ tone: 'mute', text: runtime.detail ? `꺼져 있어요 (${runtime.detail})` : '꺼져 있어요' });

  // 마지막 응답보다 뒤에 남은 한도 초과 = 지금도 막혀 있다
  const limits = (observed.incidents || []).filter((i) => i.kind === 'limit');
  const lastLimit = limits.at(-1);
  if (lastLimit && Date.parse(lastLimit.at) > lastReply && Date.parse(lastLimit.at) >= nowMs - 7 * DAY) {
    if (runtime.running) state = 'bad';
    reasons.push({ tone: 'bad', at: lastLimit.at, text: `${limitText(lastLimit.text)} — 그동안 텔레그램 지시에 답하지 못해요` });
  } else if (lastLimit && Date.parse(lastLimit.at) >= nowMs - DAY) {
    reasons.push({ tone: 'warn', at: lastLimit.at, text: `24시간 안에 사용 한도에 걸린 적이 있어요(지금은 다시 답하는 중) · ${limits.filter((i) => Date.parse(i.at) >= nowMs - DAY).length}회` });
    bump('warn');
  }

  // 한 번의 실패는 일시적일 수 있다. 마지막 답 이후 연달아 3번 넘게 실패해야 "응답 불가"로 본다.
  const failures = incidents.filter((i) => KIND_TEXT[i.kind] && i.kind !== 'error');
  const afterReply = failures.filter((i) => Date.parse(i.at) > lastReply);
  for (const kind of ['provider-busy', 'quota', 'reply-failed', 'api-error']) {
    const list = failures.filter((i) => i.kind === kind);
    if (!list.length) continue;
    const stuck = afterReply.filter((i) => i.kind === kind).length;
    const tone = stuck >= 3 ? 'bad' : 'warn';
    bump(runtime.running ? tone : 'warn');
    const tailText = stuck >= 3 ? ` (마지막 답 이후 연달아 ${stuck}회 — 지금 답하지 못하는 상태)` : stuck ? ' (가장 최근 지시에는 답하지 못했어요)' : ' (그 뒤로는 정상 응답)';
    const hint = kind === 'provider-busy' ? ' · 자주 반복되면 예비 모델을 지정하세요' : kind === 'quota' ? ' · 결제·한도를 확인하세요' : '';
    reasons.push({ tone, at: list.at(-1).at, text: `${KIND_TEXT[kind]} · 24시간 ${list.length}회${tailText}${hint}`, detail: list.at(-1).text || '' });
  }
  const network = incidents.filter((i) => i.kind === 'network');
  if (network.length) {
    const recent = Date.parse(network.at(-1).at) > lastReply;   // 그 뒤로 답한 적이 있으면 이미 회복된 것
    if (recent) bump('warn');
    reasons.push({ tone: recent ? 'warn' : 'info', at: network.at(-1).at, text: `텔레그램 서버 연결 시간 초과 24시간 ${network.length}회${recent ? '' : '(그 뒤 회복)'} — 인터넷이 느리거나 끊겼을 때 생겨요`, detail: network.at(-1).text });
  }
  const errors = incidents.filter((i) => i.kind === 'error');
  if (errors.length) { bump('warn'); reasons.push({ tone: 'warn', at: errors.at(-1).at, text: `오류 기록 24시간 ${errors.length}건`, detail: errors.at(-1).text }); }

  const blocked = incidents.filter((i) => i.kind === 'blocked');
  if (blocked.length) {
    const users = [...new Set(blocked.map((b) => b.user))];
    const strangers = users.filter((u) => !names[u]);
    const who = [...users.filter((u) => names[u]).map((u) => names[u]), ...(strangers.length ? [`허용 목록에 없는 사용자 ${strangers.length}명(${strangers.join(', ')})`] : [])].join(' · ');
    reasons.push({ tone: 'info', at: blocked.at(-1).at, text: `${who}의 메시지를 24시간 ${blocked.length}번 무시했어요${strangers.length ? ' — 함께 일할 사람이면 허용 목록에 추가하세요' : ''}`, users });
  }

  if (runtime.telegram && runtime.telegram !== 'connected') { bump('bad'); reasons.push({ tone: 'bad', text: `텔레그램 연결 상태: ${runtime.telegram}` }); }

  // 받은 지시보다 답이 한참 늦으면(10분) 멈춰 있을 수 있다
  const inbound = Date.parse(observed.inboundAt) || 0;
  if (runtime.running && inbound && inbound > lastReply && nowMs - inbound > 10 * 60000 && !reasons.some((r) => r.tone === 'bad')) {
    bump('warn'); reasons.push({ tone: 'warn', at: observed.inboundAt, text: '마지막으로 받은 지시에 10분 넘게 답이 없어요' });
  }

  const ctx = observed.context;
  if (runtime.running && ctx && ctx.tokens >= CONTEXT_WARN && Date.parse(ctx.at) >= nowMs - 2 * DAY) {
    bump('warn');
    reasons.push({ tone: 'warn', at: ctx.at, text: `대화가 길어져 한 번 답할 때마다 약 ${man(ctx.tokens)} 토큰을 다시 읽어요 — 한도가 빨리 닳아요. 한가할 때 「다시 출근」하면 새 대화로 시작해요` });
  }
  if (observed.error) reasons.push({ tone: 'warn', text: observed.error });
  if (observed.available === false && office.kind !== 'lapis') reasons.push({ tone: 'mute', text: '이 PC 에서 이 봇의 대화 기록을 찾지 못했어요' });

  const headline = state === 'off' ? '꺼짐' : state === 'bad' ? (reasons.find((r) => r.tone === 'bad') || {}).text || '응답 불가'
    : state === 'warn' ? (reasons.find((r) => r.tone === 'warn') || {}).text || '확인 필요' : '정상 — 지시를 받으면 답해요';
  const events = observed.events || [];
  const startToday = new Date(nowMs); startToday.setHours(0, 0, 0, 0);
  return {
    id: office.id, name: office.name, kind: office.kind, running: Boolean(runtime.running), state, headline, reasons,
    lastInboundAt: observed.inboundAt || '', lastReplyAt: replyAt, lastTelegramReplyAt: observed.tgReplyAt || '',
    contextTokens: ctx ? ctx.tokens : null, source: observed.source || '', measured: observed.available !== false,
    usage: { today: sum(events, startToday.getTime()), week: sum(events, nowMs - 7 * DAY) },
  };
}
