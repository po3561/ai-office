// LAPIS 런타임의 엔진 어댑터: 같은 모양의 `complete()` 하나로 여러 AI 를 부른다.
//   ollama    내 PC 의 로컬 모델
//   openai    OpenAI API 키
//   anthropic Anthropic API 키
//   claude    Claude Code(구독 로그인) 한 번 실행(-p)
//   codex     Codex(ChatGPT 로그인) 한 번 실행(exec)
//   hermes    Hermes 한 번 실행(-z)
// access(권한): chat = 대화만 / read = 사무실 폴더 읽기 / write = 폴더 읽기·쓰기.  claude·codex 에서만 도구를 쓴다.
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpError, need } from './util.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeUsage } from './usage.mjs';

export const ENGINE_TYPES = {
  ollama: { label: '로컬 AI (Ollama)', needs: 'ollama', remote: false, tools: false },
  openai: { label: 'GPT (OpenAI API 키)', needs: 'openai-key', remote: true, tools: false },
  anthropic: { label: 'Claude (Anthropic API 키)', needs: 'anthropic-key', remote: true, tools: false },
  claude: { label: 'Claude (구독 로그인)', needs: 'claude', remote: false, tools: true },
  codex: { label: 'GPT (ChatGPT 로그인)', needs: 'codex', remote: false, tools: true },
  hermes: { label: 'Hermes', needs: 'hermes', remote: false, tools: false },
};
export const ACCESS = ['chat', 'read', 'write'];

// 대화 기록을 한 덩어리 글로 합친다(명령줄 엔진용).
export function flatten({ system, messages }) {
  const parts = [];
  if (system) parts.push(`[지침]\n${system}`);
  const hist = messages.slice(0, -1);
  if (hist.length) parts.push('[이전 대화]\n' + hist.map((m) => `${m.role === 'user' ? '사용자' : '나'}: ${m.content}`).join('\n'));
  parts.push(`[지금 온 메시지]\n${messages.at(-1)?.content || ''}`);
  return parts.join('\n\n');
}

