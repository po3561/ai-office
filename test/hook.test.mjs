import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../src/hooks/status-hook.mjs', import.meta.url));
const office = mkdtempSync(join(tmpdir(), 'ai-office-hook-'));
const status = () => JSON.parse(readFileSync(join(office, '.ai-office', 'state', 'status.json'), 'utf8'));
const fire = (event, input) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: office }, encoding: 'utf8' });

test('텔레그램 지시가 들어오면 비서실장이 작업 중이 된다', () => {
  fire('chief_task', { prompt: '<channel source="plugin:telegram:telegram" chat_id="1">보고서 만들어줘</channel>' });
  const s = status();
  assert.equal(s.chief.state, 'working');
  assert.equal(s.chief.task, '보고서 만들어줘');
});

test('팀이 시작하고 끝나면 상태와 오늘 완료 건수가 바뀐다', () => {
  fire('team_start', { tool_name: 'Agent', tool_input: { subagent_type: 'researcher', description: '경쟁사 조사' } });
  assert.equal(status().teams.researcher.state, 'working');
  fire('team_done', { tool_name: 'Agent', tool_input: { subagent_type: 'researcher', description: '경쟁사 조사' } });
  const t = status().teams.researcher;
  assert.equal(t.state, 'idle');
  assert.equal(t.doneToday, 1);
  assert.equal(t.lastDone, '경쟁사 조사');
});

test('같은 팀을 동시에 부르면 모두 끝나야 대기가 된다', () => {
  fire('team_start', { tool_input: { subagent_type: 'developer', description: 'A' } });
  fire('team_start', { tool_input: { subagent_type: 'developer', description: 'B' } });
  fire('team_done', { tool_input: { subagent_type: 'developer', description: 'A' } });
  assert.equal(status().teams.developer.state, 'working');
  fire('team_done', { tool_input: { subagent_type: 'developer', description: 'B' } });
  assert.equal(status().teams.developer.state, 'idle');
  assert.equal(status().teams.developer.doneToday, 2);
});

test('이미 완료 처리된 건은 SubagentStop 이 다시 세지 않는다', () => {
  fire('team_start', { tool_input: { subagent_type: 'planner', description: 'C' } });
  fire('team_done', { tool_input: { subagent_type: 'planner', description: 'C' } });
  fire('team_stop', { agent_type: 'planner' });
  assert.equal(status().teams.planner.doneToday, 1);
});

test('잘못된 입력에도 훅은 오류 없이 끝난다', () => {
  const r = spawnSync(process.execPath, [HOOK, 'team_start'], { input: 'not json', env: { ...process.env, CLAUDE_PROJECT_DIR: office }, encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('업무가 끝나면 비서실장이 대기로 돌아온다', () => {
  fire('chief_idle', {});
  assert.equal(status().chief.state, 'idle');
});
