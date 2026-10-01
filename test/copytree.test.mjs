import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree } from '../src/util.mjs';

// fs.cpSync 는 Node 24 Windows 에서 한글 이름 파일을 덮어쓸 때 프로세스를 죽인다. copyTree 는 그렇지 않아야 한다.
test('한글 이름 파일·폴더도 덮어쓰며 복사하고, 필터로 건너뛸 수 있다', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-copy-'));
  const from = join(root, 'from'), to = join(root, 'to');
  mkdirSync(join(from, '업무데이터'), { recursive: true });
  mkdirSync(join(from, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(from, '업무데이터', '회사정보.md'), '새 내용');
  writeFileSync(join(from, 'node_modules', 'x', 'a.js'), 'skip');
  mkdirSync(join(to, '업무데이터'), { recursive: true });
  writeFileSync(join(to, '업무데이터', '회사정보.md'), '옛 내용');
  copyTree(from, to, (p) => !/node_modules/.test(p));
  assert.equal(readFileSync(join(to, '업무데이터', '회사정보.md'), 'utf8'), '새 내용');
  assert.equal(existsSync(join(to, 'node_modules')), false);
  copyTree(join(from, '업무데이터', '회사정보.md'), join(to, '새폴더', '회사정보.md'));
  assert.equal(readFileSync(join(to, '새폴더', '회사정보.md'), 'utf8'), '새 내용');
});
