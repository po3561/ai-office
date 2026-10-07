// 엔진(대시보드 서버) 버전 불일치 방지.
// 업데이트는 디스크의 파일만 바꾼다. 이미 켜져 있던 옛 엔진 프로세스가 그대로 살아 있으면(예: 시작 도우미가 "이미 실행 중"이라며 건너뜀)
// 새 화면·새 파일과 옛 엔진 코드가 섞여 출근·봇·텔레그램 기능이 멈춘다. 켜져 있는 엔진의 버전이 디스크와 다르면 새 것으로 바꾼다.
import { join } from 'node:path';
import { APP_HOME } from './paths.mjs';
import { readJson, run, isWindows } from './util.mjs';

export const diskVersion = (appHome = APP_HOME) => String(readJson(join(appHome, 'package.json'), {}).version || '');

// 켜져 있는 우리 엔진이면 { app, version }, 아니면 null
export async function pingEngine(port, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j && j.app === 'ai-office' ? j : null;
  } catch { return null; }
}

// 켜진 엔진의 버전이 디스크와 다르면 옛 엔진이다(버전을 알릴 수 없을 만큼 오래된 엔진도 옛 엔진).
export const isStale = (live, disk = diskVersion()) => Boolean(live) && Boolean(disk) && String(live.version || '') !== disk;

// 우리 엔진으로 확인된 포트의 프로세스만 끝내고, 포트가 비워질 때까지 기다린다. 끝났으면 true.
export async function stopEngine(port, { ping = pingEngine, exec = run, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!isWindows || !(await ping(port))) return false;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    if (!(await ping(port))) return true;
    await wait(300);
  }
  return false;
}

// 엔진이 스스로 "내 코드가 디스크보다 낡았는지" 살피는 도구. 낡았으면 한 번만 다시 시작을 요청한다.
// busy(): 업데이트 적용 중처럼 파일이 바뀌는 도중이면 true — 그동안은 기다린다.
export function createStaleWatcher({ loaded, readDisk = diskVersion, restart, busy = () => false, log = () => {} }) {
  let fired = false;
  return function check() {
    if (fired || busy()) return false;
    const disk = readDisk();
    if (!disk || disk === loaded) return false;
    fired = true;
    log(`[ai-office] 디스크의 프로그램(${disk})이 실행 중인 엔진(${loaded})보다 새 버전이라 엔진을 다시 시작합니다.`);
    restart();
    return true;
  };
}
