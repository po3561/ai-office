// Ollama(내 PC에서 돌리는 AI): 서버 켜기, 설치된 모델 목록, 모델 내려받기(진행률), 대화.
// 서버는 항상 이 PC(127.0.0.1:11434) 것만 쓴다.
import { spawn } from 'node:child_process';
import { HttpError, need } from './util.mjs';

export const OLLAMA_URL = process.env.OLLAMA_HOST && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : 'http://127.0.0.1:11434';

// 처음 쓰는 사람을 위한 추천 모델(크기는 대략). 다른 이름을 직접 적어도 된다.
export const RECOMMENDED = [
  { name: 'llama3.2:3b', label: '가벼움 · 빠름', size: '약 2GB', note: '사양이 낮은 PC에서도 잘 돌아갑니다.' },
  { name: 'gemma3:4b', label: '균형', size: '약 3.3GB', note: '한국어가 무난하고 가볍습니다.' },
  { name: 'qwen2.5:7b', label: '똑똑함', size: '약 4.7GB', note: '메모리 16GB 이상 PC에 권장합니다.' },
  { name: 'gemma3:12b', label: '더 똑똑함', size: '약 8GB', note: '그래픽카드나 메모리 여유가 있을 때.' },
];

const MODEL_RE = /^[a-z0-9][a-z0-9._\-/]{0,60}(:[a-zA-Z0-9._\-]{1,40})?$/;
export const validModel = (name) => MODEL_RE.test(String(name || ''));

export function createOllama({ fetchImpl = fetch, baseUrl = OLLAMA_URL, bin = () => '' } = {}) {
  const get = async (path, ms = 4000) => fetchImpl(baseUrl + path, { signal: AbortSignal.timeout(ms) });

  async function running() {
    try { const r = await get('/api/version', 1500); return r.ok ? (await r.json()).version || true : false; } catch { return false; }
  }
  // 꺼져 있으면 창 없이 켠다(최대 15초 기다림).
  async function ensureServer() {
    if (await running()) return true;
    const exe = bin();
    need(exe, 'Ollama 가 설치되어 있지 않습니다. 먼저 설치해 주세요.', 409);
    spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 500)); if (await running()) return true; }
    throw new HttpError(503, 'Ollama 서버를 켜지 못했습니다.');
  }
  async function models() {
    if (!(await running())) return { running: false, models: [] };
    const r = await get('/api/tags', 5000);
    const j = await r.json();
    return { running: true, models: (j.models || []).map((m) => ({ name: m.name, size: m.size || 0, modified: m.modified_at || '' })) };
  }
  // 모델 내려받기: /api/pull 의 줄 단위 JSON 진행 상황을 ctx(작업 기록)에 전달한다.
  async function pull(name, ctx) {
    need(validModel(name), '모델 이름이 올바르지 않습니다. 예: llama3.2:3b', 400);
    await ensureServer();
    ctx.step(`모델 내려받기: ${name}`);
    const res = await fetchImpl(baseUrl + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }) });
    need(res.ok, `모델 요청이 거절되었습니다(응답 ${res.status}). 이름을 확인해 주세요.`, 502);
    let buf = '', lastStatus = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.error) throw new HttpError(502, `모델을 받지 못했습니다: ${j.error}`);
        if (j.total) ctx.progress(j.completed || 0, j.total);
        if (j.status && j.status !== lastStatus && !j.total) { lastStatus = j.status; ctx.log(j.status); }
      }
    }
    return { name };
  }
  // 한 번 묻고 답 받기(스트리밍 없음). messages: [{role, content}]
  async function chat({ model, messages, system, timeout = 180000 }) {
    need(validModel(model), '모델 이름이 올바르지 않습니다.', 400);
    await ensureServer();
    const body = { model, stream: false, messages: system ? [{ role: 'system', content: system }, ...messages] : messages };
    const res = await fetchImpl(baseUrl + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, j.error || `Ollama 응답 오류(${res.status})`);
    return String(j.message?.content || '').trim();
  }
  return { running, ensureServer, models, pull, chat, baseUrl };
}
