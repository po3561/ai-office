// 에이전트 선택·시스템 프롬프트·답 정리: 로컬 런타임(Node)과 웹 배포용 Worker(Cloudflare)가 똑같이 쓰는 순수 함수.
// Node 전용 모듈(fs 등)을 불러오지 않는다 — 이 파일은 그대로 Worker 에 올라간다.
export const stripThinking = (s) => String(s).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '').trim();

export function chunk(text, size = 3800) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

// skillText: 이 역할에 붙인 스킬 본문(로컬은 파일에서 읽고, 웹 배포는 배포할 때 미리 담아 둔다)
export function buildSystem(bot, { agent, room, topic, skillText = '', now = new Date() } = {}) {
  const parts = [bot.persona || ''];
  parts.push(`사용자를 "${bot.honorific || '사용자님'}"이라 부른다. 오늘은 ${now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: bot.timeZone || undefined })}이다.`);
  if (agent) parts.push(`## 지금 맡은 역할: ${agent.emoji} ${agent.name}\n${agent.role ? agent.role + '\n' : ''}${agent.instructions || ''}`.trim());
  if (room?.instructions) parts.push(`## 이 방의 지침\n${room.instructions}`);
  if (topic?.instructions) parts.push(`## 이 주제의 지침\n${topic.instructions}`);
  if (skillText) parts.push(`## 쓸 수 있는 스킬\n${skillText}`);
  if (bot.agents?.length > 1) parts.push(`## 같은 사무실의 다른 역할\n${bot.agents.map((a) => `- ${a.emoji} ${a.name}(${a.key}): ${a.role}`).join('\n')}\n사용자가 다른 역할이 필요한 요청을 하면 "/agent 키" 로 바꿔 달라고 안내한다.`);
  return parts.filter(Boolean).join('\n\n');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 우선순위: 이름으로 부름 → 주제 담당 → 방 담당 → 봇 기본 역할
export function pickAgent(bot, { room, topic, text }) {
  const byKey = (k) => bot.agents.find((a) => a.key === k);
  const t = text.trim();
  for (const a of bot.agents) {
    const m = new RegExp(`^(@?${esc(a.key)}|${esc(a.name)})(?=[\\s,:：]|$)`, 'i').exec(t);
    if (m) return { agent: a, text: t.slice(m[0].length).replace(/^[\s,:：]+/, '') || text };
  }
  return { agent: (topic?.agent && byKey(topic.agent)) || (room?.agent && byKey(room.agent)) || byKey(bot.defaultAgent) || null, text };
}
