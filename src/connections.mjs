// 연결 허브: Claude · GPT(ChatGPT 로그인·OpenAI API 키) · Anthropic API 키 · Cloudflare 토큰 · 로컬 AI(Ollama) 상태와 연결.
// 로그인은 각 도구의 공식 로그인(브라우저 인증)만 쓰고, 비밀번호는 받지 않는다. API 키는 확인한 뒤 DPAPI 로 암호화해 보관한다.
import { HttpError, need, psQuote, isWindows } from './util.mjs';
import { launchConsole } from './claude.mjs';
import { SECRET_NAMES, mask } from './secrets.mjs';

const KEY_SHAPE = {
  openai: /^sk-[A-Za-z0-9_-]{20,200}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,200}$/,
  cloudflare: /^[A-Za-z0-9_-]{30,80}$/,
};
const LABEL = { openai: 'OpenAI API 키', anthropic: 'Anthropic API 키', cloudflare: 'Cloudflare API 토큰' };

const CHAT_OK = /^(gpt-|o\d|chatgpt-)/;
const CHAT_NO = /(embed|tts|whisper|dall|image|audio|realtime|transcribe|moderation|search|instruct|codex|vision-preview)/;

export function createConnections({ components, secrets, fetchImpl = fetch, runImpl, launch = launchConsole }) {
  async function codexStatus() {
    const d = await components.detect('codex');
    if (!d.installed) return { installed: false, loggedIn: false };
    const exec = /\.(cmd|bat)$/i.test(d.path) ? ['cmd.exe', ['/d', '/s', '/c', `""${d.path}" login status"`], { verbatim: true }] : [d.path, ['login', 'status'], {}];
    const r = await runImpl(exec[0], exec[1], { timeout: 20000, ...exec[2] });
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const loggedIn = r.code === 0 && /logged in/i.test(text);
    return {
      installed: true, version: d.version, loggedIn,
      method: loggedIn ? (/chatgpt/i.test(text) ? 'ChatGPT 계정' : /api key/i.test(text) ? 'API 키' : '로그인됨') : '',
      error: loggedIn ? '' : (text.split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '').slice(0, 200),
    };
  }

  async function status() {
    const [claude, codex, ollama, hermes, keys] = await Promise.all([
      import('./claude.mjs').then((m) => m.claudeInfo()),
      codexStatus(),
      components.detect('ollama'),
      components.detect('hermes'),
      secrets.masked(),
    ]);
    return {
      claude: { installed: claude.installed, version: claude.version || '', loggedIn: Boolean(claude.auth?.loggedIn), email: claude.auth?.email || '', plan: claude.auth?.plan || '', error: claude.auth?.error || '' },
      gpt: { codex, apiKey: keys.openai },
      anthropic: { apiKey: keys.anthropic },
      cloudflare: { apiToken: keys.cloudflare },
      ollama: { installed: ollama.installed, version: ollama.version },
      hermes: { installed: hermes.installed, version: hermes.version },
    };
  }

  // ChatGPT 로그인: 보이는 콘솔 창에서 공식 `codex login` 을 실행한다(브라우저가 열린다).
  async function startCodexLogin() {
    need(isWindows, 'Windows 에서만 지원합니다. 터미널에서 `codex login` 을 실행해 주세요.', 501);
    const d = await components.detect('codex', { fresh: true });
    need(d.installed, 'Codex 가 설치되어 있지 않습니다. 먼저 설치해 주세요.', 409);
    launch('ChatGPT 로그인 (Codex)', [
      `& ${psQuote(d.path)} login`,
      "Write-Host ''",
      `$st = (& ${psQuote(d.path)} login status 2>&1 | Out-String)`,
      'Write-Host $st',
      "if ($st -match 'Logged in') { Write-Host '로그인되었습니다. 이 창을 닫고 앱에서 「다시 확인」을 눌러 주세요.' -ForegroundColor Green }",
      "else { Write-Host '아직 로그인되지 않았습니다. 브라우저에서 로그인을 끝내고 다시 시도해 주세요.' -ForegroundColor Yellow }",
    ]);
    return { started: true };
  }

  // 키 확인: 공급자에 가볍게 물어 맞는 키인지 본다. 통과하면 저장한다.
  async function verify(name, key) {
    const call = (url, headers) => fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) }).catch(() => { throw new HttpError(503, '인터넷 연결을 확인해 주세요.'); });
    if (name === 'openai') return call('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` });
    if (name === 'anthropic') return call('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    return call('https://api.cloudflare.com/client/v4/user/tokens/verify', { authorization: `Bearer ${key}` });
  }
  async function setKey(name, key) {
    need(SECRET_NAMES.includes(name), '알 수 없는 연결입니다.', 404);
    key = String(key || '').trim();
    need(KEY_SHAPE[name].test(key), `${LABEL[name]} 형식이 올바르지 않습니다. 복사한 값 전체를 붙여 넣어 주세요.`);
    const res = await verify(name, key);
    need(res.status !== 401 && res.status !== 403, `${LABEL[name]}가 거절되었습니다. 키가 맞는지, 사용 권한이 있는지 확인해 주세요.`, 400);
    need(res.ok, `${LABEL[name]}를 확인하지 못했습니다(응답 ${res.status}). 잠시 뒤 다시 시도해 주세요.`, 502);
    await secrets.set(name, key);
    return { set: true, hint: mask(key) };
  }
  async function clearKey(name) {
    need(SECRET_NAMES.includes(name), '알 수 없는 연결입니다.', 404);
    await secrets.remove(name);
    return { set: false };
  }

  // 키로 쓸 수 있는 모델 목록(공급자가 실제로 열어 준 것만).
  async function models(provider) {
    need(['openai', 'anthropic'].includes(provider), '알 수 없는 공급자입니다.', 404);
    const key = await secrets.get(provider);
    need(key, `${LABEL[provider]}를 먼저 연결해 주세요.`, 409);
    const res = await (provider === 'openai'
      ? fetchImpl('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
      : fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) })
    ).catch(() => { throw new HttpError(503, '인터넷 연결을 확인해 주세요.'); });
    need(res.ok, `모델 목록을 가져오지 못했습니다(응답 ${res.status}).`, 502);
    const j = await res.json();
    const ids = (j.data || []).map((m) => m.id).filter(Boolean);
    const list = provider === 'openai' ? ids.filter((id) => CHAT_OK.test(id) && !CHAT_NO.test(id)) : ids.filter((id) => /^claude-/.test(id));
    return { models: [...new Set(list)].sort() };
  }

  return { status, codexStatus, startCodexLogin, setKey, clearKey, models };
}
