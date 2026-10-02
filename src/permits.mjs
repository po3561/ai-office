// 막힌 작업을 풀기 위한 "좁은 허용 규칙" 추가·확인·취소.
// 봇은 자기 권한 설정(.claude/settings*.json)을 직접 고칠 수 없다(permissions.deny).
// 대신 사용자가 텔레그램으로 허용한 뒤에만 이 모듈(ai-office permit …)로 허용 규칙을 더한다.
//   - 쓰는 곳은 .claude/settings.local.json 의 permissions.allow 뿐이다(견본이 관리하는 settings.json 은 건드리지 않는다).
//   - 차단 규칙(deny)은 더하지도 빼지도 않는다.
//   - 통째로 여는 규칙, 삭제·외부 전송·시스템 설정 계열, 봇 자신의 설정·토큰 폴더는 승인이 있어도 거부한다.
import { writeJson, need } from './util.mjs';
import { logChange } from './teams.mjs';
import { settingsFile, readLocalSettings, managedRules } from './drives.mjs';

export const MAX_PERMITS = 30;
const TOOL_RE = /^(Bash|PowerShell|Read|Edit|Write)\((.+)\)$/;
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

// 봇 자신의 설정·토큰·대시보드 상태·대시보드 API 는 어떤 규칙으로도 열 수 없다.
const PROTECTED_RE = /\.telegram|\.ai-office|\.claude|settings(\.local)?\.json|x-ai-office|ai-office\.mjs|[\\/]api[\\/]/i;
// 명령 규칙에서 열 수 없는 것: 삭제, 외부 전송, 임의 실행(셸·인터프리터), 시스템·보안 설정, 파일을 지우는 복사 옵션.
const RISKY_CMD_RE = new RegExp(
  '(^|[^a-z0-9_-])(rm|rmdir|rd|del|erase|remove-item|format|diskpart|curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|' +
  'ssh|scp|sftp|ftp|nc|ncat|certutil|bitsadmin|reg|regedit|netsh|schtasks|sc|taskkill|stop-process|icacls|takeown|chmod|chown|' +
  'sudo|runas|setx|net|start-process|invoke-expression|iex|powershell|pwsh|cmd|bash|sh|wsl|git\\s+push|npm\\s+publish)([^a-z0-9_-]|$)', 'i');
const DELETING_FLAG_RE = /\/(mir|purge|mov|move)(\s|\*|$)/i;

const readSettings = readLocalSettings;
// 드라이브 접근(대시보드에서 사용자가 부여)으로 들어간 규칙은 봇이 연 규칙이 아니므로 목록·개수에서 뺀다.
const botRules = (folder, allow) => allow.filter((a) => !managedRules(folder).allow.includes(a));

// 열어도 되는 규칙인지 검사하고, 다듬은 규칙 문자열을 돌려준다.
export function validateRule(raw) {
  const rule = String(raw ?? '').trim();
  need(rule, '--rule 이 필요합니다. 예: Bash(robocopy *기획부DB*)');
  need(rule.length <= 200 && !/[\u0000-\u001f]/.test(rule), '규칙이 너무 길거나 줄바꿈이 들어 있습니다.');
  const m = TOOL_RE.exec(rule);
  need(m, '규칙은 도구(Bash·PowerShell·Read·Edit·Write)와 범위를 함께 적어야 합니다. 예: Bash(robocopy *기획부DB*). 도구 이름만 쓰거나 다른 도구는 열 수 없습니다.');
  const [, tool, pattern] = m;
  const literal = pattern.replace(/[\s*:?]/g, '');
  need(!PROTECTED_RE.test(pattern), '봇 자신의 설정·토큰·대시보드 상태를 건드리는 규칙은 열 수 없습니다.', 403);
  if (COMMAND_TOOLS.has(tool)) {
    need(literal.length >= 3, '범위가 너무 넓습니다. 명령이나 폴더 이름처럼 구체적인 글자를 넣어 주세요.');
    need(!RISKY_CMD_RE.test(pattern) && !DELETING_FLAG_RE.test(pattern), '삭제·외부 전송·임의 실행·시스템 설정에 해당하는 규칙은 이 방법으로 열 수 없습니다.', 403);
  } else {
    need(!/\.\./.test(pattern), '상위 폴더(..)를 가리키는 경로는 쓸 수 없습니다.');
    need(pattern.replace(/[\s*:?/\\.]/g, '').length >= 3, '경로가 너무 넓습니다. 폴더나 파일 이름을 구체적으로 적어 주세요.');
  }
  return rule;
}

export function listPermits(folder) {
  return botRules(folder, readSettings(folder).permissions?.allow || []);
}

// 규칙을 연다. 호출하기 전에 사용자의 텔레그램 승인을 받았다는 증거(approved: 사용자 답장 원문)를 함께 남긴다.
export function addPermit(folder, { rule, reason, approved }) {
  const clean = validateRule(rule);
  const why = String(reason ?? '').trim();
  const ok = String(approved ?? '').trim();
  need(why.length >= 2, '--reason (왜 필요한지)이 필요합니다.');
  need(ok.length >= 2, '--approved (사용자가 텔레그램으로 허용한다고 답한 말)이 필요합니다. 먼저 사용자에게 허용 여부를 물어 주세요.');
  const cur = readSettings(folder);
  cur.permissions ||= {};
  cur.permissions.allow ||= [];
  if (cur.permissions.allow.includes(clean)) return { rule: clean, added: false };
  need(botRules(folder, cur.permissions.allow).length < MAX_PERMITS, `허용 규칙이 이미 ${MAX_PERMITS}개입니다. 쓰지 않는 규칙을 먼저 취소해 주세요.`);
  cur.permissions.allow.push(clean);
  writeJson(settingsFile(folder), cur);
  logChange(folder, '권한 허용', clean, why.slice(0, 200), ok.slice(0, 200));
  return { rule: clean, added: true };
}

// 연 규칙을 도로 닫는다. 더 안전한 쪽이라 승인 없이도 할 수 있다.
export function removePermit(folder, rule) {
  const target = String(rule ?? '').trim();
  need(target, '--rule 이 필요합니다.');
  const cur = readSettings(folder);
  const allow = cur.permissions?.allow || [];
  need(botRules(folder, allow).includes(target), `열려 있는 규칙이 아닙니다: ${target} (드라이브 접근은 대시보드에서 해제합니다)`, 404);
  cur.permissions.allow = allow.filter((a) => a !== target);
  writeJson(settingsFile(folder), cur);
  logChange(folder, '권한 취소', target, '허용했던 규칙을 다시 닫음', '');
  return { rule: target };
}
