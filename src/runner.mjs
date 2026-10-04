// 사무실 켜기·끄기·재시작과 자동 복구(감시).
// 사무실 = 그 폴더에서 `claude --channels plugin:telegram…` 를 실행하는 최소화된 콘솔 창 하나.
// Hermes 같은 외부 봇은 여기서 절대 켜거나 끄지 않는다(읽기 전용).
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { RUN_DIR, TG_PLUGIN } from './paths.mjs';
import { isFile, readJson, writeJson, need, run, psQuote, isWindows, nowIso } from './util.mjs';
import { getOffice, listOffices } from './offices.mjs';
import { findClaude, claudeInfo } from './claude.mjs';
import { tokenStatus } from './telegram.mjs';
import { toolDirs } from './toolpath.mjs';

const pidFile = (id) => join(RUN_DIR, `${id}.pid`);
const scriptFile = (id) => join(RUN_DIR, `${id}.ps1`);
const restartFile = (id) => join(RUN_DIR, `restart-${id}.json`);
const stoppedFile = (id) => join(RUN_DIR, `${id}.stopped`);   // 사용자가 직접 끈 사무실은 자동으로 다시 켜지 않는다

// 출근 창이 뜨고 pid 파일이 생기기까지 수십 초 걸릴 수 있다. 그 사이에 수동 출근과 감시(자동 출근)가 겹쳐
// 세션이 중복으로 뜨지 않도록, 방금 켠 사무실은 잠시 '켜는 중'으로 본다.
const startedAt = new Map();
const STARTING_GRACE_MS = 90 * 1000;
const recentlyStarted = (id) => Date.now() - (startedAt.get(id) || 0) < STARTING_GRACE_MS;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function readPid(id) {
  try { const n = parseInt(readFileSync(pidFile(id), 'utf8').replace(/^﻿/, ''), 10); return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}

// Hermes 게이트웨이 상태는 상태 파일을 읽기만 한다.
export function hermesRuntime(o) {
  const g = readJson(join(o.folder, 'gateway_state.json'), null);
  if (!g) return { running: false, detail: '상태 파일 없음' };
  const running = g.gateway_state === 'running' && Number.isInteger(g.pid) && alive(g.pid);
  const tg = g.platforms && g.platforms.telegram;
  return { running, detail: running ? `게이트웨이 가동 중${tg ? ` · 텔레그램 ${tg.state === 'connected' ? '연결됨' : tg.state}` : ''}` : '게이트웨이 꺼짐' };
}

// legitPollers: 사무실 세션이 띄운 텔레그램 수신 프로세스 수(진단에서 받아 온다). 직접 만든 사무실이 아닌 곳의 가동 판단에 쓴다.
export function runtime(o, { legitPollers = 0 } = {}) {
  if (o.kind === 'hermes') return hermesRuntime(o);
  const pid = readPid(o.id);
  if (pid && alive(pid)) return { running: true, pid, detail: '가동 중' };
  if (o.launch && legitPollers > 0) return { running: true, detail: '가동 중(기존 실행 방식)' };
  return { running: false, detail: '꺼짐' };
}

function launcherScript(o, claudePath, extraDirs = toolDirs()) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$Host.UI.RawUI.WindowTitle = ${psQuote(`AI-Office · ${o.name}`)}`,
    `Set-Location -LiteralPath ${psQuote(o.folder)}`,
    `$env:TELEGRAM_STATE_DIR = ${psQuote(o.stateDir)}`,
    ...(extraDirs.length ? [`$env:Path = ${psQuote(extraDirs.join(';') + ';')} + $env:Path`] : []),   // 앱이 설치한 Bun 등을 사무실 창이 찾도록
    "$env:MCP_TIMEOUT = '180000'",   // 저사양 PC에서는 텔레그램 플러그인 시작(bun install)이 30초를 넘겨 연결이 끊기므로 대기 시간을 늘린다.
    `New-Item -ItemType Directory -Force -Path ${psQuote(RUN_DIR)} | Out-Null`,
    `Set-Content -Path ${psQuote(pidFile(o.id))} -Value $PID`,
    `try { & ${psQuote(claudePath)} --channels plugin:${TG_PLUGIN} --permission-mode auto } finally { Remove-Item ${psQuote(pidFile(o.id))} -ErrorAction SilentlyContinue }`,
    '',
  ].join('\r\n');
}

export async function checkReady(o) {
  const bin = await findClaude();
  need(bin, 'Claude Code가 설치되어 있지 않습니다. 「연결」 화면에서 설치해 주세요.', 409);
  const info = await claudeInfo();
  need(info.auth.loggedIn, 'Claude에 로그인되어 있지 않습니다. 「연결」 화면에서 로그인해 주세요.', 409);
  if (!o.launch) need(tokenStatus(o.stateDir).set, '텔레그램 봇 토큰이 아직 없습니다. 「연결」 화면에서 먼저 연결해 주세요.', 409);
  return bin;
}

export async function startOffice(id, ctx = {}) {
  need(isWindows, '사무실 켜기는 Windows에서만 지원합니다.', 501);
  const o = getOffice(id);
  need(o.kind !== 'hermes' && !o.readonly, `"${o.name}"은(는) 별개의 봇이라 이 프로그램에서 켜거나 끄지 않습니다.`, 403);
  need(!runtime(o, ctx).running, '이미 근무 중입니다.', 409);
  need(!recentlyStarted(id), '방금 출근시켰습니다. 창이 뜰 때까지 잠시 기다려 주세요.', 409);
  const bin = await checkReady(o);
  rmSync(restartFile(id), { force: true });
  rmSync(stoppedFile(id), { force: true });
  startedAt.set(id, Date.now());
  if (o.launch && o.launch.start) {
    // 예전 방식으로 만들어진 사무실은 그 사무실의 출근 스크립트를 그대로 쓴다.
    // detached 금지: 콘솔 없이 뜬 Windows PowerShell 5.1 은 스크립트를 실행하지 않고 끝난다.
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', o.launch.start], { cwd: o.folder, stdio: 'ignore', windowsHide: true }).unref();
    return { started: true, via: 'script' };
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(scriptFile(id), '﻿' + launcherScript(o, bin.path), 'utf8');
  const cmd = `Start-Process powershell.exe -WindowStyle Minimized -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(scriptFile(id))})`;
  // stdio를 'ignore'로 두면 일부 Windows에서 최소화 창이 뜨지 않으므로 파이프 방식(run)으로 띄운다.
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000 });
  return { started: true, via: 'launcher' };
}

export async function stopOffice(id) {
  const o = getOffice(id);
  need(o.kind !== 'hermes' && !o.readonly, `"${o.name}"은(는) 별개의 봇이라 이 프로그램에서 켜거나 끄지 않습니다.`, 403);
  startedAt.delete(id);
  const pid = readPid(id);
  let stopped = false;
  if (pid && alive(pid)) {
    const r = await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 });
    stopped = r.code === 0;
  } else if (o.launch && o.launch.stop) {
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', o.launch.stop], { cwd: o.folder, stdio: 'ignore', windowsHide: true }).unref();
    stopped = true;
  }
  rmSync(pidFile(id), { force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(stoppedFile(id), nowIso(), 'utf8');
  return { stopped };
}

// 폐쇄한 사무실이 남긴 실행 흔적(pid·시작 스크립트·재시작 요청·퇴근 표시)을 지운다. 같은 id 를 새 사무실이 쓰게 되어도 영향이 없도록.
export function forgetRuntime(id) {
  startedAt.delete(id);
  for (const f of [pidFile(id), scriptFile(id), restartFile(id), stoppedFile(id)]) rmSync(f, { force: true });
}

// 사무실 안에서 봇이 "N초 뒤 다시 출근해서 적용"을 요청할 때 쓴다. 요청만 적어 두면 대시보드 서버가 처리한다.
export function requestRestart(id, delaySec = 60) {
  const o = getOffice(id);
  need(o.kind !== 'hermes' && !o.readonly, `"${o.name}"은(는) 읽기 전용입니다.`, 403);
  const d = Math.min(Math.max(Number(delaySec) || 60, 5), 3600);
  mkdirSync(RUN_DIR, { recursive: true });
  writeJson(restartFile(id), { at: Date.now() + d * 1000, requestedAt: nowIso() });
  return { id, inSec: d };
}

let budget = new Map();   // 사무실별 자동 재시작 횟수(10분에 3번까지)

// 주기적으로 호출: 예약된 재시작 처리 + '항상 켜두기' 사무실이 꺼져 있으면 다시 켠다.
export async function watchdogTick({ autoRestart = true, legitPollers = 0 } = {}) {
  const acts = [];
  let files = [];
  try { files = readdirSync(RUN_DIR).filter((f) => /^restart-.+\.json$/.test(f)); } catch { }
  for (const f of files) {
    const id = f.slice('restart-'.length, -'.json'.length);
    const req = readJson(join(RUN_DIR, f), null);
    if (!req || Date.now() < req.at) continue;
    rmSync(join(RUN_DIR, f), { force: true });
    try {
      await stopOffice(id);
      await new Promise((r) => setTimeout(r, 4000));
      await startOffice(id, { legitPollers: 0 });
      acts.push({ id, did: 'restart' });
    } catch (e) { acts.push({ id, did: 'restart-failed', error: e.message }); }
  }
  if (autoRestart) {
    for (const o of listOffices()) {
      if (!o.autoStart || o.kind === 'hermes' || o.readonly || isFile(stoppedFile(o.id)) || recentlyStarted(o.id)) continue;
      if (runtime(o, { legitPollers }).running) { budget.delete(o.id); continue; }
      const now = Date.now();
      const tries = (budget.get(o.id) || []).filter((t) => now - t < 10 * 60 * 1000);
      if (tries.length >= 3) continue;
      try { await startOffice(o.id, { legitPollers }); tries.push(now); budget.set(o.id, tries); acts.push({ id: o.id, did: 'auto-start' }); } catch (e) { tries.push(now); budget.set(o.id, tries); acts.push({ id: o.id, did: 'auto-start-failed', error: e.message }); }
    }
  }
  return acts;
}

export const _test = { launcherScript, isFile };
