// 텔레그램 Bot API 호출(토큰은 주소에만 쓰고 로그·오류 메시지에 남기지 않는다).
import { HttpError } from './util.mjs';

export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
export const maskToken = (t) => (t ? `${String(t).split(':')[0]}:••••${String(t).slice(-4)}` : '');

export function createTgApi({ fetchImpl = fetch, base = 'https://api.telegram.org' } = {}) {
  async function call(token, method, params = {}, { timeout = 15000, signal } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch (e) {
      if (signal?.aborted) throw new HttpError(499, '중단되었습니다.');
      throw new HttpError(503, '텔레그램에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
    const j = await res.json().catch(() => ({}));
    if (!j.ok) { const e = new HttpError(res.status === 409 ? 409 : 502, j.description || `텔레그램 오류 ${res.status}`); e.tgCode = j.error_code || res.status; throw e; }
    return j.result;
  }
  return {
    call,
    getMe: (token) => call(token, 'getMe'),
    getUpdates: (token, params, opts) => call(token, 'getUpdates', params, { timeout: 40000, ...opts }),
    sendMessage: (token, params) => call(token, 'sendMessage', params),
    sendChatAction: (token, params) => call(token, 'sendChatAction', params).catch(() => {}),
  };
}
