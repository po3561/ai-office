// 공개(GitHub) 전에 개인정보·토큰·내 PC 경로가 저장소에 섞이지 않았는지 검사한다.
//   node scripts/privacy-check.mjs [추가로 막을 문자열 ...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, userInfo } from 'node:os';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIR = new Set(['.git', 'node_modules', 'dist']);
const BINARY = new Set(['.png', '.ico', '.zip', '.exe', '.woff', '.woff2']);

const rules = [
  { name: '텔레그램 봇 토큰', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: '텔레그램 채팅 ID(-100…)', re: /-100\d{9,}/ },
  { name: '이메일 주소', re: /[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.(com|net|org|kr|io)\b/ },
  { name: 'API 키 형태', re: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/ },
  { name: '개인 홈 폴더 경로', re: /C:[\\/]+Users[\\/]+(?!내이름|사용자|you|USERNAME|<)[^\\/\s"'`<>]+/i },
];
const extra = process.argv.slice(2);
const me = [userInfo().username, homedir().split(/[\\/]/).pop()].filter(Boolean);
for (const w of [...extra, ...me]) if (w.length >= 3) rules.push({ name: `내 정보 "${w}"`, re: new RegExp(`(?<![A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i') });

const hits = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (BINARY.has(extname(e.name).toLowerCase()) || statSync(p).size > 2_000_000) continue;
    const text = readFileSync(p, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      for (const r of rules) if (r.re.test(line) && !/privacy-check\.mjs$/.test(p)) hits.push(`${relative(root, p)}:${i + 1}  [${r.name}]  ${line.trim().slice(0, 110)}`);
    });
  }
})(root);

if (hits.length) { console.log(`⚠️ 개인정보로 의심되는 항목 ${hits.length}건\n` + hits.join('\n')); process.exit(1); }
console.log('✅ 개인정보·토큰으로 의심되는 항목이 없습니다.');
