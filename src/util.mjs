// 공통 도구: 파일 읽기·쓰기, 프로세스 실행, 오류 형식
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

export const readText = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '');
export const readJson = (f, fallback) => { try { return JSON.parse(readText(f)); } catch { return fallback; } };
export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export const mtimeMs = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

// 임시 파일에 쓴 뒤 바꿔치기해서, 쓰는 도중 꺼져도 파일이 깨지지 않게 한다.
export function writeAtomic(file, text, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, mode ? { encoding: 'utf8', mode } : 'utf8');
  renameSync(tmp, file);
}
export const writeJson = (file, value, mode) => writeAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);

export const nowIso = () => new Date().toISOString();
export const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');   // 2026-09-30
export const stamp = (d = new Date()) => localDate(d) + '_' + d.toTimeString().slice(0, 8).replace(/:/g, '');

export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// 웹 화면의 요청 오류: status 가 응답 코드가 된다.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function need(cond, message, status = 400) { if (!cond) throw new HttpError(status, message); }

// 명령 실행(창 없이). 시간 초과 시 강제 종료한다.
export function run(cmd, args = [], { timeout = 15000, input, cwd, env } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message), timedOut: false }); }
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { } finish(-1); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; finish(-1); });
    child.on('close', (code) => finish(code));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

// PowerShell 한 줄 실행. 한글 출력이 깨지지 않도록 UTF-8로 맞춘다.
export const ps = (script, opts) => run('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`], opts);

export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
export const fwd = (p) => String(p).replace(/\\/g, '/');
export const isWindows = process.platform === 'win32';
