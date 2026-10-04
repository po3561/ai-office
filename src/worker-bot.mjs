// LAPIS 웹 배포용 Worker: 봇 하나를 Cloudflare Workers 에서 돌린다(PC가 꺼져 있어도 동작).
//   GET  /                웹 채팅 화면(비밀번호로 보호)
//   POST /api/chat        웹 채팅 요청(Authorization: Bearer <비밀번호>)
//   POST /telegram/<경로> 텔레그램 웹훅(비밀 토큰 헤더로 확인)
// 설정은 BOT_CONFIG(JSON), 비밀 값(비밀번호·API 키·봇 토큰)은 secret 바인딩으로만 받는다. 대화 기록은 KV 에 둔다.
import { stripThinking, chunk, buildSystem, pickAgent } from './agentlogic.mjs';

const HISTORY_MAX = 20;
const TTL = 60 * 60 * 24 * 30;
const enc = new TextEncoder();

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// 길이가 다르거나 내용이 달라도 걸리는 시간이 같도록 해시끼리 비교한다.
async function same(a, b) {
  const key = await crypto.subtle.importKey('raw', enc.encode('lapis'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const [x, y] = await Promise.all([crypto.subtle.sign('HMAC', key, enc.encode(String(a))), crypto.subtle.sign('HMAC', key, enc.encode(String(b)))]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

async function llm(env, engine, system, messages) {
  if (engine.type === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify({ model: engine.model, messages: [{ role: 'system', content: system }, ...messages] }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('GPT 오류: ' + (j.error?.message || r.status));
    return String(j.choices?.[0]?.message?.content || '');
  }
  if (engine.type === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: engine.model, max_tokens: 4096, system, messages }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Claude 오류: ' + (j.error?.message || r.status));
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (engine.type === 'workersai') {
    const r = await env.AI.run(engine.model, { messages: [{ role: 'system', content: system }, ...messages] });
    return String(r?.response ?? r?.result?.response ?? '');
  }
  throw new Error('이 엔진은 웹에서 쓸 수 없어요: ' + engine.type);
}

// 한 번의 대화: 역할 고르기 → 지침 만들기 → 기록과 함께 엔진 호출 → 기록 저장
async function answer(env, cfg, { session, text, agent: forced, room, topic }) {
  const picked = forced ? { agent: cfg.agents.find((a) => a.key === forced) || null, text } : pickAgent(cfg, { room, topic, text });
  const engine = picked.agent?.engine?.type ? picked.agent.engine : cfg.engine;
  const system = buildSystem(cfg, { agent: picked.agent, room, topic, skillText: picked.agent?.skillText || '' });
  const history = (await env.KV.get('h:' + session, 'json')) || [];
  const messages = [...history, { role: 'user', content: picked.text }];
  const out = stripThinking(await llm(env, engine, system, messages));
  if (!out) throw new Error('빈 답이 왔어요.');
  await env.KV.put('h:' + session, JSON.stringify([...messages, { role: 'assistant', content: out }].slice(-HISTORY_MAX)), { expirationTtl: TTL });
  return { text: out, agent: picked.agent?.key || '' };
}

// ── 텔레그램 ──
async function tgCall(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

async function handleTelegram(env, cfg, update) {
  const msg = update.message;
  if (!msg || !msg.chat || msg.from?.is_bot) return;
  const tg = cfg.telegram || {};
  const priv = msg.chat.type === 'private';
  const senderId = String(msg.from?.id ?? '');
  const thread = msg.is_topic_message ? msg.message_thread_id : 0;
  const send = async (text) => {
    for (const part of chunk(text)) {
      await tgCall(env, 'sendMessage', { chat_id: msg.chat.id, text: part, ...(thread ? { message_thread_id: thread } : {}), ...(!priv ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}) });
    }
  };
  const allowed = (tg.allowFrom || []).includes(senderId) || String(env.TELEGRAM_ALLOW || '').split(',').map((s) => s.trim()).includes(senderId);
  if (!allowed) {
    if (priv) await send('이 봇은 비공개예요. 쓰고 싶다면 관리자에게 이 번호를 알려 주세요: ' + senderId);
    return;
  }
  let text = String(msg.text ?? msg.caption ?? '');
  const room = priv ? null : ((tg.rooms || {})[String(msg.chat.id)] || { mode: 'mention', connected: true, agent: '', topics: {} });
  if (room) {
    if (room.connected === false) return;
    const me = '@' + String(tg.username || '').toLowerCase();
    const mentioned = tg.username && text.toLowerCase().includes(me);
    const command = /^\/\w+(@\w+)?(\s|$)/.test(text);
    const toBot = msg.reply_to_message?.from?.username && String(tg.username || '').toLowerCase() === msg.reply_to_message.from.username.toLowerCase();
    if (!(room.mode === 'all' || mentioned || toBot || command)) return;
    if (tg.username) text = text.replace(new RegExp('@' + tg.username, 'ig'), '').trim();
  }
  if (!text) { if (priv) await send('지금은 글로 보낸 메시지만 읽을 수 있어요.'); return; }
  const topic = thread && room ? (room.topics || {})[String(thread)] : null;
  const session = `tg:${msg.chat.id}:${thread}`;
  const agentKey = `a:${msg.chat.id}:${thread}`;
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (cmd) {
    const name = cmd[1].toLowerCase(), arg = (cmd[2] || '').trim();
    const HELP = '쓰는 법\n- 그냥 말을 걸면 답해요.\n- /agents 역할 목록, /agent 키 역할 바꾸기\n- /reset 이 대화 기억 지우기\n- /whoami 이 방·주제 번호 보기';
    if (name === 'start') return send(`안녕하세요, ${cfg.honorific || '사용자님'}! ${cfg.name}입니다.\n\n${HELP}`);
    if (name === 'help') return send(HELP);
    if (name === 'whoami') return send(`방 번호: ${msg.chat.id}\n주제 번호: ${thread || '(없음)'}\n보낸 사람 번호: ${senderId}`);
    if (name === 'reset') { await env.KV.delete('h:' + session); return send('이 대화의 기억을 지웠어요.'); }
    if (name === 'agents') return send(cfg.agents.length ? cfg.agents.map((a) => `${a.emoji} ${a.name} — /agent ${a.key}${a.role ? '\n   ' + a.role : ''}`).join('\n') : '역할이 없어요.');
    if (name === 'agent') {
      const a = cfg.agents.find((x) => x.key === arg.toLowerCase() || x.name === arg);
      if (!a) return send('그런 역할이 없어요. /agents 로 목록을 확인해 주세요.');
      await env.KV.put(agentKey, a.key, { expirationTtl: TTL });
      return send(`이제 ${a.emoji} ${a.name} 역할로 답해요.`);
    }
  }
  await tgCall(env, 'sendChatAction', { chat_id: msg.chat.id, action: 'typing', ...(thread ? { message_thread_id: thread } : {}) });
  try {
    const forced = await env.KV.get(agentKey);
    const r = await answer(env, cfg, { session, text, agent: forced || '', room, topic });
    await send(r.text);
  } catch (e) {
    await send('⚠️ 답을 만들지 못했어요: ' + String(e.message).slice(0, 300));
  }
}

const PAGE = (name, agents) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name.replace(/[<>&"]/g, '')}</title>
<style>:root{--bg:#f1f8fe;--panel:#fff;--line:#dbe9f4;--text:#13293d;--muted:#587388;--accent:#1b8ad0;--on:#fff}@media(prefers-color-scheme:dark){:root{--bg:#000;--panel:#0d0d0e;--line:#29292b;--text:#ececee;--muted:#a1a1a8;--accent:#e3e3e6;--on:#0a0a0a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,'Malgun Gothic',sans-serif;height:100dvh;display:flex;flex-direction:column}
header{display:flex;gap:10px;align-items:center;padding:12px 16px;background:var(--panel);border-bottom:1px solid var(--line)}header b{flex:1;font-size:16px}
select,input,textarea,button{font:inherit;color:inherit;border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:8px 12px}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}.m{max-width:min(720px,88%);padding:10px 14px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.me{align-self:flex-end;background:var(--accent);color:var(--on);border-bottom-right-radius:4px}.bot{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}
form{display:flex;gap:8px;padding:12px 16px;background:var(--panel);border-top:1px solid var(--line)}form textarea{flex:1;resize:none;height:44px}button.go{background:var(--accent);color:var(--on);border-color:var(--accent);font-weight:700}
#gate{margin:auto;padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:16px;display:flex;flex-direction:column;gap:12px;width:min(360px,90%)}</style></head><body>
<header><b>${name.replace(/[<>&"]/g, '')}</b><select id="agent" aria-label="역할"><option value="">자동</option>${agents.map((a) => `<option value="${a.key}">${a.emoji} ${a.name.replace(/[<>&"]/g, '')}</option>`).join('')}</select><button id="reset" type="button">새 대화</button></header>
<div id="gate"><b>비밀번호를 입력하세요</b><input id="pw" type="password" autocomplete="current-password"><button class="go" id="enter" type="button">들어가기</button><span id="err" style="color:#b42323"></span></div>
<div id="log" hidden></div><form id="f" hidden><textarea id="t" placeholder="메시지를 입력하세요" rows="1"></textarea><button class="go">보내기</button></form>
<script>
var $=function(i){return document.getElementById(i)},pw=localStorage.getItem('lapis.pw')||'',sid=localStorage.getItem('lapis.sid')||(function(){var s=Math.random().toString(36).slice(2);localStorage.setItem('lapis.sid',s);return s})();
function add(c,t){var d=document.createElement('div');d.className='m '+c;d.textContent=t;$('log').appendChild(d);$('log').scrollTop=1e9;return d}
function open(){$('gate').hidden=true;$('log').hidden=false;$('f').hidden=false;$('t').focus()}
function call(msg){return fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+pw},body:JSON.stringify(msg)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j}})})}
$('enter').onclick=function(){pw=$('pw').value;call({ping:true}).then(function(r){if(r.ok){localStorage.setItem('lapis.pw',pw);open()}else{$('err').textContent=r.status===401?'비밀번호가 맞지 않아요.':'연결하지 못했어요.'}})};
$('pw').onkeydown=function(e){if(e.key==='Enter')$('enter').onclick()};
$('f').onsubmit=function(e){e.preventDefault();var t=$('t').value.trim();if(!t)return;$('t').value='';add('me',t);var w=add('bot','생각하는 중…');call({session:'web:'+sid,message:t,agent:$('agent').value}).then(function(r){w.textContent=r.ok?r.j.text:'⚠️ '+(r.j.error||'오류')})};
$('t').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('f').requestSubmit()}};
$('reset').onclick=function(){sid=Math.random().toString(36).slice(2);localStorage.setItem('lapis.sid',sid);$('log').innerHTML=''};
if(pw)call({ping:true}).then(function(r){if(r.ok)open()});
</script></body></html>`;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    let cfg;
    try { cfg = JSON.parse(env.BOT_CONFIG); } catch { return json({ error: '설정을 읽지 못했어요.' }, 500); }
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(PAGE(cfg.name, cfg.agents), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } });
    }
    if (req.method === 'GET' && url.pathname === '/api/info') return json({ app: 'lapis-bot', name: cfg.name });
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!env.ACCESS_PASSWORD || !(await same(given, env.ACCESS_PASSWORD))) return json({ error: '비밀번호가 맞지 않아요.' }, 401);
      const body = await req.json().catch(() => ({}));
      if (body.ping) return json({ ok: true });
      const text = String(body.message || '').trim().slice(0, 4000);
      if (!text) return json({ error: '메시지를 적어 주세요.' }, 400);
      try {
        const r = await answer(env, cfg, { session: 'web:' + String(body.session || 'default').slice(0, 40), text, agent: String(body.agent || '') });
        return json(r);
      } catch (e) { return json({ error: String(e.message).slice(0, 300) }, 502); }
    }
    if (req.method === 'POST' && env.WEBHOOK_PATH && url.pathname === '/telegram/' + env.WEBHOOK_PATH) {
      if (!(await same(req.headers.get('x-telegram-bot-api-secret-token') || '', env.WEBHOOK_SECRET || ''))) return json({ error: 'forbidden' }, 403);
      const update = await req.json().catch(() => null);
      if (update) ctx.waitUntil(handleTelegram(env, cfg, update).catch(() => {}));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  },
};
