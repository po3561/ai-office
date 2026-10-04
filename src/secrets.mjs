// API 키·토큰 같은 비밀을 이 PC 의 현재 Windows 사용자만 풀 수 있게(DPAPI) 암호화해 보관한다.
// 화면·로그·API 응답에는 값을 절대 내보내지 않고, 끝 네 글자만 가려서 보여 준다.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_HOME } from './paths.mjs';
import { HttpError, isWindows } from './util.mjs';

const SCRIPT = (mode) => '$ErrorActionPreference=\'Stop\';Add-Type -AssemblyName System.Security;'
  + '$in=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($in);'
  + `$o=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);`
  + '[Console]::Out.Write([Convert]::ToBase64String($o))';

function dpapiRun(mode, buf) {
  return new Promise((resolve, reject) => {
    const enc = Buffer.from(SCRIPT(mode), 'utf16le').toString('base64');
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 },
      (err, out) => (err ? reject(new HttpError(500, '이 PC의 보안 저장소(DPAPI)를 사용하지 못했습니다.')) : resolve(Buffer.from(out.trim(), 'base64'))));
    child.stdin.end(buf.toString('base64'));
  });
}
export const dpapi = { protect: (b) => dpapiRun('Protect', b), unprotect: (b) => dpapiRun('Unprotect', b) };
export const plain = { protect: async (b) => Buffer.from(b), unprotect: async (b) => Buffer.from(b) };   // 시험용·Windows 가 아닌 환경

export const SECRET_NAMES = ['openai', 'anthropic', 'cloudflare'];
export const mask = (v) => (v ? '••••' + String(v).slice(-4) : '');

export function createSecrets({ file = join(DATA_HOME, 'secrets.bin'), crypto = isWindows ? dpapi : plain } = {}) {
  let cache;
  async function read() {
    if (cache) return { ...cache };
    try { cache = JSON.parse((await crypto.unprotect(Buffer.from(readFileSync(file, 'utf8'), 'base64'))).toString('utf8')); }
    catch (e) { if (e?.code === 'ENOENT') cache = {}; else throw new HttpError(500, '저장된 연결 정보를 읽지 못했습니다. 다시 입력해 주세요.'); }
    return { ...cache };
  }
  async function write(next) {
    mkdirSync(dirname(file), { recursive: true });
    const sealed = (await crypto.protect(Buffer.from(JSON.stringify(next), 'utf8'))).toString('base64');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, sealed, { mode: 0o600 });
    renameSync(tmp, file);
    cache = next;
  }
  return {
    async get(name) { return (await read())[name] || ''; },
    async has(name) { return Boolean((await read())[name]); },
    async set(name, value) { const all = await read(); all[name] = String(value); await write(all); },
    async remove(name) { const all = await read(); delete all[name]; if (Object.keys(all).length) await write(all); else { rmSync(file, { force: true }); cache = {}; } },
    async masked() { const all = await read(); return Object.fromEntries(SECRET_NAMES.map((n) => [n, all[n] ? { set: true, hint: mask(all[n]) } : { set: false }])); },
  };
}