export function createEngines({ ollama, secrets, components, usage, fetchImpl = fetch, runImpl, timeoutMs = 180000 }) {
  const cmd = (path, args) => (/\.(cmd|bat)$/i.test(path)
    ? ['cmd.exe', ['/d', '/s', '/c', `""${path}" ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}"`], { verbatim: true }]
    : [path, args, {}]);
  async function exec(path, args, { input, cwd, timeout = timeoutMs } = {}) {
    const [c, a, extra] = cmd(path, args);
    return runImpl(c, a, { input, cwd, timeout, ...extra });
  }
  const need2 = async (id, msg) => { const d = await components.detect(id); need(d.installed, msg, 409); return d; };

  const impl = {
    async ollama({ model, system, messages }) {
      need(model, 'Ollama 모델을 골라 주세요.');
      return ollama.chatDetailed ? ollama.chatDetailed({ model, system, messages }) : ollama.chat({ model, system, messages });
    },
    async openai({ model, system, messages }) {
      const key = await secrets.get('openai');
      need(key, 'OpenAI API 키가 연결되어 있지 않습니다.', 409);
      need(model, 'GPT 모델을 골라 주세요.');
      const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: system ? [{ role: 'system', content: system }, ...messages] : messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(502, `GPT 오류: ${j.error?.message || res.status}`);
      return { text: String(j.choices?.[0]?.message?.content || '').trim(), model: j.model, providerRequestId: j.id, usage: normalizeUsage('openai', j.usage) };
    },
    async anthropic({ model, system, messages }) {
      const key = await secrets.get('anthropic');
      need(key, 'Anthropic API 키가 연결되어 있지 않습니다.', 409);
      need(model, 'Claude 모델을 골라 주세요.');
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 4096, ...(system ? { system } : {}), messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new HttpError(502, `Claude 오류: ${j.error?.message || res.status}`);
      return { text: (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim(), model: j.model, providerRequestId: j.id, usage: normalizeUsage('anthropic', j.usage) };
    },
    async claude({ model, system, messages, cwd, access }) {
      const d = await need2('claude', 'Claude Code 가 설치되어 있지 않습니다.');
      const tmp = mkdtempSync(join(tmpdir(), 'lapis-claude-'));
      try {
        const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
        if (model) args.push('--model', model);
        if (system) {   // 길이 제한이 있는 명령줄 대신 파일로 넘긴다
          const f = join(tmp, 'system.md');
          writeFileSync(f, system, 'utf8');
          args.push('--append-system-prompt-file', f);
        }
        if (access === 'read') args.push('--allowedTools', 'Read', 'Glob', 'Grep');
        else if (access === 'write') args.push('--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write');
        else args.push('--tools', '');
        const r = await exec(d.path, args, { input: flatten({ messages }), cwd });
        if (r.code !== 0) throw new HttpError(502, `Claude Code 오류: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] || r.code}`);
        let j; try { j = JSON.parse(r.stdout); } catch { /* Older CLIs may only return text. */ }
        if (j?.is_error) throw new HttpError(502, 'Claude Code가 요청을 완료하지 못했습니다.');
        const models = Object.keys(j?.modelUsage || {});
        return j ? { text: String(j.result || '').trim(), model: models.length === 1 ? models[0] : model, modelSource: models.length === 1 ? 'provider' : model ? 'requested' : 'unknown', providerRequestId: j.uuid || j.session_id,
          usage: normalizeUsage('claude', j.usage) } : r.stdout.trim();
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    },
    async codex({ model, system, messages, cwd, access }) {
      const d = await need2('codex', 'Codex 가 설치되어 있지 않습니다.');
      const tmp = mkdtempSync(join(tmpdir(), 'lapis-codex-'));
      try {
        const out = join(tmp, 'last.txt');
        const sandbox = access === 'write' ? 'workspace-write' : 'read-only';
        const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', sandbox, '--color', 'never', '-o', out];
        if (model) args.push('-m', model);
        args.push('-');
        const r = await exec(d.path, args, { input: flatten({ system, messages }), cwd });
        let text = '';
        try { text = readFileSync(out, 'utf8').trim(); } catch { /* 아래에서 오류로 처리 */ }
        if (r.code !== 0 && !text) throw new HttpError(502, `Codex 오류: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop() || r.code}`);
        const events = r.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const turns = events.filter(e => e.type === 'turn.completed' && e.usage);
        const metrics = turns.length ? turns.reduce((sum, e) => ({ input_tokens: sum.input_tokens + (e.usage.input_tokens || 0),
          output_tokens: sum.output_tokens + (e.usage.output_tokens || 0), cached_input_tokens: sum.cached_input_tokens + (e.usage.cached_input_tokens || 0),
          cache_write_tokens: sum.cache_write_tokens + (e.usage.cache_write_tokens || 0) }), { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0 }) : {};
        const actualModel = events.find(e => e.model)?.model;
        return { text, model: actualModel || model, modelSource: actualModel ? 'provider' : model ? 'requested' : 'unknown', providerRequestId: events.find(e => e.thread_id)?.thread_id, usage: normalizeUsage('codex', metrics) };
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    },
    async hermes({ model, system, messages, cwd }) {
      const d = await need2('hermes', 'Hermes 가 설치되어 있지 않습니다.');
      const args = ['-z', flatten({ system, messages })];
      if (model) args.push('-m', model);
      const r = await exec(d.path, args, { cwd });
      if (r.code !== 0) throw new HttpError(502, `Hermes 오류: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop() || r.code}`);
      return r.stdout.trim();
    },
  };

  // engine: {type, model}, access: chat|read|write, cwd: 도구를 쓸 때의 작업 폴더(봇 폴더)
  async function completeDetailed({ engine, system, messages, cwd, access = 'chat', context = {}, onUsage }) {
    need(engine && impl[engine.type], '엔진 종류를 알 수 없습니다.', 400);
    need(Array.isArray(messages) && messages.length, '보낼 메시지가 없습니다.');
    if (cwd) mkdirSync(cwd, { recursive: true });
    const base = { ...context, requestId: context.requestId || randomUUID(), provider: engine.type, model: engine.model || '', requestedModel: engine.model || '', modelSource: engine.model ? 'requested' : 'unknown',
      billing: ['openai', 'anthropic'].includes(engine.type) ? 'api' : engine.type === 'ollama' ? 'local' : 'subscription' };
    let event;
    try {
      const result = await impl[engine.type]({ model: engine.model || '', system, messages, cwd, access: ENGINE_TYPES[engine.type].tools ? access : 'chat' });
      const detail = typeof result === 'string' ? { text: result } : result;
      event = { ...base, model: detail.model || base.model, modelSource: detail.modelSource || (detail.model ? 'provider' : base.modelSource), providerRequestId: detail.providerRequestId || '', ...(detail.usage || normalizeUsage(engine.type)), success: Boolean(detail.text) };
      need(detail.text, '엔진이 빈 답을 돌려줬습니다.', 502);
      usage?.record(event); onUsage?.(event);
      return { text: detail.text, ...event };
    } catch (e) {
      usage?.record(event || { ...base, ...normalizeUsage(engine.type), success: false });
      throw e;
    }
  }
  const complete = async options => (await completeDetailed(options)).text;
  return { complete, completeDetailed };
}
