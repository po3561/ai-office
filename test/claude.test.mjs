import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const root = sandbox();

test('공백·한글이 든 경로의 claude(.cmd)도 실제로 실행해 버전과 로그인 상태를 읽는다', { skip: process.platform !== 'win32' }, async () => {
  const dir = join(root, '공백 있는 폴더');
  mkdirSync(dir, { recursive: true });
  const fake = join(dir, 'claude.cmd');
  writeFileSync(fake, [
    '@echo off',
    'if "%1"=="--version" (echo 9.9.9 (Claude Code) & exit /b 0)',
    'if "%1"=="auth" (echo {"loggedIn":true,"email":"t@example.com","subscriptionType":"pro","authMethod":"claude.ai"} & exit /b 0)',
    'exit /b 1', '',
  ].join('\r\n'));
  process.env.AI_OFFICE_CLAUDE = fake;
  const { claudeInfo } = await import('../src/claude.mjs');
  const info = await claudeInfo({ fresh: true });
  assert.equal(info.installed, true);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.auth.loggedIn, true);
  assert.equal(info.auth.email, 't@example.com');
});
