// Claude Code 훅: 팀이 일을 시작·완료할 때마다 <사무실>/.ai-office/state/status.json 을 갱신한다.
// 대시보드의 실시간 현황판이 이 파일을 읽는다. 훅은 절대 작업을 막지 않도록 모든 오류를 삼킨다.
//   node status-hook.mjs team_start|team_done|team_stop|chief_task|chief_idle   (입력: 표준입력의 훅 JSON)
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const event = process.argv[2];
const office = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FILE = join(office, '.ai-office', 'state', 'status.json');
const LOCK = `${FILE}.lock`;
const MAX_EVENTS = 60;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const now = () => new Date().toISOString();
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function withLock(fn) {
  mkdirSync(dirname(FILE), { recursive: true });
  for (let i = 0; ; i++) {
    try { mkdirSync(LOCK); break; } catch {
      try { if (Date.now() - statSync(LOCK).mtimeMs > 5000) { rmSync(LOCK, { recursive: true, force: true }); continue; } } catch { }
      if (i > 60) return;   // 잠금을 못 잡으면 이번 갱신은 건너뛴다
      sleep(25);
    }
  }
  try { fn(); } finally { rmSync(LOCK, { recursive: true, force: true }); }
}

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}

function save(st) {
  st.updatedAt = now();
  st.events = (st.events || []).slice(0, MAX_EVENTS);
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  renameSync(tmp, FILE);
}

const push = (st, team, text) => { (st.events ||= []).unshift({ at: now(), team, text }); };
const today = () => new Date().toDateString();

// 텔레그램 메시지는 <channel …>본문</channel> 형태로 오므로 본문만 꺼낸다.
function promptText(input) {
  const raw = String(input.prompt ?? '');
  const m = /<channel\b[^>]*>([\s\S]*?)(?:<\/channel>|$)/.exec(raw);
  return oneLine(m ? m[1] : raw, 80);
}

function teamOf(input) {
  const ti = input.tool_input || {};
  return { key: ti.subagent_type || input.agent_type || '', task: oneLine(ti.description || ti.prompt || '', 80) };
}

function finish(t, task) {
  t.active = Math.max(0, (t.active || 0) - 1);
  if (t.doneDate !== today()) { t.doneDate = today(); t.doneToday = 0; }
  t.doneToday = (t.doneToday || 0) + 1;
  t.lastDone = task || t.task || '';
  t.lastDoneAt = now();
  t.doneAt = t.lastDoneAt;
  if (!t.active) t.state = 'idle';
}

try {
  const input = readStdin();
  withLock(() => {
    const st = load();
    st.chief ||= { state: 'idle' };
    st.teams ||= {};
    if (event === 'chief_task') {
      const text = promptText(input);
      st.chief = { ...st.chief, state: 'working', task: text, since: now() };
      push(st, 'chief', `지시 접수${text ? ` · ${text}` : ''}`);
    } else if (event === 'chief_idle') {
      st.chief = { ...st.chief, state: 'idle', lastDoneAt: now() };
      delete st.chief.task;
      push(st, 'chief', '업무 처리 완료 · 대기');
    } else if (event === 'team_start') {
      const { key, task } = teamOf(input);
      if (!key) return;
      const t = (st.teams[key] ||= { active: 0, state: 'idle' });
      t.active = (t.active || 0) + 1;
      t.state = 'working';
      t.task = task || t.task || '';
      t.since = now();
      push(st, key, `작업 시작${task ? ` · ${task}` : ''}`);
    } else if (event === 'team_done') {
      const { key, task } = teamOf(input);
      if (!key || !st.teams[key]) return;
      finish(st.teams[key], task);
      push(st, key, `완료${task ? ` · ${task}` : ''}`);
    } else if (event === 'team_stop') {
      // PostToolUse 가 오지 않는 백그라운드 서브에이전트를 위한 안전장치: 이미 완료 처리된 건은 무시한다.
      const key = input.agent_type;
      const t = key && st.teams[key];
      if (!t || !t.active) return;
      if (t.doneAt && t.since && t.doneAt >= t.since) return;
      finish(t, t.task);
      push(st, key, `완료 · ${t.task || ''}`);
    } else return;
    save(st);
  });
} catch { /* 훅 오류로 업무가 멈추면 안 된다 */ }
process.exit(0);
