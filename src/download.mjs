// 안전한 내려받기: 허용된 공식 호스트만, https 만, 리다이렉트도 한 단계씩 호스트를 다시 확인한다.
// 큰 파일(수 GB)을 위해 `.part` 파일로 이어받기를 지원하고, 해시가 주어지면 검증한다.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { HttpError } from './util.mjs';

// 내려받기를 허용하는 호스트(접미사 일치). 여기에 없는 주소는 어떤 경우에도 받지 않는다.
export const ALLOWED_HOSTS = [
  'nodejs.org', 'github.com', 'githubusercontent.com', 'ollama.com', 'claude.ai', 'claude.com',
  'nousresearch.com', 'bun.sh', 'registry.npmjs.org',
];

export function hostAllowed(url, hosts = ALLOWED_HOSTS) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

export const sha256File = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

// 리다이렉트를 직접 따라가며 응답을 얻는다.
async function open(url, { fetchImpl, hosts, headers, allowHttp }) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const ok = allowHttp ? /^https?:\/\//.test(current) && hostAllowed(current.replace(/^http:/, 'https:'), hosts) : hostAllowed(current, hosts);
    if (!ok) throw new HttpError(400, `허용되지 않은 내려받기 주소입니다: ${new URL(current).hostname}`);
    const res = await fetchImpl(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new HttpError(502, '내려받기 주소가 너무 여러 번 바뀌었습니다.');
}

// url → dest. onProgress(받은 바이트, 전체 바이트|0). 이미 같은 크기의 완성 파일이 있으면 건너뛴다(해시가 있으면 확인).
export async function download(url, dest, { fetchImpl = fetch, hosts = ALLOWED_HOSTS, onProgress, sha256, allowHttp = false, signal } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + '.part';
  let have = existsSync(part) ? statSync(part).size : 0;
  const headers = { 'user-agent': 'lapis-installer' };
  if (have > 0) headers.range = `bytes=${have}-`;
  let res = await open(url, { fetchImpl, hosts, headers, allowHttp });
  if (res.status === 416) {          // 이미 다 받았거나 어긋남: 처음부터 다시
    await res.body?.cancel();
    rmSync(part, { force: true }); have = 0; delete headers.range;
    res = await open(url, { fetchImpl, hosts, headers, allowHttp });
  }
  if (res.status !== 200 && res.status !== 206) { await res.body?.cancel(); throw new HttpError(502, `내려받기에 실패했습니다(응답 ${res.status}).`); }
  if (res.status === 200 && have > 0) { rmSync(part, { force: true }); have = 0; }   // 서버가 이어받기를 지원하지 않으면 처음부터
  const len = Number(res.headers.get('content-length') || 0);
  const total = len ? len + have : 0;
  let done = have;
  const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
  try {
    for await (const chunk of res.body) {
      if (signal?.aborted) throw new HttpError(499, '내려받기를 취소했습니다.');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      done += chunk.length;
      onProgress?.(done, total);
    }
    await new Promise((resolve, reject) => { out.end((e) => (e ? reject(e) : resolve())); });
  } catch (e) {
    out.destroy();
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, '내려받는 중 연결이 끊겼습니다. 다시 누르면 이어서 받습니다.');
  }
  if (total && done !== total) throw new HttpError(502, '내려받은 파일 크기가 맞지 않습니다. 다시 누르면 이어서 받습니다.');
  if (sha256) {
    const actual = await sha256File(part);
    if (actual !== String(sha256).toLowerCase()) { rmSync(part, { force: true }); throw new HttpError(502, '내려받은 파일의 해시가 맞지 않아 폐기했습니다.'); }
  }
  rmSync(dest, { force: true });
  renameSync(part, dest);
  return { bytes: done, path: dest };
}
