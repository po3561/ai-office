// 로그·오류 메시지·텔레그램 답장에 비밀값이 섞여 나가지 않게 가린다(마지막 방어선).
//  - 텔레그램 봇 토큰, OpenAI·Anthropic 키, Bearer 토큰, Cloudflare/GitHub 토큰 모양
//  - Users 폴더 아래의 사용자 이름은 ~ 로 줄인다
const RULES = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[텔레그램 토큰 가림]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[키 가림]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[키 가림]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '[키 가림]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [가림]'],
  [/\b(?:cfut|cfat)_[A-Za-z0-9_-]{20,}/g, '[키 가림]'],
  [/([A-Za-z]:\\Users\\)[^\\/:*?"<>|\r\n]+/gi, '$1~'],
];

// paths: false 이면 폴더 경로는 그대로 둔다(AI 의 답에 나온 경로까지 바꾸면 혼란스럽다).
export function redact(text, { paths = true } = {}) {
  let out = String(text ?? '');
  for (const [re, to] of paths ? RULES : RULES.slice(0, -1)) out = out.replace(re, to);
  return out;
}
