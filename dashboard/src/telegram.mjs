import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { botUsername } from './config.mjs';

const MAX_MESSAGES = 100;
const MAX_TEXT = 3000;

async function readBounded(path, limit = 4 * 1024 * 1024) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('invalid_source');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('invalid_source');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

function iso(value, seconds = false) {
  if (value == null || value === '') return null;
  const date = new Date(typeof value === 'number' && seconds ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function redact(text) {
  return text
    .replace(/\b\d{5,16}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|api[_-]?key|bot[_-]?token|access[_-]?token|secret|비밀번호)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .slice(0, MAX_TEXT);
}

function plainText(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let text = value;
  if (/^\s*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return '';
      text = parsed.filter(v => v && ['text', 'input_text', 'output_text'].includes(v.type) && typeof v.text === 'string').map(v => v.text).join('\n');
    } catch { /* Ordinary messages can begin with a bracket. */ }
  }
  return redact(text.trim());
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}

function summarize(bot, messages) {
  const latest = role => messages.filter(m => m.role === role).map(m => m.at).sort().at(-1) ?? null;
  return { ...bot, lastReceivedAt: latest('user'), lastRecordedReplyAt: latest('assistant') };
}

async function readHermes(home) {
  let state = null;
  try { state = JSON.parse(await readBounded(join(home, 'gateway_state.json'), 65536)); } catch { /* Records remain available when the receiver is offline. */ }
  const running = processAlive(state?.pid);
  const connected = state?.gateway_state === 'running' && state?.platforms?.telegram?.state === 'connected';
  const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true });
  let messages;
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250;');
    const rows = db.prepare(`SELECT m.id, m.role, m.content, m.timestamp, s.chat_id, s.thread_id
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.source = 'telegram' AND m.role IN ('user', 'assistant')
        AND length(m.content) BETWEEN 1 AND 262144
      ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`).all(MAX_MESSAGES);
    messages = rows.flatMap(row => {
      const text = plainText(row.content), at = iso(row.timestamp, true);
      return text && at ? [{ id: `lapis:${row.id}`, botId: 'lapis', role: row.role, text, at,
        chatId: row.chat_id == null ? null : String(row.chat_id), threadId: row.thread_id == null ? null : String(row.thread_id), source: 'hermes-state-recorded' }] : [];
    });
  } finally { db.close(); }
  return { messages, bot: summarize({ id: 'lapis', name: '라피스 · Hermes', username: '@promisr9907_bot', running,
    sourceUpdatedAt: iso(state?.updated_at), status: running === false ? 'stopped' : running === true && connected ? 'running' : 'unknown',
    detail: 'Hermes Telegram 세션 기록. 응답은 저장된 모델 출력이며 전송 확인이 아닙니다. 실행 상태는 저장된 PID의 생존 여부이며 새 수신 증거가 아닙니다.' }, messages) };
}

async function readClaude(dir) {
  const path = join(dir, 'context.json');
  const context = JSON.parse(await readBounded(path));
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('invalid_source');
  let running = null;
  try { running = processAlive(Number((await readBounded(join(dir, 'bot.pid'), 64)).trim())); } catch { /* PID may be absent even while records exist. */ }
  const seen = new Set(), messages = [];
  for (const [key, slot] of Object.entries(context)) {
    const match = /^(-?\d+):(\d+)$/.exec(key);
    if (!match || !Array.isArray(slot?.items)) continue;
    for (const item of slot.items) {
      // The Claude plugin mirrors Hermes replies into context; the DB is their source of truth.
      if (!item || typeof item.from !== 'string' || item.from.endsWith('(봇)')) continue;
      const at = iso(item.at), text = plainText(item.text);
      if (!at || !text || !Number.isSafeInteger(item.id)) continue;
      const id = `kao:${match[1]}:${match[2]}:${item.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, botId: 'kao', role: item.from === '카오(비서실장)' ? 'assistant' : 'user', text, at,
        chatId: match[1], threadId: match[2] === '0' ? null : match[2], source: 'claude-context-recorded' });
    }
  }
  const info = await stat(path);
  return { messages, bot: summarize({ id: 'kao', name: '카오 · Claude Office', username: botUsername('kao'), running,
    sourceUpdatedAt: info.mtime.toISOString(), status: running === true ? 'running' : running === false ? 'stopped' : 'unknown',
    detail: '연결된 업무방의 제한된 문맥 기록입니다. 개인 대화 전체 기록은 포함하지 않습니다. PID 생존 여부는 새 수신이나 전달 확인이 아닙니다.' }, messages) };
}

/** Observes local receiver records only. Never polls Telegram or starts/stops a receiver. */
export async function telegramSnapshot(options = {}) {
  const home = options.hermesHome ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hermes', 'profiles', 'lapis-pilot');
  const claude = options.claudeTelegramDir ?? join(homedir(), '.claude', 'channels', 'telegram');
  const results = await Promise.allSettled([readClaude(claude), readHermes(home)]);
  const bots = [], messages = [], errors = [];
  for (const [index, result] of results.entries()) {
    const id = index === 0 ? 'kao' : 'lapis';
    if (result.status === 'fulfilled') {
      bots.push(result.value.bot); messages.push(...result.value.messages);
    } else {
      bots.push({ id, name: id === 'kao' ? '카오 · Claude Office' : '라피스 · Hermes', username: botUsername(id),
        running: null, lastReceivedAt: null, lastRecordedReplyAt: null, sourceUpdatedAt: null, status: 'unavailable', detail: '로컬 기록을 읽을 수 없습니다. 기존 수신 프로세스에는 변경을 가하지 않았습니다.' });
      errors.push({ botId: id, code: 'source_unavailable', message: '로컬 Telegram 기록을 읽을 수 없습니다.' });
    }
  }
  messages.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  return { observedAt: new Date().toISOString(), bots, messages: messages.slice(0, MAX_MESSAGES), errors };
}
