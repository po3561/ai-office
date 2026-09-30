// 테스트 도우미: 매 테스트마다 격리된 데이터 폴더를 쓴다(실제 사용자 데이터를 건드리지 않는다).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ai-office-test-'));
  process.env.AI_OFFICE_HOME = join(root, 'data');
  return root;
}

// 예전 방식의 사무실 폴더(office.json 없음, 조직도 표만 있는 CLAUDE.md)
export function fakeLegacyOffice(root) {
  const dir = join(root, 'legacy-office');
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), [
    '# 옛 사무실', '', '## 조직도', '',
    '| 팀 | 에이전트 | 담당 업무 |', '|---|---|---|',
    '| 개발팀 | `developer` | 개발 |', '',
    '- 팀 호출 규칙', '', '## 다른 절', '내용',
  ].join('\n'), 'utf8');
  writeFileSync(join(dir, '.claude', 'agents', 'developer.md'),
    '---\nname: developer\ndescription: 개발팀장. 프로그램·웹페이지 개발이 필요할 때 맡긴다.\nmodel: sonnet\ncolor: green\n---\n\n너는 개발팀장이다.\n', 'utf8');
  return dir;
}
