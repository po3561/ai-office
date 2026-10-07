// 사무실 "방 현황": 봇들이 초대되어 있는 텔레그램 방·주제를 한 모양으로 모아 보여 준다.
//  - LAPIS 봇(bots/<id>/bot.json) · Claude 사무실(새 방식 rooms.json) · Claude 사무실(예전 방식)이 저장하는 모양이 서로 달라서 여기서 하나로 맞춘다.
// 이 파일은 읽기만 한다(방 설정을 바꾸는 일은 각 화면의 기존 API 가 한다).

const str = (v) => (typeof v === 'string' ? v : '');

// LAPIS 봇 한 개의 방들. agents: [{key,name,emoji}]
export function lapisRooms(bot) {
  const agents = new Map((bot.agents || []).map((a) => [a.key, a]));
  const who = (key) => { const a = agents.get(key); return a ? { key, name: a.name, emoji: a.emoji || '' } : null; };
  const defaultAgent = who(bot.defaultAgent || '');
  const allowed = (bot.telegram?.allowFrom || []).length;
  return Object.entries(bot.telegram?.rooms || {}).map(([id, r]) => ({
    id, title: str(r.title) || `(이름 모름) ${id}`, type: str(r.type) || 'group', isForum: Object.keys(r.topics || {}).length > 0,
    botStatus: 'unknown', connected: r.connected !== false, replyMode: r.mode === 'all' ? 'all' : 'mention',
    assignee: who(r.agent) || (defaultAgent ? { ...defaultAgent, inherited: true } : null),
    task: str(r.instructions), invitedBy: null, invitedAt: 0, lastSeen: str(r.seenAt), memberCount: null, checkError: '', allowedCount: allowed,
    topics: Object.entries(r.topics || {}).map(([tid, t]) => ({
      id: tid, name: str(t.name), closed: false, assignee: who(t.agent), task: str(t.instructions), lastSeen: '',
    })),
  }));
}

// Claude 사무실(새 방식): tg.roomsInfo() 의 결과
export function officeRooms(info) {
  return (info?.rooms || []).map((r) => ({
    id: r.id, title: r.title, type: r.type || 'group', isForum: Boolean(r.isForum), botStatus: r.botStatus || 'unknown',
    connected: Boolean(r.connected), replyMode: r.connected ? (r.requireMention ? 'mention' : 'all') : 'unknown', assignee: null,
    task: r.task || '', invitedBy: r.invitedBy || null, invitedAt: r.invitedAt || 0, lastSeen: '', memberCount: null, checkError: r.checkError || '',
    allowedCount: r.allowFromCount || 0,
    topics: (r.topics || []).map((t) => ({ id: t.id, name: t.name || '', closed: Boolean(t.closed), assignee: null, task: t.task || '', lastSeen: '' })),
  }));
}

// Claude 사무실(예전 방식): lr.listRooms() 의 결과 — 주제마다 담당 팀이 정해져 있다
export function legacyOfficeRooms(list) {
  return (list || []).map((r) => ({
    id: r.id, title: r.title, type: r.type || 'group', isForum: Boolean(r.isForum), botStatus: r.botStatus || 'unknown',
    connected: Boolean(r.linked), replyMode: r.requireMention == null ? 'unknown' : (r.requireMention ? 'mention' : 'all'), assignee: null,
    task: '', invitedBy: null, invitedAt: 0, lastSeen: r.lastSeen || '', memberCount: r.memberCount ?? null, checkError: r.error || '', allowedCount: 0,
    topics: (r.topics || []).map((t) => ({
      id: t.id, name: t.name || '', closed: false, assignee: t.teamName ? { key: t.team, name: t.teamName, emoji: '' } : null, task: '', lastSeen: t.lastSeen || '',
    })),
  }));
}

// 한 화면에서 쓰는 요약: 방 수, 연결된 방, 주제 수
export function tally(rooms) {
  return { total: rooms.length, connected: rooms.filter((r) => r.connected).length, topics: rooms.reduce((n, r) => n + r.topics.length, 0) };
}

// 방·주제마다 마지막 대화 한 줄(last)을 붙인다. summary: { [방]: { last, topics: { [주제]: { last, count } } } }
export function attachActivity(rooms, summary) {
  for (const r of rooms) {
    const s = summary?.[r.id];
    r.last = s?.last || null;
    for (const t of r.topics) { const ts = s?.topics?.[t.id]; t.last = ts?.last || null; t.count = ts?.count || 0; }
  }
}
