// 사무실 실시간 상태(status.json) 읽기. 이 프로그램의 훅이 쓰는 위치(.ai-office/state)와
// 예전 AI-Office 사무실이 쓰던 위치(.system/state)를 모두 인식한다.
import { join } from 'node:path';
import { readJson, isFile } from './util.mjs';

const EMPTY = () => ({ chief: { state: 'idle' }, teams: {}, events: [] });

export function statusPath(folder) {
  const mine = join(folder, '.ai-office', 'state', 'status.json');
  const legacy = join(folder, '.system', 'state', 'status.json');
  if (isFile(mine)) return mine;
  if (isFile(legacy)) return legacy;
  return mine;
}

export const readStatus = (folder) => ({ ...EMPTY(), ...readJson(statusPath(folder), {}) });

const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

export function summarize(status) {
  const teams = Object.values(status.teams || {});
  return {
    chiefState: (status.chief && status.chief.state) || 'idle',
    workingTeams: teams.filter((t) => t.state === 'working').length,
    doneToday: teams.reduce((n, t) => n + (isToday(t.lastDoneAt) ? (t.doneToday || 0) : 0), 0),
    updatedAt: status.updatedAt || '',
  };
}
