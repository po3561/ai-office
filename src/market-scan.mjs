// 스킬 마켓 검사: 게시 전에는 "내 정보가 새어 나가지 않는지", 설치 전에는 "이 스킬이 위험하지 않은지"를 본다.
// 스킬은 단순한 문서가 아니라 AI에게 주는 지시문(+도구 권한·스크립트)이므로 양쪽 모두 보수적으로 검사한다.
//
// 결과의 level:
//   block  게시할 수 없음(토큰·개인 키·주민등록번호 등, 허용되지 않는 파일 형식)
//   warn   사용자가 확인해야 함(전화번호·이메일·내 PC 경로·내용을 검사할 수 없는 파일 등)
//   risk   설치할 때 위험할 수 있음(스크립트, 도구 권한, 지시 무시 문구, 외부 전송·삭제 명령 등)
import { extname } from 'node:path';
import { parseFrontmatter } from './skills.mjs';

export const LIMITS = { maxFileBytes: 1_000_000, maxTotalBytes: 5_000_000, maxFiles: 60, maxDepth: 4 };

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yml', '.yaml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const OPAQUE_EXT = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.hwp', '.hwpx']);   // 내용을 검사할 수 없는 문서
const SCRIPT_EXT = new Set(['.ps1', '.psm1', '.cmd', '.bat', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.vbs', '.wsf']);
const BLOCKED_EXT = new Set(['.exe', '.dll', '.msi', '.lnk', '.scr', '.com', '.jar', '.apk', '.dmg', '.iso', '.zip', '.7z', '.rar', '.gz', '.tar',
  '.docm', '.xlsm', '.pptm', '.reg', '.hta', '.jse', '.svg', '.html', '.htm']);

export const fileKind = (path) => {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (OPAQUE_EXT.has(ext)) return 'opaque';
  if (SCRIPT_EXT.has(ext)) return 'script';
  if (BLOCKED_EXT.has(ext)) return 'blocked';
  return 'unknown';
};

// ── 규칙 ──
const luhn = (digits) => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = digits.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return digits.length >= 13 && sum % 10 === 0;
};

const SECRET_RULES = [   // 게시 차단
  { code: 'telegram-token', label: '텔레그램 봇 토큰', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { code: 'api-key', label: 'API 키', re: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/ },
  { code: 'private-key', label: '개인 키', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'rrn', label: '주민등록번호', re: /(?<!\d)\d{6}-[1-4]\d{6}(?!\d)/ },
  { code: 'card', label: '카드 번호', re: /(?<!\d)(?:\d{4}[- ]){3}\d{4}(?!\d)/, check: (m) => luhn(m.replace(/\D/g, '')) },
];

const PERSONAL_RULES = [   // 사용자가 확인해야 게시 가능
  { code: 'password', label: '비밀번호로 보이는 값', re: /(?:password|passwd|비밀번호|패스워드)\s*[:=：]\s*[^\s'"`]{4,}/i },
  { code: 'phone', label: '전화번호', re: /(?<!\d)(01[016789][-. ]?\d{3,4}[-. ]?\d{4}|0\d{1,2}-\d{3,4}-\d{4})(?!\d)/ },
  { code: 'email', label: '이메일 주소', re: /[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { code: 'home-path', label: '내 PC의 사용자 폴더 경로', re: /[A-Za-z]:[\\/]+Users[\\/]+(?!<|USERNAME|사용자|you|Public|내이름)[^\\/\s"'`<>]+/i },
  { code: 'chat-id', label: '텔레그램 채팅 ID', re: /-100\d{9,}/ },
];

const RISK_RULES = [   // 설치할 때 경고(기본 차단)
  { code: 'inject-ko', label: '이전 지시를 무시하라는 문구', re: /(이전|위|앞)의?\s*(모든\s*)?(지시|지침|규칙|명령|프롬프트)[을를]?\s*(모두\s*)?(무시|잊어)/ },
  { code: 'inject-en', label: '이전 지시를 무시하라는 문구', re: /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)/i },
  { code: 'bypass', label: '권한 확인을 건너뛰라는 문구', re: /(dangerously-skip-permissions|bypassPermissions|권한\s*(확인|승인)[을를]?\s*(생략|건너뛰|무시))/i },
  { code: 'exfil', label: '외부 주소로 보내거나 받아오는 명령', re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*https?:\/\//i },
  { code: 'destructive', label: '삭제·포맷 명령', re: /\b(rm\s+-rf|Remove-Item\b[^\n]*-Recurse|rmdir\s+\/s|del\s+\/[sfq]|format\s+[a-z]:)/i },
  { code: 'secret-area', label: '토큰·비밀 폴더를 읽으라는 문구', re: /(\.telegram\b|\.ssh\b|\.aws\b|credentials\.json)/i },
];

const mask = (s) => { s = String(s); return s.length <= 8 ? s.slice(0, 2) + '…' : `${s.slice(0, 3)}…${s.slice(-2)}`; };
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// files: [{ path, buf }]  →  { findings, blockers, warnings, risks, riskLevel }
export function scanFiles(files, { honorifics = [] } = {}) {
  const findings = [];
  const seen = new Map();
  const add = (level, code, file, line, message, sample = '') => {
    const key = `${code}|${file}`;
    const n = (seen.get(key) || 0) + 1; seen.set(key, n);
    if (n <= 3 && findings.length < 200) findings.push({ level, code, file, line, message, sample: sample ? mask(sample) : '' });
  };

  const names = honorifics.map((w) => String(w || '').trim()).filter((w) => w.length >= 2);
  const nameRules = names.map((w) => ({ code: 'my-name', label: `내 호칭·이름 "${w}"`, re: new RegExp(escRe(w)) }));

  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) add('block', 'no-skill-md', 'SKILL.md', 0, 'SKILL.md 가 없습니다. 스킬 폴더 바로 아래에 SKILL.md 가 있어야 합니다.');
  else {
    const text = skillMd.buf.toString('utf8').replace(/^﻿/, '');
    const fm = parseFrontmatter(text);
    if (!fm.name) add('warn', 'no-name', 'SKILL.md', 1, '머리말에 name 이 없습니다.');
    if (!fm.description) add('warn', 'no-description', 'SKILL.md', 1, '머리말에 description 이 없어서 Claude 가 이 스킬을 언제 써야 하는지 알 수 없습니다.');
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (head) for (const key of ['allowed-tools', 'hooks', 'permissions']) {
      if (new RegExp(`^\\s*${key}\\s*:`, 'mi').test(head[1])) add('risk', `fm-${key}`, 'SKILL.md', 1, `머리말에 ${key} 항목이 있습니다. 이 스킬이 도구 권한·자동 실행을 바꿀 수 있습니다.`);
    }
  }

  for (const f of files) {
    const kind = fileKind(f.path);
    if (kind === 'blocked') { add('block', 'blocked-type', f.path, 0, `허용하지 않는 파일 형식입니다(${extname(f.path) || '확장자 없음'}).`); continue; }
    if (kind === 'unknown') { add('block', 'unknown-type', f.path, 0, `알 수 없는 파일 형식입니다(${extname(f.path) || '확장자 없음'}). 글(.md .txt .csv .json .yml)과 이미지만 공유할 수 있습니다.`); continue; }
    if (kind === 'opaque') { add('warn', 'opaque-file', f.path, 0, '내용을 검사할 수 없는 문서입니다. 개인정보가 없는지 직접 확인해 주세요.'); continue; }
    if (kind === 'image') continue;
    if (kind === 'script') add('risk', 'script', f.path, 0, '실행되는 스크립트 파일입니다. 설치하면 AI가 이 코드를 실행할 수 있습니다.');
    if (f.buf.includes(0)) { add('block', 'binary-text', f.path, 0, '글 파일이 아닌 내용(바이너리)이 들어 있습니다.'); continue; }
    const lines = f.buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.length > 4000) line = line.slice(0, 4000);
      for (const r of SECRET_RULES) { const m = r.re.exec(line); if (m && (!r.check || r.check(m[0]))) add('block', r.code, f.path, i + 1, `${r.label}이(가) 들어 있습니다.`, m[0]); }
      for (const r of [...PERSONAL_RULES, ...nameRules]) { const m = r.re.exec(line); if (m) add('warn', r.code, f.path, i + 1, `${r.label}이(가) 들어 있습니다.`, m[0]); }
      for (const r of RISK_RULES) { const m = r.re.exec(line); if (m) add('risk', r.code, f.path, i + 1, `위험할 수 있는 내용: ${r.label}`, m[0]); }
    });
  }

  const blockers = findings.filter((x) => x.level === 'block');
  const warnings = findings.filter((x) => x.level === 'warn');
  const risks = findings.filter((x) => x.level === 'risk');
  return { findings, blockers, warnings, risks, riskLevel: risks.length ? 'danger' : (warnings.length ? 'caution' : 'safe') };
}
