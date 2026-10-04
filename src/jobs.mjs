// 오래 걸리는 일(설치·모델 받기·배포)을 백그라운드에서 돌리고, 화면이 진행 상황을 볼 수 있게 기록한다.
import { randomUUID } from 'node:crypto';
import { HttpError } from './util.mjs';

const MAX_LOG = 400;
const KEEP = 40;

export function createJobs() {
  const jobs = new Map();

  const view = (j) => ({
    id: j.id, kind: j.kind, label: j.label, state: j.state, step: j.step, progress: j.progress,
    log: j.log.slice(-60), error: j.error, startedAt: j.startedAt, endedAt: j.endedAt, result: j.result,
  });

  function prune() {
    const done = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.startedAt - b.startedAt);
    while (jobs.size > KEEP && done.length) jobs.delete(done.shift().id);
  }

  // kind: 같은 kind 의 작업이 이미 돌고 있으면 새로 만들지 않고 409 를 낸다(설치 버튼을 두 번 눌러도 한 번만 돈다).
  function start(kind, label, fn) {
    for (const j of jobs.values()) if (j.kind === kind && j.state === 'running') throw new HttpError(409, `이미 진행 중입니다: ${j.label}`);
    const job = { id: randomUUID(), kind, label, state: 'running', step: '', progress: { done: 0, total: 0 }, log: [], error: '', startedAt: Date.now(), endedAt: 0, result: null };
    jobs.set(job.id, job);
    const ctx = {
      log: (line) => { for (const l of String(line).split(/\r?\n/)) if (l.trim()) { job.log.push(l.trim().slice(0, 300)); if (job.log.length > MAX_LOG) job.log.shift(); } },
      step: (name) => { job.step = name; job.progress = { done: 0, total: 0 }; ctx.log(`▶ ${name}`); },
      progress: (done, total = 0) => { job.progress = { done, total }; },
    };
    Promise.resolve().then(() => fn(ctx)).then(
      (result) => { job.state = 'done'; job.result = result ?? null; job.endedAt = Date.now(); ctx.log('✓ 끝났습니다.'); prune(); },
      (e) => { job.state = 'error'; job.error = e?.message || String(e); job.endedAt = Date.now(); ctx.log(`✗ ${job.error}`); prune(); },
    );
    return view(job);
  }

  return {
    start,
    get(id) { const j = jobs.get(id); if (!j) throw new HttpError(404, '작업을 찾을 수 없습니다.'); return view(j); },
    list() { return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(view); },
    running(kind) { return [...jobs.values()].some((j) => j.kind === kind && j.state === 'running'); },
  };
}
