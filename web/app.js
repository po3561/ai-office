// AI-Office 대시보드 화면. 빌드 도구 없이 그대로 실행되는 순수 JavaScript 입니다.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const hhmm = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const dshort = (s) => { const d = new Date(s); return isNaN(d) ? esc(s) : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }); };
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}

// ── 통신 ──
async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ai-office': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error || `오류 ${res.status}`); e.status = res.status; e.details = j.details; throw e; }
  return j;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 5200 : 3200);
}

// 버튼을 잠근 채 동작을 실행하고, 실패하면 알려 준다.
async function doing(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); return null; } finally { if (btn) btn.disabled = false; }
}

// ── 상태 ──
const S = {
  ov: null, detail: null, details: {}, presets: null, found: null, ok: false,
  view: (location.hash || '#home').slice(1), officeId: localStorage.getItem('office') || '', restartNeeded: {},
  themePref: localStorage.getItem('theme') || 'auto', last: '',
  market: null, marketTab: localStorage.getItem('marketTab') || 'browse', marketQuery: '', marketDirty: true, marketAt: 0,
};
const VIEWS = {
  home: { title: '홈', icon: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>' },
  board: { title: '현황판', icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  teams: { title: '부서 관리', icon: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.4c1.9.8 3 2.6 3 5.6"/>' },
  skills: { title: '봇 · 스킬트리', icon: '<circle cx="12" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M12 7.5V12M12 12l-5 5M12 12l5 5"/>' },
  market: { title: '스킬 마켓', icon: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a2.67 2.67 0 0 1-5.33 0 2.67 2.67 0 0 1-5.34 0A2.67 2.67 0 0 1 4 11z"/><path d="M5 13.5V20h14v-6.5M10 20v-4h4v4"/>' },
  connect: { title: '연결 · 계정', icon: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>' },
  settings: { title: '설정', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>' },
};
const offices = () => (S.ov ? S.ov.offices : []);
const cur = () => offices().find((o) => o.id === S.officeId) || null;
const teamName = (d, key) => (key === 'chief' ? '비서실장' : ((d && d.teams.find((t) => t.key === key)) || {}).name || key);

// ── 테마 ──
function applyTheme() {
  const r = document.documentElement;
  if (S.themePref === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.themePref);
  $('#themeBtn').textContent = { auto: '◐', light: '☀', dark: '☾' }[S.themePref];
}

// ── 가져오기 ──
async function tick() {
  try {
    const ov = await api('GET', '/api/overview');
    S.ov = ov; S.ok = true;
    if (!ov.offices.some((o) => o.id === S.officeId)) S.officeId = ov.offices[0] ? ov.offices[0].id : '';
    const targets = S.view === 'skills' ? ov.offices.map((o) => o.id) : (S.officeId ? [S.officeId] : []);
    const results = await Promise.all(targets.map((id) => api('GET', `/api/offices/${encodeURIComponent(id)}`).catch(() => null)));
    S.details = {};
    targets.forEach((id, i) => { if (results[i]) S.details[id] = results[i]; });
    S.detail = S.details[S.officeId] || null;
    // 스킬 마켓: git 을 부르는 일이라 마켓 화면에서는 20초에 한 번(또는 동작 직후), 다른 화면에서는 2분에 한 번(메뉴의 업데이트·요청 숫자용)만 읽는다.
    // 네트워크 접속은 하지 않고 복제본만 읽는다(원격 새로고침은 서버가 10분마다 한다).
    if ((S.view === 'market' && (S.marketDirty || Date.now() - S.marketAt > 20000)) || Date.now() - S.marketAt > 120000) {
      S.marketDirty = false; S.marketAt = Date.now();
      const status = await api('GET', '/api/market/status').catch(() => null);
      let skills = null, share = null;
      let installed = null;
      if (status && status.enabled && status.ready) [skills, share, installed] = await Promise.all([api('GET', '/api/market/skills').catch(() => null), api('GET', '/api/market/shareable').catch(() => null), api('GET', '/api/market/installed').catch(() => null)]);
      S.market = { status, skills, share, installed };
    }
  } catch { S.ok = false; }
  paint();
}

function paint(force = false) {
  const sig = JSON.stringify([S.ov, S.details, S.view, S.officeId, S.ok, S.restartNeeded, S.market, S.marketTab]);
  if (!force && sig === S.last) { renderClock(); return; }
  const a = document.activeElement;
  const typing = a && $('#content').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox';
  S.last = sig;
  renderChrome();
  if (!typing || force) renderContent();
}
function renderClock() { if (S.view === 'board') document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = `${ago(el.dataset.since)}째 진행 중`; }); }

// ── 공통 조각 ──
const ic = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${VIEWS[k].icon}</svg>`;
const pill = (cls, t) => `<span class="pill ${cls}">${t}</span>`;
const runPill = (o) => (o.readonly
  ? (o.running ? pill('ok', '<i class="dot on"></i>가동 중') : pill('', '꺼짐'))
  : (o.running ? pill('ok', '<i class="dot on pulse"></i>근무 중') : pill('', '퇴근 상태')));
const kindPill = (o) => (o.kind === 'hermes' ? (o.readonly ? pill('warn', 'Hermes · 읽기 전용') : pill('accent', 'Hermes · 사무실용')) : pill('accent', o.managed ? 'Claude 사무실' : 'Claude 사무실 · 불러옴'));
// 부서·텔레그램·드라이브처럼 Claude 사무실에만 있는 기능을 쓸 수 있는 봇(Hermes 는 사무실용이어도 켜고 끄기만 이 프로그램이 맡는다)
const claudeOnly = (o) => o.kind !== 'hermes' && !o.readonly;
const hermesNote = (o, what) => (o.readonly
  ? `<div class="empty"><div class="big">🔒</div><b>읽기 전용 봇입니다</b><p>별개의 봇이라 ${what}을(를) 바꾸지 않습니다.</p></div>`
  : `<div class="empty"><div class="big">🤖</div><b>Hermes 봇에는 ${what}이(가) 없어요</b><p>Hermes 는 자체 설정으로 관리해요. 이 프로그램은 「설정」에서 켜고 끄기와 항상 켜두기만 도와요.</p></div>`);

function renderChrome() {
  const o = cur();
  const needs = { connect: S.ov && (!S.ov.claude.installed || !S.ov.claude.auth.loggedIn || S.ov.diag.rogue || S.ov.diag.globalPlugin) };
  $('#title').textContent = (VIEWS[S.view] || VIEWS.home).title;
  $('#nav').innerHTML = Object.keys(VIEWS).map((k) => {
    const extra = k === 'teams' && o && claudeOnly(o) ? `<span class="count">${o.teamsCount}</span>`
      : k === 'skills' ? `<span class="count">${offices().length}</span>`
      : k === 'market' ? (marketUpdates() + marketRequests() ? `<span class="count" title="업데이트 있는 스킬 · 봇의 게시 요청">${marketUpdates() + marketRequests()}</span>` : '')
      : needs[k] ? '<i class="flag"></i>' : '';
    return `<button class="nav-item${S.view === k ? ' on' : ''}" data-go="${k}">${ic(k)}<span>${VIEWS[k].title}</span>${extra}</button>`;
  }).join('');
  const sel = $('#officeSel');
  sel.innerHTML = offices().length
    ? offices().map((x) => `<option value="${esc(x.id)}"${x.id === S.officeId ? ' selected' : ''}>${esc(x.name)}${x.readonly ? ' (읽기 전용)' : ''}</option>`).join('')
    : '<option value="">사무실 없음</option>';
  const c = S.ov && S.ov.claude;
  $('#acct').innerHTML = c ? `<div class="acct" data-go="connect" title="연결 · 계정">
      <div class="avatar">${c.installed && c.auth.loggedIn ? esc((c.auth.email || 'C')[0].toUpperCase()) : '!'}</div>
      <div class="acct-t"><b>${c.installed ? (c.auth.loggedIn ? esc(c.auth.email || 'Claude 로그인됨') : 'Claude 로그인 필요') : 'Claude Code 설치 필요'}</b>
      <span>${c.installed && c.auth.loggedIn ? esc(planLabel(c.auth)) : '눌러서 연결하기'}</span></div></div>` : '';
  const conn = $('#conn');
  conn.className = `conn${S.ok ? ' on' : ''}`;
  conn.innerHTML = `<i class="dot${S.ok ? ' on pulse' : ''}"></i><span>${S.ok ? '실시간 연결됨' : '연결 끊김 · 다시 연결 중'}</span>`;
  renderBanners(o);
}

const planLabel = (a) => ({ pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise', free: 'Claude Free' }[a.plan] || a.plan || (a.method === 'claude.ai' ? 'Claude 구독' : a.method) || 'Claude');

function renderBanners(o) {
  const b = [];
  const ov = S.ov;
  if (ov) {
    if (!ov.claude.installed) {
      const br = ov.claude.broken;
      b.push(`<div class="banner bad"><span class="ic">⛔</span><div class="txt"><b>${br ? 'Claude Code가 있지만 실행되지 않습니다' : 'Claude Code가 설치되어 있지 않습니다'}</b><span class="muted">${br ? `${esc(clip(br.error, 140))} — 다시 설치하면 해결되는 경우가 많습니다.` : '사무실을 움직이려면 Claude Code가 필요합니다.'}</span></div><button class="btn sm primary" data-act="claude-install">${br ? '다시 설치' : '설치하기'}</button></div>`);
    }
    else if (!ov.claude.auth.loggedIn) b.push(`<div class="banner warn"><span class="ic">🔑</span><div class="txt"><b>Claude에 로그인해 주세요</b><span class="muted">본인의 Claude 계정으로 로그인하면 사무실이 그 계정의 사용량으로 일합니다.</span></div><button class="btn sm primary" data-act="claude-login">로그인</button></div>`);
    const u = ov.update;
    if (u && u.available && u.latest) {
      b.push(`<div class="banner info"><span class="ic">⬆️</span><div class="txt"><b>새 버전 v${esc(u.latest.version)} 이(가) 나왔습니다</b><span class="muted">지금은 v${esc(u.current)} 입니다. ${u.canApply ? '업데이트해도 사무실(봇)은 계속 근무하고, 대시보드만 잠시 다시 시작합니다.' : esc(u.why)}</span></div>${u.canApply ? '<button class="btn sm primary" data-act="update-apply">지금 업데이트</button>' : ''}${u.latest.page ? `<a class="btn sm" href="${esc(u.latest.page)}" target="_blank" rel="noopener">변경 내용</a>` : ''}</div>`);
    }
    if (ov.diag.rogue) b.push(`<div class="banner bad"><span class="ic">📡</span><div class="txt"><b>텔레그램 메시지를 가로채는 프로세스가 ${ov.diag.rogue}개 있습니다</b><span class="muted">일반 Claude 창이 봇의 수신권을 빼앗으면 지시가 사무실에 도착하지 않습니다.</span></div><button class="btn sm primary" data-act="diag-clean">정리하기</button></div>`);
    if (ov.diag.globalPlugin) b.push(`<div class="banner warn"><span class="ic">⚠️</span><div class="txt"><b>텔레그램 플러그인이 모든 Claude 창에서 켜져 있습니다</b><span class="muted">새 Claude 창을 열 때마다 봇 수신권을 가로챕니다. 사무실 폴더에서는 따로 켜지므로 전역 설정은 꺼도 됩니다.</span></div><button class="btn sm" data-act="diag-global-off">전역에서 끄기</button></div>`);
  }
  if (o && claudeOnly(o) && !o.exists && !(o.moveCandidates || []).length) b.push(`<div class="banner bad"><span class="ic">📂</span><div class="txt"><b>사무실 폴더를 찾을 수 없습니다</b><span class="muted">${esc(o.folder)} — 폴더를 옮기셨다면 새 위치를 알려 주세요.</span></div><button class="btn sm primary" data-act="office-relocate">위치 바꾸기</button></div>`);
  if (o && claudeOnly(o) && !o.exists) for (const c of (o.moveCandidates || []).slice(0, 2)) b.push(`<div class="banner info"><span class="ic">🔀</span><div class="txt"><b>같은 이름의 사무실이 다른 위치에서 발견됐습니다</b><span class="muted">${esc(c)} — 드라이브를 바꾸셨다면 이 위치로 바꿔 주세요. 폴더 안 파일은 건드리지 않습니다.</span></div><button class="btn sm primary" data-act="office-relocate-to" data-folder="${esc(c)}">이 위치로 바꾸기</button></div>`);
  if (o && S.restartNeeded[o.id] && o.running) b.push(`<div class="banner info"><span class="ic">🔄</span><div class="txt"><b>부서·스킬·드라이브 변경을 적용하려면 다시 출근해야 합니다</b><span class="muted">잠시 꺼졌다가 자동으로 다시 켜집니다. 진행 중인 업무가 없을 때 눌러 주세요.</span></div><button class="btn sm primary" data-act="office-restart">지금 다시 출근</button></div>`);
  $('#banners').innerHTML = b.join('');
}

function renderContent() {
  const el = $('#content');
  if (!S.ov) { el.innerHTML = '<div class="empty"><div class="big">⏳</div><b>불러오는 중…</b></div>'; return; }
  const fn = { home: vHome, board: vBoard, teams: vTeams, skills: vSkills, market: vMarket, connect: vConnect, settings: vSettings }[S.view] || vHome;
  el.innerHTML = fn();
}

// ── 홈 ──
function noOffice() {
  const found = S.found || [];
  return `<div class="card"><div class="empty"><div class="big">🏢</div><b>아직 사무실이 없습니다</b>
    <p>사무실은 텔레그램 봇 하나와 부서(에이전트)들이 함께 일하는 분리된 작업 공간입니다.</p>
    <div class="row" style="justify-content:center;margin-top:16px"><button class="btn primary" data-act="new-office">첫 사무실 만들기</button><button class="btn" data-act="import-office">기존 폴더 불러오기</button></div></div></div>
    ${found.length ? foundCard(found) : ''}`;
}
function foundCard(found) {
  return `<div class="card"><div class="card-head"><div><h2>이 PC에서 발견한 사무실·봇</h2><p class="sub">이미 쓰던 환경을 그대로 불러올 수 있습니다. 파일은 옮기거나 지우지 않습니다.</p></div></div>
    <div class="stack">${found.map((f, i) => `<div class="row"><div><b>${esc(f.name)}</b> ${f.kind === 'hermes' ? pill('warn', 'Hermes · 읽기 전용') : pill('accent', 'Claude 사무실')}<div class="path">${esc(f.folder)}</div><div class="small muted">${esc(f.reason)}</div></div><span class="spacer"></span><button class="btn sm primary" data-act="import-found" data-i="${i}">불러오기</button></div>`).join('<hr class="sep" style="margin:6px 0">')}</div></div>`;
}

function vHome() {
  const o = cur(), d = S.detail;
  if (!o) return noOffice();
  const c = S.ov.claude;
  const list = offices();
  let html = '';
  if (o.readonly) {
    html += `<div class="card"><h2>${esc(o.name)}</h2><p class="sub">별개의 봇입니다. 이 대시보드는 인식해서 보여 주기만 하고, 켜거나 끄거나 바꾸지 않습니다. 「봇 · 스킬트리」에서 스킬을 볼 수 있습니다. 켜고 끄는 것까지 맡기려면 「설정」에서 <b>사무실용</b>으로 바꾸세요.</p></div>`;
  } else if (o.kind === 'hermes') {
    html += `<div class="card"><div class="card-head"><div><h2>${esc(o.name)}</h2><p class="sub">사무실용으로 쓰는 Hermes 봇입니다. 켜고 끄기·항상 켜두기는 「설정」에서, 대화와 텔레그램 연결은 Hermes 자체 설정에서 합니다.</p></div>${runPill(o)}</div>
      <div class="row">${o.running ? '<button class="btn danger" data-act="office-stop">퇴근시키기</button>' : '<button class="btn primary" data-act="office-start">출근시키기</button>'}<button class="btn" data-go="settings">설정 열기</button></div></div>`;
  } else if (d) {
    const tg = d.telegram || {};
    const paired = tg.access && tg.access.allowFrom.length > 0;
    const steps = [
      { done: c.installed && c.auth.loggedIn, t: 'Claude 계정 연결', s: c.installed ? (c.auth.loggedIn ? `${c.auth.email || ''} · ${planLabel(c.auth)}` : '본인 Claude 계정으로 로그인합니다.') : 'Claude Code를 먼저 설치합니다.', go: 'connect', b: c.installed && c.auth.loggedIn ? '' : (c.installed ? '로그인' : '설치·로그인') },
      { done: tg.set && !(tg.bot && tg.bot.error), t: '텔레그램 봇 연결', s: tg.set ? (tg.bot && tg.bot.username ? `@${tg.bot.username}` : (tg.bot && tg.bot.error) || '연결됨') : 'BotFather에서 만든 봇 토큰을 넣습니다.', go: 'connect', b: tg.set ? '' : '연결하기' },
      { done: paired, t: '내 텔레그램 계정 허용', s: paired ? `${tg.access.allowFrom.length}명 허용됨` : '봇에게 메시지를 보내고, 받은 코드를 입력합니다.', go: 'connect', b: paired ? '' : '코드 입력' },
      { done: o.running, t: '사무실 출근', s: o.running ? '근무 중 — 텔레그램으로 지시하세요.' : '출근시키면 봇이 지시를 받기 시작합니다.', act: 'office-start', b: o.running ? '' : '출근시키기' },
    ];
    const firstOpen = steps.findIndex((x) => !x.done);
    const allDone = firstOpen < 0;
    html += `<div class="card"><div class="card-head"><div><h2>${allDone ? `${esc(o.name)} 준비 완료 🎉` : '시작하기'}</h2>
      <p class="sub">${allDone ? '텔레그램에서 봇에게 업무를 지시해 보세요. 현황판에서 진행 상황이 실시간으로 보입니다.' : `${steps.filter((x) => x.done).length}/4 단계 완료 — 순서대로 진행해 주세요.`}</p></div>
      ${runPill(o)}</div><div class="steps">${steps.map((x, i) => `<div class="step${x.done ? ' done' : ''}${i === firstOpen ? ' now' : ''}"><div class="n">${x.done ? '✓' : i + 1}</div><div><b>${x.t}</b><span class="sub">${esc(x.s)}</span></div>${x.b ? `<button class="btn sm ${i === firstOpen ? 'primary' : ''}" ${x.act ? `data-act="${x.act}"` : `data-go="${x.go}"`}>${x.b}</button>` : '<span></span>'}</div>`).join('')}</div></div>`;
    html += `<div class="stats" style="margin-top:16px"><div class="stat"><b>${o.teamsCount}</b><span>부서</span></div><div class="stat"><b>${o.workingTeams}</b><span>지금 일하는 부서</span></div><div class="stat"><b>${o.doneToday}</b><span>오늘 끝낸 일</span></div><div class="stat"><b>${o.skillsCount}</b><span>스킬</span></div></div>`;
  }
  html += `<div class="card"><div class="card-head"><div><h2>내 사무실 · 봇</h2><p class="sub">봇마다 분리된 환경에서 일합니다. 선택하면 그 사무실을 관리합니다.</p></div><div class="row"><button class="btn sm" data-act="import-office">불러오기</button><button class="btn sm primary" data-act="new-office">사무실 추가</button></div></div>
    <div class="grid cols-2">${list.map(officeCard).join('')}</div></div>`;
  const found = (S.found || []);
  if (found.length) html += foundCard(found);
  return html;
}

function officeCard(o) {
  return `<div class="card office-card${o.id === S.officeId ? ' selected-mark' : ''}" style="margin:0">
    <div class="top-row"><div><h3>${esc(o.name)}</h3><div class="badges">${kindPill(o)}${runPill(o)}</div></div>
      ${o.id === S.officeId ? pill('accent', '선택됨') : `<button class="btn sm" data-act="select-office" data-id="${esc(o.id)}">선택</button>`}</div>
    <div class="kv">${claudeOnly(o) ? `<span class="pill">부서 <b>${o.teamsCount}</b></span>` : ''}<span class="pill">스킬 <b>${o.skillsCount}</b></span>${claudeOnly(o) ? `<span class="pill">오늘 <b>${o.doneToday}</b>건</span>` : ''}</div>
    <div class="path">📂 ${esc(o.folder)}</div><div class="small muted">${esc(o.detail || '')}</div></div>`;
}

// ── 현황판 ──
function vBoard() {
  const o = cur(), d = S.detail;
  if (!o) return noOffice();
  if (o.readonly) return `<div class="card"><div class="empty"><div class="big">👀</div><b>${esc(o.name)}은(는) 별개의 봇입니다</b><p>이 봇은 자기 환경에서 따로 일합니다. 여기서는 인식만 하고 현황을 바꾸지 않습니다.</p></div></div>`;
  if (o.kind === 'hermes') return `<div class="card">${hermesNote(o, '현황판')}</div>`;
  if (!d) return '<div class="empty"><div class="big">⏳</div><b>불러오는 중…</b></div>';
  const ch = d.chief || {};
  const working = ch.state === 'working';
  const teams = d.teams.map((t) => {
    const recent = t.lastDoneAt && Date.now() - new Date(t.lastDoneAt) < 10 * 60 * 1000;
    const cls = t.state === 'working' ? 'working' : recent ? 'justdone' : '';
    const label = t.state === 'working' ? pill('ok', '<i class="dot on pulse"></i>작업 중') : recent ? pill('accent', '방금 완료') : pill('', '대기');
    const task = t.state === 'working' ? t.task : (t.lastDone ? `최근: ${t.lastDone}` : '');
    const meta = t.state === 'working' ? `<span data-since="${esc(t.since)}">${ago(t.since)}째 진행 중</span>` : (t.lastDoneAt ? `${hhmm(t.lastDoneAt)} 완료 · 오늘 ${new Date(t.lastDoneAt).toDateString() === new Date().toDateString() ? (t.doneToday || 1) : 0}건` : '아직 기록 없음');
    return `<div class="team ${cls}"><div class="team-head"><div><div class="team-name"><span class="em">${esc(t.emoji)}</span>${esc(t.name)}</div><p class="role">${esc(clip(t.role, 60))}</p></div>${label}</div>
      <div class="task">${esc(task) || '<span class="muted">대기 중</span>'}</div><div class="meta">${meta}</div></div>`;
  }).join('');
  const feed = (d.events || []).slice(0, 16).map((e) => `<li><time>${hhmm(e.at)}</time><div><b>${esc(teamName(d, e.team))}</b> ${esc(e.text)}</div></li>`).join('');
  return `<div class="stats"><div class="stat"><b>${o.workingTeams}</b><span>작업 중인 부서</span></div><div class="stat"><b>${o.doneToday}</b><span>오늘 끝낸 일</span></div><div class="stat"><b>${o.updatedAt ? hhmm(o.updatedAt) : '-'}</b><span>마지막 변화</span></div><div class="stat"><b>${o.running ? '근무 중' : '퇴근'}</b><span>사무실 상태</span></div></div>
  <div class="split"><div class="card"><div class="org">
      <div class="node owner">👤 ${esc(d.honorific || '사용자')}</div><div class="vline"></div>
      <div class="node chief"><div class="team-head"><div class="team-name"><span class="em">🧑‍💼</span>비서실장</div>${working ? pill('ok', '<i class="dot on pulse"></i>업무 처리 중') : pill('', '대기')}</div>
        <div class="task" style="margin-top:8px;font-size:13.5px">${working && ch.task ? esc(ch.task) : '<span class="muted">텔레그램 지시를 받으면 부서에 배정합니다.</span>'}</div></div>
      <div class="vline"></div>${d.teams.length > 1 ? '<div class="hbar"></div>' : ''}</div>
      ${d.teams.length ? `<div class="teams">${teams}</div>` : `<div class="empty"><b>부서가 없습니다</b><button class="btn primary" data-go="teams">부서 추가하러 가기</button></div>`}</div>
    <div class="card"><h2>최근 활동</h2><ul class="feed" style="margin-top:10px">${feed || '<li class="empty" style="display:block">아직 활동이 없습니다.</li>'}</ul></div></div>`;
}

// ── 부서 관리 ──
function vTeams() {
  const o = cur(), d = S.detail;
  if (!o) return noOffice();
  if (!claudeOnly(o)) return `<div class="card">${hermesNote(o, '부서')}</div>`;
  if (!d) return '<div class="empty"><b>불러오는 중…</b></div>';
  return `<div class="card"><div class="card-head"><div><h2>${esc(o.name)}의 부서 ${d.teams.length}개</h2>
    <p class="sub">부서는 봇이 업무를 나눠 맡기는 전문 에이전트입니다. 여기서 늘리거나 줄여도, 일은 계속 텔레그램 봇을 통해 지시합니다. 텔레그램에서 "인사팀 추가해줘"라고 말해도 됩니다.</p></div>
    <button class="btn primary" data-act="team-add">＋ 부서 추가</button></div>
    ${d.importedTeams ? '<div class="banner info" style="margin-bottom:14px"><span class="ic">ℹ️</span><div class="txt">기존 사무실에서 불러온 부서입니다. 이름·업무를 고치거나 지우면 이 프로그램이 부서 목록을 관리하기 시작하고, CLAUDE.md의 조직도 표를 자동 갱신합니다(원본은 백업합니다).</div></div>' : ''}
    ${d.teams.length ? `<div class="grid cols-3">${d.teams.map((t) => `<div class="card team-admin" style="margin:0">
      <div class="team-head"><div class="team-name"><span class="em">${esc(t.emoji)}</span>${esc(t.name)}</div>${t.managed === false ? pill('', '기존') : ''}</div>
      <div class="desc">${esc(t.role)}</div><div class="path">${esc(t.key)}${t.fileExists ? '' : ' · 파일 없음'}</div>
      <div class="row" style="margin-top:6px"><button class="btn sm" data-act="team-edit" data-key="${esc(t.key)}">수정</button><button class="btn sm danger" data-act="team-remove" data-key="${esc(t.key)}">없애기</button></div></div>`).join('')}</div>`
      : '<div class="empty"><div class="big">👥</div><b>부서가 없습니다</b>추천 부서에서 골라 추가해 보세요.</div>'}</div>
    <div class="card"><h2>알아 두세요</h2><ol class="guide"><li>없앤 부서의 파일은 지우지 않고 사무실의 <code>보관함/부서보관</code> 폴더로 옮겨 둡니다.</li><li>새 부서·변경 사항은 사무실을 <b>다시 출근</b>시킨 뒤부터 적용됩니다.</li><li>모든 변경은 사무실의 <code>업무데이터/맞춤설정/변경이력.csv</code>에 기록됩니다.</li></ol></div>`;
}

// ── 봇 · 스킬트리 ──
function skillTree(skills, empty) {
  if (!skills.length) return `<p class="small muted">${empty}</p>`;
  const cats = new Map();
  for (const s of skills) { if (!cats.has(s.category)) cats.set(s.category, []); cats.get(s.category).push(s); }
  return `<ul class="tree">${[...cats].map(([c, list]) => `<li><span class="lv">📁 ${esc(c)}</span> <small style="display:inline">${list.length}</small><ul>${list.map((s) => `<li><div class="sk-name">🧩 <b>${esc(s.name)}</b>${s.createdBy === 'telegram' ? pill('accent', '📱 텔레그램 지시로 생성') : (s.createdBy ? pill('', esc(s.createdBy)) : '')}${s.market ? pill('accent', `🛒 마켓 v${esc(s.market.version)}`) : ''}<small style="display:inline">${dshort(s.created)}</small></div>${s.description ? `<small title="${esc(s.description)}">${esc(clip(s.description, 120))}</small>` : ''}${s.request ? `<small>요청: ${esc(clip(s.request, 90))}</small>` : ''}</li>`).join('')}</ul></li>`).join('')}</ul>`;
}
function vSkills() {
  const list = offices();
  if (!list.length) return noOffice();
  const total = list.reduce((n, o) => n + o.skillsCount, 0);
  const tgMade = Object.values(S.details).reduce((n, d) => n + (d.skills || []).filter((s) => s.createdBy === 'telegram').length, 0);
  const stats = `<div class="stats"><div class="stat"><b>${list.length}</b><span>등록된 봇(사무실)</span></div><div class="stat"><b>${list.filter((o) => o.running).length}</b><span>지금 가동 중</span></div><div class="stat"><b>${list.reduce((n, o) => n + o.teamsCount, 0)}</b><span>부서 합계</span></div><div class="stat"><b>${total}</b><span>스킬 합계</span></div><div class="stat"><b>${tgMade}</b><span>텔레그램으로 만든 스킬</span></div></div>`;
  const cards = list.map((o) => {
    const d = S.details[o.id];
    const teams = d && d.teams && d.teams.length ? `<li><span class="lv">👥 부서</span> <small style="display:inline">${d.teams.length}</small><ul>${d.teams.map((t) => `<li><div class="sk-name">${esc(t.emoji)} <b>${esc(t.name)}</b></div><small>${esc(clip(t.role, 90))}</small></li>`).join('')}</ul></li>` : '';
    const changes = d && d.changes && d.changes.length ? `<details class="dtl"><summary>최근 설정 변경 <small>${d.changes.length}건</small></summary><ul class="changes">${d.changes.slice(0, 8).map((c) => `<li><time>${esc(c.date)}</time><div><b>${esc(c.type)}</b> ${esc(c.name)} — ${esc(c.summary)}${c.request ? `<br><span class="muted">요청: ${esc(clip(c.request, 80))}</span>` : ''}</div></li>`).join('')}</ul></details>` : '';
    const emptyMsg = !claudeOnly(o) ? '등록된 스킬이 없습니다.' : '아직 만든 스킬이 없습니다. 텔레그램에서 "앞으로 ○○할 때는 이렇게 해"라고 하면 이 봇이 스스로 만들어 여기에 나타납니다.';
    return `<div class="card office-card" style="margin:0"><div class="top-row"><div><h3>${esc(o.name)}</h3><div class="badges">${kindPill(o)}${runPill(o)}</div></div>${o.id === S.officeId ? pill('accent', '선택됨') : `<button class="btn sm" data-act="select-office" data-id="${esc(o.id)}">선택</button>`}</div>
      <div class="path">📂 ${esc(o.folder)}</div>
      <details class="dtl" open><summary>스킬트리 <small>${!claudeOnly(o) ? '' : `부서 ${o.teamsCount} · `}스킬 ${o.skillsCount}</small></summary>
        <ul class="tree">${teams}<li><span class="lv">🧩 스킬</span> <small style="display:inline">${o.skillsCount}</small>${d ? skillTree(d.skills || [], emptyMsg) : '<small>불러오는 중…</small>'}</li></ul></details>${changes}</div>`;
  }).join('');
  return `${stats}<div class="grid cols-2" style="align-items:start">${cards}</div>
    <div class="card"><h2>읽기 전용과 사무실용</h2><p class="sub">Hermes(라피스 등) 같은 별개의 봇은 자기 환경에서 따로 일합니다. <b>읽기 전용</b>이면 이 프로그램은 봇의 폴더를 읽어 스킬을 보여 주기만 하고 켜거나 끄거나 파일을 바꾸지 않습니다. 「설정」에서 <b>사무실용</b>으로 바꾸면 켜고 끄기와 항상 켜두기까지 맡습니다.</p></div>`;
}

// ── 스킬 마켓 ──
// 여러 PC 가 같은 비공개 git 저장소를 통해 스킬을 골라서 주고받는다. 게시·설치는 항상 여기서 직접 누를 때만 동작한다.
const semverGt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const RISK_PILL = { safe: () => pill('ok', '위험 요소 없음'), caution: () => pill('warn', '확인 필요'), danger: () => pill('bad', '⚠️ 위험 표시') };
const LEVEL_ICON = { block: '⛔', warn: '⚠️', risk: '🚨' };
const marketUpdates = () => ((S.market && S.market.skills) || []).reduce((n, e) => n + e.installs.filter((i) => semverGt(e.version, i.version) && !e.revoked).length, 0);
const marketRequests = () => ((S.market && S.market.share) || []).reduce((n, o) => n + (o.requests || []).length, 0);
const markMarket = () => { S.marketDirty = true; return refresh(); };

// 차단 → 위험 → 확인 순으로 보여 주고, 맨 위에 개수를 요약한다(많을 때 차단 항목이 묻히지 않게).
const LEVEL_ORDER = { block: 0, risk: 1, warn: 2 };
function findingsHtml(list) {
  if (!list || !list.length) return '';
  const n = (lv) => list.filter((f) => f.level === lv).length;
  const sum = [['block', '⛔ 차단', 'bad'], ['risk', '🚨 위험', 'warn'], ['warn', '⚠️ 확인', '']].filter(([lv]) => n(lv)).map(([lv, t, c]) => pill(c, `${t} ${n(lv)}`)).join('');
  const block = n('block') ? '<p class="small" style="color:var(--bad);margin:6px 0">차단 항목을 고치기 전에는 게시·설치할 수 없습니다. (예: 시험용 가짜 값이라도 주민번호·카드번호 모양이면 막힙니다 — 값을 지우거나 <code>000000-0000000</code> 처럼 바꿔 주세요)</p>' : '';
  const sorted = [...list].sort((a, b) => (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3));
  return `<div class="badges" style="margin:4px 0">${sum}</div>${block}<ul class="find">${sorted.map((f) => `<li class="${esc(f.level)}"><span>${LEVEL_ICON[f.level] || '•'}</span><div>${esc(f.message)}${f.file ? ` <span class="path">${esc(f.file)}${f.line ? `:${f.line}` : ''}</span>` : ''}${f.sample ? ` <code>${esc(f.sample)}</code>` : ''}</div></li>`).join('')}</ul>`;
}
const ago2 = (iso) => { if (!iso) return '아직 없음'; const s = Math.floor((Date.now() - new Date(iso)) / 1000); return s < 60 ? '방금' : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`; };

function vMarket() {
  const m = S.market;
  if (!m || !m.status) return '<div class="empty"><div class="big">⏳</div><b>불러오는 중…</b></div>';
  const st = m.status;
  if (!st.git.available) return `<div class="card"><h2>git 이 필요합니다</h2><p class="sub">스킬 마켓은 git 저장소로 스킬을 주고받습니다. <b>git</b>(또는 GitHub Desktop)을 설치한 뒤 이 화면을 다시 열어 주세요.</p></div>`;
  if (!st.enabled || !st.ready) return mkConnect(st);
  const upd = marketUpdates();
  const req = marketRequests();
  const tabs = [['browse', '둘러보기'], ['share', `내 스킬 공유${req ? ` · 요청 ${req}` : ''}`], ['installed', `설치된 스킬${upd ? ` · 업데이트 ${upd}` : ''}`], ['settings', '연결 · 설정']];
  const head = `<div class="row" style="margin-bottom:12px"><div class="tabs" style="margin:0">${tabs.map(([k, l]) => `<button class="${S.marketTab === k ? 'on' : ''}" data-act="market-tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div><span class="spacer"></span><span class="small muted">마지막 새로고침 ${esc(ago2(st.lastSync))}</span><button class="btn sm" data-act="market-refresh">새로고침</button></div>`;
  const vis = st.visibility === 'public' ? '<div class="banner bad" style="margin-bottom:12px"><span class="ic">🌐</span><div class="txt"><b>연결한 저장소가 공개(public)입니다</b><span class="muted">누구나 게시한 스킬을 볼 수 있습니다. 비공개(private) 저장소로 바꾸는 것을 강력히 권합니다.</span></div></div>' : '';
  const err = st.lastError ? `<div class="banner warn" style="margin-bottom:12px"><span class="ic">⚠️</span><div class="txt"><b>마켓을 새로 불러오지 못했습니다</b><span class="muted">${esc(clip(st.lastError, 220))} — 인터넷 연결과 <code>gh auth status</code> 를 확인한 뒤 「새로고침」을 눌러 주세요. 지금 보이는 목록은 마지막으로 받은 내용입니다.</span></div></div>` : '';
  const body = { browse: mkBrowse, share: mkShare, installed: mkInstalled, settings: mkSettings }[S.marketTab] || mkBrowse;
  return head + vis + err + body(m);
}

function mkConnect(st) {
  return `<div class="card"><div class="card-head"><div><h2>스킬 마켓 연결</h2><p class="sub">한 PC에서 만든 스킬을 <b>내가 고른 것만</b> 올리면, 같은 저장소에 연결한 다른 PC(메인 PC 등)에서 보고 골라 설치할 수 있습니다.</p></div>${pill('', '연결 안 됨')}</div>
    <form data-form="market-connect" autocomplete="off"><div class="formgrid">
      <div class="field full"><label>마켓 저장소</label><input type="text" name="repo" required placeholder="내계정/ai-office-skills" value="${esc(st.repo)}" spellcheck="false"><span class="hint">GitHub의 <b>비공개(private)</b> 저장소를 추천합니다. 형식: <code>계정/저장소</code>, <code>https://…</code>, 또는 공유 폴더 경로</span></div>
      <div class="field"><label>이 PC의 별칭</label><input type="text" name="alias" required maxlength="20" placeholder="서브PC" value="${esc(st.alias)}"><span class="hint">스킬을 올린 곳을 표시할 이름입니다. (예: 메인PC, 서브PC)</span></div></div>
      <div class="row end" style="margin-top:14px"><button class="btn primary" type="submit">연결하기</button></div></form></div>
    <div class="card"><h2>안전하게 쓰는 방법</h2><ol class="guide">
      <li>이 프로그램은 <b>비밀번호·토큰을 받거나 저장하지 않습니다.</b> 이 PC에 이미 로그인된 <code>git</code>·<code>gh</code> 를 그대로 씁니다. 처음이면 터미널에서 <code>gh auth login</code> 을 한 번 해 주세요.</li>
      <li>스킬을 올릴 때는 개인정보·토큰이 들어 있는지 <b>자동으로 검사</b>하고, 걸리면 올라가지 않습니다.</li>
      <li>스킬을 받을 때는 내용을 <b>미리 보고</b> 직접 누른 것만 설치됩니다. 스크립트나 수상한 지시문이 있으면 경고하고 기본으로 막습니다.</li>
      <li>업무 데이터(회사정보 등), 부서 설정, 봇 토큰은 <b>공유 대상이 아닙니다.</b> 스킬 폴더만 공유합니다.</li>
      <li>게시·설치·회수는 이 화면에서만 가능하고, 텔레그램 메시지로는 할 수 없습니다.</li></ol></div>`;
}

function mkCard(e) {
  const text = `${e.name} ${e.id} ${e.description} ${e.category} ${(e.tags || []).join(' ')} ${e.publisher} ${e.sourceAlias}`.toLowerCase();
  const q = S.marketQuery.trim().toLowerCase();
  const inst = e.installs.map((i) => `${pill('accent', `설치됨 · ${esc(i.officeName)} v${esc(i.version)}`)}${i.modified ? pill('warn', '내가 고침') : ''}${semverGt(e.version, i.version) && !e.revoked ? pill('ok', '업데이트 있음') : ''}`).join('');
  return `<div class="card mk-card" data-text="${esc(text)}"${q && !text.includes(q) ? ' hidden' : ''}><div class="top-row"><div><h3>🧩 ${esc(e.name)} <small class="muted">v${esc(e.version)}</small></h3><div class="badges">${e.revoked ? pill('bad', '회수됨') : RISK_PILL[e.riskLevel]()}${e.category ? pill('', esc(e.category)) : ''}${inst}</div></div></div>
    ${e.description ? `<p class="desc">${esc(clip(e.description, 160))}</p>` : ''}${e.revoked && e.revokedReason ? `<p class="small" style="color:var(--bad)">회수 사유: ${esc(e.revokedReason)}</p>` : ''}
    <div class="small muted">게시: ${esc(e.publisher)}${e.sourceAlias ? ` (${esc(e.sourceAlias)})` : ''} · ${esc(dshort(e.publishedAt))} · 파일 ${e.fileCount}개</div>
    <div class="row" style="margin-top:10px"><button class="btn sm primary" data-act="market-detail" data-id="${esc(e.id)}">내용 보기 · 설치</button></div></div>`;
}

function mkBrowse(m) {
  const list = m.skills || [];
  const filter = `<div class="row" style="margin-bottom:12px"><input type="search" data-filter="market" placeholder="스킬 검색 (이름·설명·분류·게시자)" value="${esc(S.marketQuery)}" style="flex:1;min-width:220px"></div>`;
  if (!list.length) return `${filter}<div class="card"><div class="empty"><div class="big">🛒</div><b>아직 마켓에 올라온 스킬이 없습니다</b><p>「내 스킬 공유」에서 이 PC의 스킬을 골라 올려 보세요. 다른 PC에서도 여기에 나타납니다.</p></div></div>`;
  return `${filter}<div class="mk-grid">${list.map(mkCard).join('')}</div>`;
}

function mkShare(m) {
  const rows = { private: () => pill('', '비공개(이 PC 전용)'), published: () => pill('ok', '게시됨'), changed: () => pill('warn', '게시 후 바뀜'), 'from-market': () => pill('accent', '마켓에서 받음'), builtin: () => pill('', '기본 스킬'), conflict: () => pill('bad', '이름 충돌'), unsharable: () => pill('warn', '공유 불가'), revoked: () => pill('bad', '회수됨') };
  const share = m.share || [];
  if (!share.length) return '<div class="card"><p class="muted">공유할 수 있는 사무실이 없습니다.</p></div>';
  const reqs = share.flatMap((o) => (o.requests || []).map((r) => ({ ...r, o })));
  const inbox = reqs.length ? `<div class="card"><div class="card-head"><div><h2>📱 봇의 게시 요청 ${reqs.length}건</h2><p class="sub">텔레그램에서 "마켓에 올려줘"라고 한 스킬입니다. 봇은 직접 올리지 못하고 요청만 남깁니다. 검사 결과를 보고 직접 게시하거나 거절하세요.</p></div></div>
    <table class="tbl"><tbody>${reqs.map((r) => `<tr><td><b>${esc(r.skillId)}</b> <span class="small muted">${esc(r.o.officeName)} · ${esc(ago2(r.at))}</span>${r.note ? `<div class="small muted">${esc(clip(r.note, 160))}</div>` : ''}${r.known ? '' : `<div class="small" style="color:var(--warn)">이 이름의 스킬 폴더가 사무실에 없습니다.</div>`}</td>
      <td class="row end">${r.known ? `<button class="btn sm primary" data-act="market-publish" data-office="${esc(r.o.office)}" data-skill="${esc((r.o.skills.find((s) => s.id.toLowerCase() === r.skillId.toLowerCase()) || {}).id || r.skillId)}">검토 후 게시</button>` : ''}<button class="btn sm" data-act="market-req-dismiss" data-office="${esc(r.o.office)}" data-skill="${esc(r.skillId)}">거절</button></td></tr>`).join('')}</tbody></table></div>` : '';
  return inbox + `<div class="banner info" style="margin-bottom:12px"><span class="ic">🔒</span><div class="txt"><b>공유는 내가 고른 스킬만, 내가 누를 때만</b><span class="muted">모든 스킬의 기본값은 “이 PC 전용”입니다. 게시하기 전에 개인정보·토큰이 들어 있는지 자동으로 검사합니다.</span></div></div>` + share.map((o) => `<div class="card"><div class="card-head"><h2>${esc(o.officeName)}</h2>${o.skills.some((s) => s.status === 'private' || s.status === 'changed') ? `<button class="btn sm primary" data-act="market-publish-all" data-office="${esc(o.office)}">공유 가능한 스킬 모두 게시 (${o.skills.filter((s) => s.status === 'private' || s.status === 'changed').length})</button>` : ''}</div>
    ${o.skills.length ? `<table class="tbl"><thead><tr><th>스킬</th><th>상태</th><th></th></tr></thead><tbody>${o.skills.map((s) => `<tr><td><b>${esc(s.name)}</b>${s.name !== s.id ? ` <span class="small muted">${esc(s.id)}</span>` : ''}<div class="small muted">${esc(clip(s.description, 80))}</div></td>
      <td>${(rows[s.status] || rows.private)()}${s.requested ? ` ${pill('accent', '📱 게시 요청')}` : ''}${s.version ? ` <span class="small muted">v${esc(s.version)}</span>` : ''}${s.reason ? `<div class="small muted">${esc(s.reason)}</div>` : ''}</td>
      <td class="row end">${s.status === 'private' || s.status === 'changed' ? `<button class="btn sm primary" data-act="market-publish" data-office="${esc(o.office)}" data-skill="${esc(s.id)}">${s.status === 'changed' ? '새 버전 게시' : '마켓에 게시'}</button>` : ''}${s.status === 'published' || s.status === 'changed' ? `<button class="btn sm danger" data-act="market-revoke" data-id="${esc(s.marketId)}">회수</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">이 사무실에는 아직 스킬이 없습니다. 텔레그램에서 "앞으로 ○○할 때는 이렇게 해"라고 하면 봇이 만들어 여기에 나타납니다.</p>'}</div>`).join('');
}

function mkInstalled(m) {
  const market = new Map((m.skills || []).map((e) => [e.id, e]));
  const rows = [];
  for (const o of m.installed || m.share || []) for (const s of o.skills) if (s.status === 'from-market') rows.push({ office: o, s, e: market.get(s.marketId) });
  if (!rows.length) return '<div class="card"><div class="empty"><div class="big">📦</div><b>마켓에서 받은 스킬이 없습니다</b><p>「둘러보기」에서 스킬을 골라 설치해 보세요.</p></div></div>';
  return `<div class="card"><table class="tbl"><thead><tr><th>스킬</th><th>사무실</th><th>설치한 버전</th><th></th></tr></thead><tbody>${rows.map(({ office, s, e }) => {
    const inst = e && e.installs.find((i) => i.office === office.office);
    const newer = e && !e.revoked && semverGt(e.version, s.version);
    return `<tr><td><b>${esc(s.name)}</b><div class="small muted">${esc(clip(s.description, 70))}</div></td><td>${esc(office.officeName)}${office.external ? ` ${pill('', 'Hermes 봇')}` : ''}</td>
      <td>v${esc(s.version)}${inst && inst.modified ? ` ${pill('warn', '내가 고침')}` : ''}${newer ? ` ${pill('ok', `새 버전 v${esc(e.version)}`)}` : ''}${!e ? ` ${pill('warn', '마켓에 없음')}` : e.revoked ? ` ${pill('bad', '회수됨')}` : ''}</td>
      <td class="row end">${newer ? `<button class="btn sm primary" data-act="market-update" data-office="${esc(office.office)}" data-id="${esc(s.marketId)}">업데이트</button>` : ''}<button class="btn sm danger" data-act="market-uninstall" data-office="${esc(office.office)}" data-id="${esc(s.marketId)}">제거</button></td></tr>`;
  }).join('')}</tbody></table><p class="small muted" style="margin-top:10px">제거해도 파일은 지워지지 않고 사무실의 <code>보관함/스킬제거</code>(Hermes 봇은 이 프로그램의 <code>market/backup</code>) 폴더로 옮겨집니다. 설치·업데이트·제거는 사무실을 다시 출근시킨 뒤부터 적용됩니다.</p></div>`;
}

function mkSettings(m) {
  const st = m.status;
  const vis = { private: pill('ok', '비공개'), public: pill('bad', '공개 — 주의'), unknown: pill('', '확인 못 함') }[st.visibility] || '';
  return `<div class="card"><div class="card-head"><div><h2>연결 정보</h2><p class="sub">토큰은 저장하지 않습니다. 이 PC에 로그인된 git·gh 로 접속합니다.</p></div>${pill('ok', '연결됨')}</div>
    <div class="setting" style="border:0"><div><b>저장소</b><span class="sub path">${esc(st.repo)}</span></div>${vis}</div>
    <div class="setting"><div><b>이 PC의 별칭 · 게시자</b><span class="sub">${esc(st.alias)} · git 사용자 ${st.publisher ? `<b>${esc(st.publisher)}</b>` : '<span style="color:var(--bad)">설정 안 됨 (터미널에서 git config --global user.name "이름")</span>'}</span></div></div>
    <div class="setting"><div><b>도구</b><span class="sub">${esc(st.git.version)} · gh 로그인 ${st.gh ? '됨' : '안 됨(GitHub 저장소는 gh auth login 필요)'}</span></div></div>
    <div class="setting"><div><b>마켓 스킬 수</b><span class="sub">${st.entries}개 · 마지막 새로고침 ${esc(ago2(st.lastSync))} · 연결되어 있으면 10분마다 자동으로 새 목록을 받아 옵니다(설치는 직접).</span></div></div></div>
    <div class="card"><h2>저장소·별칭 바꾸기</h2><form data-form="market-connect" autocomplete="off"><div class="formgrid"><div class="field full"><label>마켓 저장소</label><input type="text" name="repo" required value="${esc(st.repo)}" spellcheck="false"></div><div class="field"><label>이 PC의 별칭</label><input type="text" name="alias" required maxlength="20" value="${esc(st.alias)}"></div></div><div class="row end" style="margin-top:12px"><button class="btn primary" type="submit">저장하고 다시 연결</button></div></form></div>
    <div class="card"><div class="setting" style="border:0;padding:0"><div><b>연결 해제</b><span class="sub">이 PC에서 마켓을 끕니다. 이미 설치한 스킬과 저장소의 게시 내용은 그대로입니다.</span></div><button class="btn danger" data-act="market-disconnect">연결 해제</button></div></div>`;
}

const errDlg = (title, e) => openDlg(`<div class="dlg-head"><h2>${esc(title)}</h2><p>${esc(e.message)}</p></div><div class="dlg-foot"><button class="btn primary" data-act="dlg-close">닫기</button></div>`);

async function dlgMarketDetail(id) {
  openDlg('<div class="dlg-head"><h2>불러오는 중…</h2></div>');
  let d;
  try { d = await api('GET', `/api/market/skills/${encodeURIComponent(id)}`); } catch (e) { errDlg('스킬을 불러오지 못했습니다', e); return; }
  const offs = (S.market && (S.market.installed || S.market.share)) || [];
  const risks = d.findings.filter((f) => f.level === 'risk');
  const bad = d.revoked || !d.verified || d.findings.some((f) => f.level === 'block');
  openDlg(`<form data-form="market-install" data-id="${esc(d.id)}"><div class="dlg-head"><h2>🧩 ${esc(d.name)} <small class="muted">v${esc(d.version)}</small></h2><p>${esc(d.description)}</p></div>
    <div class="dlg-body"><div class="badges" style="margin-bottom:10px">${d.revoked ? pill('bad', '회수됨') : RISK_PILL[d.riskLevel]()}${d.verified ? pill('ok', '무결성 확인') : pill('bad', '무결성 실패')}${pill('', `게시 ${esc(d.publisher)}${d.sourceAlias ? ` (${esc(d.sourceAlias)})` : ''}`)}${pill('', esc(dshort(d.publishedAt)))}</div>
      ${d.revoked ? `<div class="banner bad" style="margin-bottom:10px"><span class="ic">⛔</span><div class="txt"><b>회수된 스킬이라 설치할 수 없습니다</b><span class="muted">${esc(d.revokedReason)}</span></div></div>` : ''}
      ${d.notes ? `<p class="small"><b>게시 메모</b> ${esc(d.notes)}</p>` : ''}
      ${d.findings.length ? `<div class="group-title">검사 결과</div>${findingsHtml(d.findings)}` : ''}
      <div class="group-title">파일 ${d.files.length}개</div><div class="small muted">${d.files.map((f) => `${esc(f.path)} <span class="faint">(${f.size}B${f.kind === 'script' ? ' · 스크립트' : ''})</span>`).join(' · ')}</div>
      <div class="group-title">SKILL.md 미리보기</div><pre class="mk-pre">${esc(d.skillMd)}</pre>
      ${offs.length ? `<div class="group-title">설치할 곳</div><div class="stack" style="gap:6px">${offs.map((o) => {
        const have = o.skills.find((k) => k.marketId === d.id);
        const upd = have && have.status === 'from-market' && semverGt(d.version, have.version);
        const note = !have ? '' : upd ? pill('ok', `v${esc(have.version)} → v${esc(d.version)} 업데이트`) : have.status === 'from-market' ? pill('', `이미 설치됨 v${esc(have.version)}`) : pill('', '같은 이름의 스킬이 이미 있어요');
        const usable = !have || upd;
        return `<label class="row" style="gap:8px${usable ? '' : ';opacity:.55'}"><input type="checkbox" name="office" value="${esc(o.office)}"${usable ? ' checked' : ' disabled'}><b>${esc(o.officeName)}</b>${o.external ? pill('', 'Hermes 봇') : ''}${note}</label>`;
      }).join('')}</div>
        ${risks.length ? '<label class="row" style="margin-top:10px;font-weight:600"><input type="checkbox" name="allowRisk" required> 위 위험 표시를 모두 확인했고, 그래도 설치합니다</label>' : ''}` : '<p class="muted">설치할 수 있는 사무실이 없습니다.</p>'}
      <p class="small muted" style="margin-top:8px">사무실은 <b>다시 출근</b>시킨 뒤부터, Hermes 봇은 다시 시작하거나 스킬을 다시 읽은 뒤부터 적용됩니다.</p></div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">닫기</button><button class="btn primary" type="submit"${bad || !offs.length ? ' disabled' : ''}>설치하기</button></div></form>`);
}

// 고른 곳 모두에 설치한다. 한 곳이면 예전처럼(덮어쓰기 확인 포함), 여러 곳이면 결과를 모아 한 번에 알려 준다.
async function marketInstallMany(id, officeIds, allowRisk) {
  if (!officeIds.length) throw new Error('설치할 곳을 하나 이상 골라 주세요.');
  if (officeIds.length === 1) return marketInstall(id, officeIds[0], allowRisk, false);
  const nameOf = (o) => (((S.market && S.market.installed) || []).find((x) => x.office === o) || {}).officeName || o;
  const ok = [], bad = [];
  for (const o of officeIds) {
    try { const r = await api('POST', '/api/market/install', { id, office: o, allowRisk, overwrite: false }); if (r.needsRestart) S.restartNeeded[o] = true; ok.push(nameOf(o)); }
    catch (e) { bad.push(`${nameOf(o)}: ${e.message}`); }
  }
  if (!bad.length) { closeDlg(); toast(`${ok.join(', ')}에 설치했습니다.`); return; }
  openDlg(`<div class="dlg-head"><h2>${ok.length}곳 설치, ${bad.length}곳 실패</h2><p>${ok.length ? `설치됨: ${ok.map(esc).join(', ')}` : ''}</p><ul class="find">${bad.map((m) => `<li class="block"><span>⛔</span><div>${esc(m)}</div></li>`).join('')}</ul></div><div class="dlg-foot"><button class="btn primary" data-act="dlg-close">닫기</button></div>`);
}

async function marketInstall(id, office, allowRisk, overwrite) {
  try {
    const r = await api('POST', '/api/market/install', { id, office, allowRisk, overwrite });
    if (r.needsRestart) S.restartNeeded[office] = true;
    closeDlg(); toast(r.external ? '설치했습니다. 이 봇이 스킬을 다시 읽을 때(재시작 등) 적용됩니다.' : r.updated ? `v${r.version}(으)로 업데이트했습니다. 사무실을 다시 출근시키면 적용됩니다.` : '설치했습니다. 사무실을 다시 출근시키면 적용됩니다.');
  } catch (e) {
    if (e.details && e.details.needsConfirm === 'overwrite') {
      dlgConfirm({ title: '직접 고친 내용을 덮어쓸까요?', body: `설치한 뒤 바뀐 파일: <code>${(e.details.changed || []).map(esc).join(', ')}</code><br>덮어쓰면 고친 내용은 사무실의 <code>보관함/맞춤설정_백업</code> 폴더로 옮겨 둡니다.`, ok: '덮어쓰기', danger: true, onOk: async () => { await doing(null, () => marketInstall(id, office, allowRisk, true)); } });
      return;
    }
    throw e;
  }
}

async function dlgPublish(officeId, skillId) {
  openDlg('<div class="dlg-head"><h2>검사하는 중…</h2><p>개인정보·비밀값이 들어 있는지 확인합니다.</p></div>');
  let info;
  try { info = await api('POST', '/api/market/inspect', { office: officeId, skillId }); } catch (e) { errDlg('검사하지 못했습니다', e); return; }
  const ex = info.existing;
  openDlg(`<form data-form="market-publish" data-office="${esc(officeId)}" data-skill="${esc(skillId)}"><div class="dlg-head"><h2>🚀 「${esc(skillId)}」 마켓에 게시</h2><p>올라가는 파일은 아래 ${info.files.length}개뿐입니다. 사무실의 업무 데이터·설정·토큰은 포함되지 않습니다.</p></div>
    <div class="dlg-body"><div class="small muted">${info.files.map((f) => `${esc(f.path)} <span class="faint">(${f.size}B)</span>`).join(' · ')}</div>
      <div class="group-title">검사 결과 ${info.findings.length ? '' : '— 문제 없음 ✅'}</div>${findingsHtml(info.findings)}
      ${ex ? `<p class="small" style="margin-top:8px">마켓에 이미 <b>v${esc(ex.version)}</b> (게시: ${esc(ex.publisher)})가 있습니다.${ex.mine ? '' : ' <span style="color:var(--bad)">다른 게시자의 스킬이라 같은 이름으로 올릴 수 없습니다.</span>'}${ex.revoked ? ' <span style="color:var(--bad)">회수된 이름은 다시 쓸 수 없습니다.</span>' : ''}</p>` : ''}
      <div class="formgrid" style="margin-top:12px"><div class="field"><label>버전</label><input type="text" name="version" required pattern="\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}" value="${esc(info.suggestedVersion)}"><span class="hint">1.0.0 처럼 숫자 세 개. 고칠 때마다 올립니다.</span></div>
      <div class="field full"><label>게시 메모 (선택)</label><textarea name="notes" maxlength="500" style="min-height:70px" placeholder="무엇을 하는 스킬인지, 무엇이 바뀌었는지"></textarea></div></div>
      ${info.warnings.length ? '<label class="row" style="margin-top:10px;font-weight:600"><input type="checkbox" name="cw" required> 개인정보로 보이는 위 내용을 확인했고, 공유해도 괜찮습니다</label>' : ''}
      ${info.risks.length ? '<label class="row" style="margin-top:8px;font-weight:600"><input type="checkbox" name="cr" required> 스크립트 등 위험 표시가 붙는 것을 알고 있고, 그대로 게시합니다</label>' : ''}</div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit"${info.publishable && !(ex && (!ex.mine || ex.revoked)) ? '' : ' disabled'}>게시하기</button></div></form>`);
}

// 모두 게시: 게시할 수 있는 스킬을 한꺼번에 검사해 보여 주고, 사용자가 고르고 확인한 것만 하나씩 게시한다(검사·확인 절차는 한 개씩 올릴 때와 같다).
let bulk = null;
async function dlgPublishAll(officeId) {
  const o = ((S.market && S.market.share) || []).find((x) => x.office === officeId);
  const todo = o ? o.skills.filter((k) => k.status === 'private' || k.status === 'changed') : [];
  if (!todo.length) { toast('게시할 스킬이 없습니다.'); return; }
  openDlg(`<div class="dlg-head"><h2>검사하는 중…</h2><p>스킬 ${todo.length}개에 개인정보·비밀값이 들어 있는지 확인합니다.</p></div>`);
  const items = [];
  for (const k of todo) {
    try { items.push({ id: k.id, name: k.name, info: await api('POST', '/api/market/inspect', { office: officeId, skillId: k.id }) }); }
    catch (e) { items.push({ id: k.id, name: k.name, error: e.message }); }
  }
  for (const it of items) {
    const ex = it.info && it.info.existing;
    it.ok = Boolean(it.info && it.info.publishable && !(ex && (!ex.mine || ex.revoked)));
  }
  bulk = { officeId, items };
  const warnN = items.filter((it) => it.ok && it.info.warnings.length).length, riskN = items.filter((it) => it.ok && it.info.risks.length).length;
  const row = (it, i) => {
    const inf = it.info;
    const why = it.error ? esc(it.error) : !inf.publishable ? '⛔ 차단 항목이 있어 제외됩니다' : (inf.existing && !inf.existing.mine) ? '다른 게시자의 같은 이름이 있어 제외됩니다' : (inf.existing && inf.existing.revoked) ? '회수된 이름이라 제외됩니다' : '';
    return `<div class="bulk-row"><label class="row" style="gap:8px"><input type="checkbox" name="pick" value="${i}"${it.ok ? ' checked' : ' disabled'}><b>${esc(it.name)}</b>${it.ok ? `<span class="small muted">v${esc(inf.suggestedVersion)} · 파일 ${inf.files.length}개</span>` : ''}${it.ok && inf.warnings.length ? pill('warn', `⚠️ 확인 ${inf.warnings.length}`) : ''}${it.ok && inf.risks.length ? pill('warn', `🚨 위험 ${inf.risks.length}`) : ''}${it.ok && !inf.findings.length ? pill('ok', '문제 없음') : ''}</label>
      ${why ? `<div class="small" style="color:var(--bad);margin-left:26px">${why}</div>` : ''}
      ${inf && inf.findings.length ? `<details style="margin-left:26px"><summary class="small muted">검사 결과 ${inf.findings.length}건 보기</summary>${findingsHtml(inf.findings)}</details>` : ''}</div>`;
  };
  openDlg(`<form data-form="market-publish-all" data-office="${esc(officeId)}"><div class="dlg-head"><h2>🚀 스킬 ${items.length}개 한꺼번에 게시</h2><p>같은 마켓에 연결한 다른 PC·봇(라피스 등)이 볼 수 있게 됩니다. 사무실의 업무 데이터·설정·토큰은 포함되지 않고, 게시할 때마다 개인정보 검사를 합니다. 빼고 싶은 스킬은 체크를 풀어 주세요.</p></div>
    <div class="dlg-body">${items.map(row).join('')}
      ${warnN ? `<label class="row" style="margin-top:12px;font-weight:600"><input type="checkbox" name="cw"> 개인정보로 보이는 표시(⚠️ ${warnN}개 스킬)를 확인했고, 공유해도 괜찮습니다</label>` : ''}
      ${riskN ? `<label class="row" style="margin-top:8px;font-weight:600"><input type="checkbox" name="cr"> 스크립트 등 위험 표시(🚨 ${riskN}개 스킬)가 붙는 것을 알고 있고, 그대로 게시합니다</label>` : ''}</div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit"${items.some((it) => it.ok) ? '' : ' disabled'}>선택한 스킬 게시</button></div></form>`);
}

async function publishAllSubmit(f, fd) {
  const picked = fd.getAll('pick').map(Number).map((i) => bulk.items[i]).filter((it) => it && it.ok);
  if (!picked.length) throw new Error('게시할 스킬을 하나 이상 골라 주세요.');
  const needW = picked.some((it) => it.info.warnings.length), needR = picked.some((it) => it.info.risks.length);
  if (needW && fd.get('cw') !== 'on') throw new Error('개인정보로 보이는 내용 확인란에 체크해 주세요.');
  if (needR && fd.get('cr') !== 'on') throw new Error('위험 표시 확인란에 체크해 주세요.');
  const btn = f.querySelector('button[type=submit]');
  const done = [], failed = [];
  for (let i = 0; i < picked.length; i++) {
    const it = picked[i];
    btn.textContent = `게시하는 중… (${i + 1}/${picked.length}) ${it.id}`;
    try { await api('POST', '/api/market/publish', { office: f.dataset.office, skillId: it.id, version: it.info.suggestedVersion, notes: '', confirmWarnings: needW, confirmRisks: needR }); done.push(it.id); }
    catch (e) { failed.push(`${it.id}: ${e.message}`); }
  }
  S.marketDirty = true;
  if (!failed.length) { closeDlg(); toast(`스킬 ${done.length}개를 마켓에 게시했습니다.`); return; }
  openDlg(`<div class="dlg-head"><h2>${done.length}개 게시, ${failed.length}개 실패</h2><p>${done.length ? `게시됨: ${done.map(esc).join(', ')}<br>` : ''}실패한 스킬은 목록에서 한 개씩 다시 시도할 수 있습니다.</p><ul class="find">${failed.map((m) => `<li class="block"><span>⛔</span><div>${esc(m)}</div></li>`).join('')}</ul></div><div class="dlg-foot"><button class="btn primary" data-act="dlg-close">닫기</button></div>`);
}

// ── 연결 · 계정 ──
function vConnect() {
  const c = S.ov.claude, o = cur(), d = S.detail, dg = S.ov.diag;
  let html = `<div class="card"><div class="card-head"><div><h2>Claude 계정</h2><p class="sub">사무실은 본인의 Claude Code 계정으로 일합니다. 로그인은 Claude 공식 로그인 창(브라우저 인증)에서 진행하며, 이 프로그램은 비밀번호나 토큰을 받거나 저장하지 않습니다.</p></div>
    ${c.installed ? (c.auth.loggedIn ? pill('ok', '로그인됨') : pill('warn', '로그인 필요')) : pill('bad', '설치 필요')}</div>`;
  if (!c.installed) {
    const br = c.broken;
    html += `${br ? `<div class="banner warn" style="margin-bottom:12px"><span class="ic">🔍</span><div class="txt"><b>Claude Code 파일은 있지만 실행되지 않습니다</b><span class="muted">${esc(br.error)}</span><div class="path" style="margin-top:4px">${esc(br.path)}</div></div></div>` : ''}<div class="row"><button class="btn primary" data-act="claude-install">${br ? 'Claude Code 다시 설치' : 'Claude Code 설치'}</button><button class="btn" data-act="claude-refresh">설치했어요, 다시 확인</button><button class="btn sm ghost" data-act="claude-diagnose">진단 정보 보기</button></div><p class="small muted" style="margin-top:10px">설치 창이 열리고 <code>npm install -g @anthropic-ai/claude-code</code> 가 실행됩니다. Node.js가 필요합니다.</p>`;
  } else if (c.auth.loggedIn) {
    html += `<div class="row"><div class="avatar">${esc((c.auth.email || 'C')[0].toUpperCase())}</div><div><b>${esc(c.auth.email || '')}</b><div class="small muted">${esc(planLabel(c.auth))}${c.auth.org ? ` · ${esc(c.auth.org)}` : ''} · Claude Code ${esc(c.version)}</div></div><span class="spacer"></span><button class="btn sm" data-act="claude-refresh">새로고침</button><button class="btn sm" data-act="claude-login">다른 계정으로 로그인</button><button class="btn sm danger" data-act="claude-logout">로그아웃</button></div>`;
  } else {
    html += `<div class="row"><button class="btn primary" data-act="claude-login">Claude 구독 계정으로 로그인</button><button class="btn" data-act="claude-login-console">Anthropic Console(API 요금)으로 로그인</button><button class="btn sm ghost" data-act="claude-refresh">로그인했어요, 다시 확인</button><button class="btn sm ghost" data-act="claude-diagnose">진단 정보 보기</button></div>
    ${c.auth.error ? `<p class="small" style="margin-top:10px;color:var(--warn)">상태 확인 메시지: ${esc(c.auth.error)}</p>` : ''}
    <ol class="guide"><li>버튼을 누르면 새 창이 열리고 브라우저에서 로그인 화면이 나옵니다.</li><li>로그인을 마치면 창이 안내하는 대로 닫고, 이 화면에서 「다시 확인」을 누르세요.</li><li>Claude <b>데스크톱 앱</b>에 로그인한 것과 <b>Claude Code</b> 로그인은 따로입니다. 여기서는 위 버튼으로 Claude Code에 로그인해야 합니다.</li></ol>`;
  }
  html += '</div>';

  html += `<div class="card"><div class="card-head"><div><h2>텔레그램 봇${o ? ` — ${esc(o.name)}` : ''}</h2><p class="sub">지시를 주고받는 통로입니다. 사무실마다 봇 하나를 따로 연결합니다.</p></div></div>`;
  if (!o) html += '<p class="muted">먼저 사무실을 만들어 주세요.</p>';
  else if (o.readonly) html += '<p class="muted">별개의 봇이라 여기서 연결을 바꾸지 않습니다.</p>';
  else if (d) {
    const tg = d.telegram, ac = tg.access || { allowFrom: [], pending: [], dmPolicy: 'pairing' };
    html += `<div class="stack"><div class="setting" style="border:0;padding-top:0"><div><b>1. 봇 토큰</b><span class="sub">${tg.set ? `${tg.bot && tg.bot.username ? `@${esc(tg.bot.username)} · ` : ''}저장됨 <span class="code">${esc(tg.masked)}</span>${tg.bot && tg.bot.error ? ` · ⚠️ ${esc(tg.bot.error)}` : ''}` : '텔레그램의 @BotFather 에게 /newbot 을 보내 봇을 만들고, 받은 토큰을 붙여 넣으세요.'}</span></div>
      ${tg.set ? '<button class="btn sm danger" data-act="tg-token-clear">토큰 지우기</button>' : ''}</div>
      <form class="row" data-form="tg-token" autocomplete="off"><input type="password" name="token" placeholder="123456789:AAH…" style="flex:1;min-width:220px" autocomplete="off" spellcheck="false"><button class="btn primary" type="submit">${tg.set ? '토큰 바꾸기' : '토큰 저장'}</button></form>
      <p class="small muted">토큰은 이 PC의 사무실 폴더 <code>.telegram/.env</code> 에만 저장되고, 화면과 로그에는 앞뒤 일부만 보입니다.</p>
      <div class="banner info"><span class="ic">⚠️</span><div class="txt"><b>다른 PC·다른 사무실에서 쓰는 봇 토큰은 넣지 마세요</b><span class="muted">봇 하나는 한 곳에서만 메시지를 받을 수 있습니다. 같은 토큰을 두 곳에 넣으면 서로 가로채서 지시가 사라집니다. 사무실마다 @BotFather 에서 새 봇을 만드세요.</span></div></div>
      <hr class="sep">
      <div><b>2. 내 텔레그램 계정 허용(페어링)</b><p class="sub">사무실을 <b>출근시킨 뒤</b> 텔레그램에서 <b>이 사무실의 봇</b>에게 아무 메시지나 보내면 6자리 코드를 알려 줍니다. 그 코드를 입력하세요.</p></div>
      ${!o.running ? '<div class="banner warn"><span class="ic">⏸</span><div class="txt"><b>사무실이 꺼져 있어서 봇이 코드를 보낼 수 없습니다</b><span class="muted">봇은 사무실이 켜져 있는 동안에만 메시지를 받습니다. 먼저 「출근시키기」를 눌러 주세요(Claude 로그인과 봇 토큰이 준비돼 있어야 합니다).</span></div><button class="btn sm primary" data-act="office-start">출근시키기</button></div>' : ''}
      ${ac.allowFrom.length && !ac.pending.length ? '<p class="small muted">이미 허용된 계정이 있어서, 그 계정이 보내는 /start 에는 새 코드가 나오지 않을 수 있습니다. 새 계정을 추가하려면 그 계정으로 보내 주세요.</p>' : ''}
      ${ac.pending.length ? `<table class="tbl"><thead><tr><th>코드</th><th>보낸 사람 ID</th><th>경과</th><th></th></tr></thead><tbody>${ac.pending.map((p) => `<tr><td><span class="code">${esc(p.code)}</span></td><td class="mono">${esc(p.senderId)}</td><td>${Math.round(p.ageSec / 60)}분 전</td><td class="row end"><button class="btn sm primary" data-act="tg-pair" data-code="${esc(p.code)}">허용</button><button class="btn sm" data-act="tg-deny" data-code="${esc(p.code)}">거절</button></td></tr>`).join('')}</tbody></table>` : ''}
      <form class="row" data-form="tg-pair" autocomplete="off"><input type="text" name="code" placeholder="6자리 코드" maxlength="10" style="max-width:190px" autocomplete="off"><button class="btn" type="submit">코드로 허용</button></form>
      ${ac.allowFrom.length ? `<div><div class="small muted" style="margin-bottom:6px">허용된 계정</div><div class="row">${ac.allowFrom.map((id) => `<span class="pill">${esc(id)} <button class="btn sm ghost" style="padding:0 4px" data-act="tg-remove" data-id="${esc(id)}" title="허용 해제">✕</button></span>`).join('')}</div></div>` : ''}
      <div class="setting"><div><b>새 사용자 처리</b><span class="sub">허용된 계정 외의 메시지를 어떻게 다룰지 정합니다.</span></div>
        <select data-change="tg-policy" style="max-width:250px"><option value="pairing"${ac.dmPolicy === 'pairing' ? ' selected' : ''}>코드로 승인 받기(기본)</option><option value="allowlist"${ac.dmPolicy === 'allowlist' ? ' selected' : ''}>허용된 계정만(무시)</option><option value="disabled"${ac.dmPolicy === 'disabled' ? ' selected' : ''}>개인 대화 끄기</option></select></div></div>`;
  } else html += '<p class="muted">불러오는 중…</p>';
  html += '</div>';
  if (o && !o.readonly && d) html += (d.telegram && d.telegram.legacy) ? legacyRoomsCard(o, d) : roomsCard(o, d);

  const rows = (dg.pollers || []).map((p) => `<tr><td class="mono">${p.pid}</td><td>${esc(p.owner)}</td><td>${p.startedAt ? new Date(p.startedAt).toLocaleString('ko-KR', { hour12: false }) : ''}</td><td>${p.legit ? pill('ok', '정상') : pill('bad', '가로채는 중')}</td></tr>`).join('');
  html += `<div class="card"><div class="card-head"><div><h2>수신 진단</h2><p class="sub">텔레그램 봇은 한 곳에서만 메시지를 받을 수 있습니다. 사무실 밖의 Claude 창이 수신을 가져가면 지시가 도착하지 않습니다.</p></div><div class="row"><button class="btn sm" data-act="diag-refresh">다시 검사</button>${dg.rogue ? '<button class="btn sm primary" data-act="diag-clean">가로채는 프로세스 정리</button>' : ''}</div></div>
    ${dg.supported ? (rows ? `<table class="tbl"><thead><tr><th>프로세스</th><th>띄운 곳</th><th>시작 시각</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">실행 중인 텔레그램 수신 프로세스가 없습니다.</p>') : '<p class="muted">이 검사는 Windows에서만 지원합니다.</p>'}
    ${dg.globalPlugin ? `<hr class="sep"><div class="setting" style="border:0;padding:0"><div><b>텔레그램 플러그인이 전역으로 켜져 있음</b><span class="sub">새로 여는 모든 Claude 창이 수신을 가로챌 수 있습니다. 끄면 <code>settings.json</code>을 백업한 뒤 한 줄만 바꿉니다(사무실은 폴더 설정으로 계속 켜져 있습니다).</span></div><button class="btn" data-act="diag-global-off">전역에서 끄기</button></div>` : ''}</div>`;
  return html;
}

// ── 그룹방 · 주제별 업무 ──
const BOT_STATUS = { creator: '방장', administrator: '관리자', member: '참여 중', restricted: '제한됨', left: '나감', kicked: '강퇴됨', unknown: '확인 안 됨' };
const ROOM_TYPE = { supergroup: '슈퍼그룹', group: '그룹' };

function roomTaskForm(chatId, threadId, task, teams, placeholder) {
  const depts = teams.length
    ? `<select data-change="room-dept" style="max-width:220px"><option value="">부서로 채우기…</option>${teams.map((t) => `<option value="${esc(`담당 부서: ${t.name}${t.role ? ` — ${t.role}` : ''}. `)}">${esc(`${t.emoji || ''} ${t.name}`.trim())}</option>`).join('')}</select>`
    : '';
  return `<form class="stack" data-form="room-task" data-chat="${esc(chatId)}" data-thread="${esc(threadId)}" autocomplete="off" style="gap:6px">
    <textarea name="task" maxlength="800" style="min-height:56px" placeholder="${esc(placeholder)}">${esc(task)}</textarea>
    <div class="row">${depts}<span class="spacer"></span><button class="btn sm primary" type="submit">저장</button></div></form>`;
}

function roomsCard(o, d) {
  const rm = (d.telegram && d.telegram.rooms) || { rooms: [], defaultTask: '' };
  const teams = d.teams || [];
  const items = rm.rooms.map((r) => {
    const present = r.botStatus !== 'left' && r.botStatus !== 'kicked';
    const pills = [
      pill('', esc(ROOM_TYPE[r.type] || r.type || '방')), r.isForum ? pill('accent', '주제 사용') : '',
      pill(present ? (r.botStatus === 'unknown' ? 'warn' : 'ok') : 'bad', `봇 ${esc(BOT_STATUS[r.botStatus] || r.botStatus)}`),
      r.connected ? pill('ok', '연결됨') : pill('warn', '미연결'),
    ].join(' ');
    const actions = r.connected
      ? `<button class="btn sm" data-act="room-disconnect" data-chat="${esc(r.id)}">연결 해제</button>`
      : `${present ? `<button class="btn sm primary" data-act="room-connect" data-chat="${esc(r.id)}">연결</button>` : `<button class="btn sm" data-act="room-forget" data-chat="${esc(r.id)}">목록에서 지우기</button>`}`;
    const topics = r.topics.length
      ? `<div class="small muted" style="margin:10px 0 6px">주제별 업무 <span class="muted">(비워 두면 방 업무를 따릅니다)</span></div>${r.topics.map((t) => `<div style="margin-bottom:8px"><div class="small"><b>${esc(t.name || '(이름 미확인)')}</b> <span class="mono muted">#${esc(t.id)}</span>${t.closed ? ' ' + pill('', '닫힘') : ''}</div>${roomTaskForm(r.id, t.id, t.task, teams, '이 주제에서만 할 일')}</div>`).join('')}`
      : (r.isForum ? '<p class="small muted" style="margin-top:8px">아직 본 주제가 없습니다. 주제 안에서 봇이 메시지를 받거나 주제가 새로 만들어지면 여기에 나타납니다. (텔레그램은 봇에게 주제 목록을 알려 주지 않습니다.)</p>' : '');
    return `<div class="room" style="padding:14px 0;border-top:1px solid var(--line)">
      <div class="row"><div><b>${esc(r.title)}</b> ${pills}<div class="small muted"><span class="mono">${esc(r.id)}</span>${r.invitedBy ? ` · 초대: ${esc(r.invitedBy.name)}${r.invitedAt ? ' ' + dshort(r.invitedAt) : ''}` : ''}${r.connected ? ` · ${r.requireMention ? '멘션해야 응답' : '모든 메시지 응답'}, 허용된 계정 ${r.allowFromCount ? r.allowFromCount + '명만' : '제한 없음'}` : ''}</div>
        ${r.checkError ? `<div class="small" style="color:var(--warn)">확인 메시지: ${esc(r.checkError)}</div>` : ''}</div><span class="spacer"></span>${actions}</div>
      ${!r.connected && present ? '<p class="small muted" style="margin:6px 0 0">연결하면 봇이 이 방에서 허용된 계정의 멘션에 응답합니다. 방에서 본인이 봇을 @멘션해도 자동으로 연결됩니다.</p>' : ''}
      <div class="small muted" style="margin:10px 0 6px">이 방의 업무</div>${roomTaskForm(r.id, '', r.task, teams, '예: 학원 문의에 답하고, 기밀 자료는 올리지 않기')}${topics}</div>`;
  }).join('');
  return `<div class="card"><div class="card-head"><div><h2>그룹방 · 주제별 업무</h2><p class="sub">봇이 초대된 방과 주제를 보여 주고, 방마다 맡길 업무를 정합니다. <b>허용된 계정이 봇을 방에 초대하면 자동으로 연결</b>되고, 모르는 사람이 초대하면 텔레그램으로 승인을 묻습니다. 업무는 저장하면 바로 적용됩니다(다시 출근 불필요).</p></div>
    <div class="row"><button class="btn sm" data-act="room-refresh">상태 확인</button></div></div>
    ${!o.running ? '<div class="banner warn"><span class="ic">⏸</span><div class="txt"><b>사무실이 꺼져 있습니다</b><span class="muted">봇이 켜져 있는 동안 초대된 방만 기록됩니다.</span></div></div>' : ''}
    <form class="stack" data-form="room-default-task" autocomplete="off" style="gap:6px;margin-bottom:6px"><div><b>기본 업무</b><span class="sub">새로 자동 연결되는 방에 처음 붙는 업무입니다. 이미 연결된 방은 바뀌지 않습니다.</span></div>
      <textarea name="task" maxlength="800" style="min-height:48px" placeholder="비워 두면 방마다 따로 정합니다">${esc(rm.defaultTask)}</textarea><div class="row end"><button class="btn sm" type="submit">기본 업무 저장</button></div></form>
    ${items || '<p class="muted" style="border-top:1px solid var(--line);padding-top:14px">아직 봇이 아는 방이 없습니다. 봇을 그룹방에 초대해 보세요. 이미 들어가 있는 방은 그 방에서 봇을 @멘션하면 기록됩니다.</p>'}</div>`;
}

// ── 예전 방식의 방 · 주제 / 정기 보고 ──
const RT = [['morning', '☀️ 아침 업무보고', '오늘 할 일'], ['evening', '🌙 저녁 업무결산', '오늘 한 일 · 내일 할 일']];
const teamOpts = (teams, sel) => `<option value="없음"${sel ? '' : ' selected'}>담당 팀 없음</option>${teams.map((t) => `<option value="${esc(t.key)}"${t.key === sel ? ' selected' : ''}>${esc(`${t.emoji || ''} ${t.name}`.trim())}</option>`).join('')}`;

function legacyRoutineBox(lg) {
  const rt = lg.routine || {};
  const linked = lg.rooms.filter((r) => r.linked);
  const opts = [{ v: JSON.stringify({ room: '개인' }), label: '내 개인 대화', on: rt.room === '개인 대화' }];
  for (const r of linked) {
    opts.push({ v: JSON.stringify({ room: r.id }), label: `${r.title} (일반)`, on: rt.chatId === r.id && !rt.threadId });
    for (const t of r.topics) opts.push({ v: JSON.stringify({ room: r.id, topic: t.id }), label: `${r.title} › ${t.name}`, on: rt.chatId === r.id && String(rt.threadId) === String(t.id) });
  }
  const has = Boolean(rt.chatId);
  return `<div class="room" style="padding:14px 0;border-top:1px solid var(--line)"><b>⏰ 정기 보고</b>
    <div class="small muted">정한 시각에 비서실장이 보고를 작성해 올립니다. PC가 꺼져 있었다면 켜진 뒤 아침은 3시간, 저녁은 자정 전까지 한 번 올립니다.</div>
    <div class="row" style="margin-top:8px"><label class="small muted">받을 곳</label><select data-change="lr-rt-target" style="flex:1;min-width:200px">${has ? '' : '<option value="">— 선택하세요 —</option>'}${opts.map((x) => `<option value="${esc(x.v)}"${x.on ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div>
    ${RT.map(([id, label, sub]) => { const x = rt[id] || {}; return `<div class="row" style="margin-top:8px"><span style="min-width:150px"><b>${label}</b><br><span class="small muted">${sub}</span></span>
      <input type="time" value="${esc(x.time || '')}" data-change="lr-rt-time" data-id="${id}" style="max-width:130px"${has ? '' : ' disabled'}>
      <label class="row small" style="gap:6px"><span class="switch"><input type="checkbox" data-change="lr-rt-on" data-id="${id}"${x.enabled ? ' checked' : ''}${has ? '' : ' disabled'}><i></i></span>켜기</label>
      <button class="btn sm" data-act="lr-rt-test" data-id="${id}"${has ? '' : ' disabled'}>지금 시험 발송</button>
      <span class="small muted">${x.lastRun ? `마지막 발송 ${esc(x.lastRun)}` : ''}</span></div>`; }).join('')}</div>`;
}

function legacyRoomsCard(o, d) {
  const lg = d.telegram.legacy;
  const items = lg.rooms.map((r) => {
    const pills = [pill('', esc(ROOM_TYPE[r.type] || r.type || '방')), r.isForum ? pill('accent', '주제 사용') : '', r.isAdmin ? pill('ok', '봇 관리자') : pill('', `봇 ${esc(BOT_STATUS[r.botStatus] || r.botStatus)}`), r.linked ? pill('ok', '업무방 연결됨') : pill('warn', '미연결')].join(' ');
    const topics = r.topics.length ? r.topics.map((t) => `<div class="row" style="padding:4px 0"><span style="flex:1;min-width:0">🗂 ${esc(t.name)} <span class="small muted mono">#${esc(t.id)}</span></span>
      <select data-change="lr-assign" data-room="${esc(r.id)}" data-topic="${esc(t.id)}" style="max-width:210px">${teamOpts(lg.teams, t.team)}</select></div>`).join('')
      : (r.isForum ? '<p class="small muted">아직 본 주제가 없습니다. 주제 안에서 메시지가 오가면 나타납니다.</p>' : '');
    const newTopic = r.linked && r.isForum ? `<div class="row" style="margin-top:6px"><input type="text" data-new="${esc(r.id)}" maxlength="128" placeholder="새 주제 이름 (예: 물품 대여 신청)" style="flex:1;min-width:160px"><select data-newteam="${esc(r.id)}" style="max-width:200px">${teamOpts(lg.teams, null)}</select><button class="btn sm primary" data-act="lr-topic" data-room="${esc(r.id)}">주제 만들기</button></div>` : '';
    const opts = r.linked ? `<div class="row" style="margin-top:8px">
        <label class="row small" style="gap:6px"><span class="switch"><input type="checkbox" data-change="lr-mention" data-room="${esc(r.id)}"${r.requireMention ? ' checked' : ''}><i></i></span>봇을 부를 때만 응답(@멘션·답장)</label>
        <label class="row small" style="gap:6px"><span class="switch"><input type="checkbox" data-change="lr-confirm" data-room="${esc(r.id)}"${r.confirmPosts ? ' checked' : ''}><i></i></span>올리기 전 승인 받기</label></div>
      <div class="row" style="margin-top:6px"><span class="small muted">비서실장 호출어(메시지 맨 앞)</span><input type="text" id="lr-trg-${esc(r.id)}" maxlength="10" value="${esc(r.trigger)}" placeholder="없음" style="max-width:90px;text-align:center"><button class="btn sm" data-act="lr-trigger" data-room="${esc(r.id)}">저장</button>
        <span class="small muted">${r.trigger ? `예: ${esc(r.trigger)} 오늘 대여 현황 알려줘` : '기호 없이 내 메시지를 모두 받습니다'}</span></div>` : '';
    return `<div class="room" style="padding:14px 0;border-top:1px solid var(--line)">
      <div class="row"><div><b>${esc(r.title)}</b> ${pills}<div class="small muted"><span class="mono">${esc(r.id)}</span>${r.memberCount != null ? ` · ${r.memberCount}명` : ''}</div>${r.error ? `<div class="small" style="color:var(--warn)">확인 메시지: ${esc(r.error)}</div>` : ''}</div><span class="spacer"></span>
        ${r.linked ? `<button class="btn sm" data-act="lr-unlink" data-room="${esc(r.id)}">연결 해제</button>` : `<button class="btn sm primary" data-act="lr-link" data-room="${esc(r.id)}">업무방으로 연결</button>`}</div>
      ${r.topics.length || r.isForum ? `<div class="small muted" style="margin:10px 0 4px">주제별 담당 팀</div>${topics}` : ''}${newTopic}${opts}</div>`;
  }).join('');
  return `<div class="card"><div class="card-head"><div><h2>텔레그램 방 · 주제</h2><p class="sub">봇이 들어간 방입니다. 업무방으로 연결하면 그 방의 주제(토픽)마다 담당 팀을 정해 일을 나눌 수 있습니다.</p></div>
    <div class="row"><button class="btn sm" data-act="lr-refresh">텔레그램에서 다시 확인</button></div></div>
    ${legacyRoutineBox(lg)}
    ${items || '<p class="muted" style="border-top:1px solid var(--line);padding-top:14px">아직 봇이 아는 방이 없습니다. 봇을 그룹방에 초대한 뒤 방에서 한 번 말을 걸어 주세요.</p>'}</div>`;
}

// ── 설정 ──
function vUpdateCard(u, cfg) {
  if (!u) return '';
  const state = u.available && u.latest ? `<span class="pill accent">새 버전 v${esc(u.latest.version)}</span>` : (u.checkedAt && !u.error ? '<span class="pill ok">최신 버전입니다</span>' : '');
  return `<div class="card"><div class="card-head"><div><h2>업데이트</h2><div class="badges">현재 v${esc(u.current)} ${state}</div></div><div class="row"><button class="btn sm" data-act="update-check">지금 확인</button>${u.available && u.canApply ? '<button class="btn sm primary" data-act="update-apply">지금 업데이트</button>' : ''}</div></div>
    ${u.error ? `<p class="small" style="color:var(--bad)">${esc(u.error)}</p>` : ''}
    <p class="small muted">${u.checkedAt ? `마지막 확인: ${ago(u.checkedAt)} 전. ` : ''}켜 있는 동안 6시간마다 새 버전을 자동으로 확인합니다.${u.canApply ? '' : ` ${esc(u.why)}`}</p>
    ${u.available && u.latest && u.latest.notes ? `<details style="margin-top:8px"><summary class="small">변경 내용 보기</summary><pre class="small" style="white-space:pre-wrap;margin-top:6px">${esc(u.latest.notes)}</pre></details>` : ''}
    ${u.canApply ? `<div class="setting" style="margin-top:10px"><div><b>새 버전이 나오면 바로 자동 설치</b><span class="sub">꺼 두면 알림만 뜨고 직접 눌러야 설치됩니다(기본). 켜면 확인되는 즉시 설치하고 대시보드를 다시 시작합니다. 사무실은 계속 근무하고, 이전 버전은 백업됩니다.</span></div><label class="switch"><input type="checkbox" data-change="autoupdate"${cfg.autoUpdate ? ' checked' : ''}><i></i></label></div>` : ''}</div>`;
}

// 드라이브 접근: D 드라이브 같은 위치를 사무실이 읽고·쓰고·(원하면) 지울 수 있게 사용자가 직접 맡긴다.
const DRIVE_LEVEL = { readwrite: '읽기·쓰기·만들기·수정', full: '읽기·쓰기·만들기·수정·<b class="bad-text">삭제</b>' };
function vDrives() {
  const list = (S.detail && S.detail.drives) || [];
  return `<div class="setting" style="align-items:flex-start"><div><b>드라이브 접근 (파일 서버처럼 쓰기)</b><span class="sub">D 드라이브처럼 사무실이 파일을 읽고, 만들고, 고치고, 필요하면 지울 수 있게 맡깁니다. 여기서 직접 켠 위치만 열리며, 봇이 스스로 열 수는 없습니다. 바꾼 뒤에는 다시 출근해야 새 지침이 적용됩니다.</span>
    ${list.length ? `<div class="stack" style="margin-top:8px">${list.map((g) => `<div class="row" style="justify-content:space-between;gap:10px"><span><span class="code">${esc(g.path)}</span> · ${DRIVE_LEVEL[g.level] || ''}</span><button class="btn sm" data-act="drive-revoke" data-path="${esc(g.path)}">해제</button></div>`).join('')}</div>` : ''}</div>
    <button class="btn sm" data-act="drive-add">위치 추가</button></div>`;
}

function dlgDriveAdd() {
  openDlg(`<form data-form="drive-add"><div class="dlg-head"><h2>드라이브 접근 맡기기</h2><p>이 위치 안의 파일을 사무실(봇)이 텔레그램 지시에 따라 다룰 수 있게 합니다. 위치 밖과 봇의 토큰·설정 폴더는 계속 막혀 있습니다.</p></div>
    <div class="dlg-body"><div class="stack">
      <div class="field"><label>위치</label><input type="text" name="path" required placeholder="D:\\" value="D:\\" autofocus><span class="hint">드라이브 전체(D:\\) 또는 폴더(D:\\공유자료)를 적습니다.</span></div>
      <div class="field"><label>맡길 범위</label><select name="level"><option value="readwrite">읽기·쓰기·만들기·수정·옮기기 (삭제 제외)</option><option value="full">위 + 삭제까지</option></select></div>
      <label class="row" style="font-weight:500;color:var(--text);align-items:flex-start;gap:8px"><input type="checkbox" name="confirmDelete"><span>삭제까지 맡기면 <b>휴지통 없이 지워질 수 있고 되돌릴 수 없다</b>는 것을 알고 있습니다. (삭제를 고른 경우에만 체크)</span></label>
      <p class="small muted">삭제 명령은 "명령에 이 경로가 들어 있을 때"만 허용하는 방식이라 경계가 완벽하지 않습니다. 정말 필요한 폴더만, 중요한 자료는 백업한 뒤 맡기세요. 폴더 통째·대량 삭제는 봇이 먼저 목록을 보고하고 허용을 받도록 지침에 들어갑니다.</p>
    </div></div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit">맡기기</button></div></form>`);
}

// Hermes 사용 모드: 읽기 전용(보기만) / 사무실용·단일 사용(켜고 끄기까지 이 프로그램이 맡음)
function vHermesMode(o) {
  const card = (mode, title, tag, lines) => {
    const on = (o.mode || 'readonly') === mode;
    return `<div class="mode-card${on ? ' on' : ''}"><div class="top-row"><b>${title}</b>${on ? pill('ok', '사용 중') : `<button class="btn sm primary" data-act="hermes-mode" data-mode="${mode}">이 모드로 바꾸기</button>`}</div><div class="small muted">${tag}</div><ul class="mode-list">${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>`;
  };
  return `<div class="setting block"><div><b>사용 모드</b><span class="sub">이 프로그램이 이 Hermes 봇을 어디까지 맡을지 고릅니다. 언제든 바꿀 수 있고, 어느 쪽이든 폴더와 파일은 지워지지 않아요.</span></div>
    <div class="grid cols-2" style="margin-top:10px">${card('readonly', '🔒 읽기 전용', '가장 안전해요 — 보기만 합니다', ['스킬 목록을 보여 주고, 스킬 마켓에서 스킬 설치만 도와요.', '켜기·끄기, 항상 켜두기, 설정 변경은 하지 않아요.', 'Hermes 는 지금처럼 자체 방식으로 계속 일해요.'])}${card('office', '🏢 사무실용 · 단일 사용', '이 프로그램이 이 봇 하나를 사무실처럼 맡아요', ['출근시키기·퇴근시키기로 Hermes 를 켜고 꺼요.', '「항상 켜두기」를 켜면 꺼졌을 때 이 프로그램이 다시 켜 줘요.', '이 봇 하나만 단독으로 운영하는 방식이에요. 같은 텔레그램 봇 토큰을 다른 곳(Claude 사무실·LAPIS 봇)에서 동시에 쓰지 마세요.', '대화·텔레그램·스킬 내용은 Hermes 자체 설정으로 바꿔요(부서·드라이브는 없어요).'])}</div></div>`;
}

function vSettings() {
  const cfg = S.ov.config, o = cur(), a = S.ov.app;
  let html = `<div class="card"><h2>일반</h2><p class="sub" style="margin-bottom:6px">새 사무실을 만들 때 쓰는 기본값과 화면 설정입니다.</p>
    <form data-form="config"><div class="formgrid" style="margin-top:12px">
      <div class="field"><label>기본 호칭</label><input type="text" name="honorific" value="${esc(cfg.honorific)}" maxlength="20"><span class="hint">봇이 나를 부르는 말입니다. (예: 대표님, 팀장님)</span></div>
      <div class="field"><label>화면 색상</label><select name="theme"><option value="auto"${cfg.theme === 'auto' ? ' selected' : ''}>시스템 설정 따르기</option><option value="light"${cfg.theme === 'light' ? ' selected' : ''}>밝게</option><option value="dark"${cfg.theme === 'dark' ? ' selected' : ''}>어둡게</option></select></div>
      <div class="field"><label>대시보드 포트</label><input type="number" name="port" value="${cfg.port}" min="1024" max="65535"><span class="hint">바꾸면 대시보드를 다시 열어야 합니다.</span></div>
      <div class="field"><label>자동 복구</label><label class="row" style="font-weight:500;color:var(--text)"><span class="switch"><input type="checkbox" name="autoRestart"${cfg.autoRestart ? ' checked' : ''}><i></i></span>꺼진 사무실 다시 켜기</label><span class="hint">'항상 켜두기'를 켠 사무실이 꺼지면 다시 출근시킵니다.</span></div>
    </div><div class="row end" style="margin-top:14px"><button class="btn primary" type="submit">저장</button></div></form></div>`;
  if (o) {
    html += `<div class="card"><div class="card-head"><div><h2>${esc(o.name)}</h2><div class="badges">${kindPill(o)}${runPill(o)}</div></div></div>`;
    if (o.kind === 'hermes') html += vHermesMode(o);
    if (o.readonly) {
      html += `<div class="setting"><div><b>봇 폴더</b><span class="sub">봇의 설정과 스킬이 들어 있는 곳이에요. 이 프로그램은 열어서 보기만 해요.</span><br><span class="sub path">${esc(o.folder)}</span></div><button class="btn sm" data-act="office-open">폴더 열기</button></div>`;
    } else {
      const hermes = o.kind === 'hermes';
      html += `<div class="setting"><div><b>${hermes ? '봇 켜기 / 끄기' : '사무실 켜기 / 끄기'}</b><span class="sub">${o.running ? '지금 근무 중입니다.' : '지금 퇴근 상태입니다.'} ${hermes ? '출근시키면 Hermes 가 켜져 텔레그램 등의 메시지를 받기 시작합니다.' : '출근시키면 봇이 텔레그램 지시를 받기 시작합니다.'}</span></div><div class="row">${o.running ? '<button class="btn" data-act="office-restart">다시 출근</button><button class="btn danger" data-act="office-stop">퇴근시키기</button>' : '<button class="btn primary" data-act="office-start">출근시키기</button>'}</div></div>
      <div class="setting"><div><b>항상 켜두기</b><span class="sub">이 프로그램이 켜져 있는 동안, 봇이 꺼져 있으면 다시 출근시킵니다. 직접 퇴근시킨 경우에는 다시 켜지 않습니다.</span></div><label class="switch"><input type="checkbox" data-change="autostart"${o.autoStart ? ' checked' : ''}><i></i></label></div>
      <div class="setting"><div><b>${hermes ? '봇 폴더' : '사무실 폴더'}</b><span class="sub">${hermes ? 'Hermes 의 설정·스킬·기록이 들어 있는 곳이에요.' : '봇의 지침·부서·기록이 들어 있는 곳이에요. 폴더를 옮기셨다면 「위치 바꾸기」로 알려 주세요.'}</span><br><span class="sub path">${esc(o.folder)}</span></div><div class="row">${hermes ? '' : '<button class="btn sm" data-act="office-relocate">위치 바꾸기</button>'}<button class="btn sm" data-act="office-open">폴더 열기</button></div></div>
      ${!hermes && !o.managed && String(o.folder).slice(0, 2).toLowerCase() === String(a.officesDir).slice(0, 2).toLowerCase() && !String(o.folder).toLowerCase().startsWith(String(a.officesDir).toLowerCase()) ? `<div class="setting"><div><b>고정 위치로 옮기기</b><span class="sub">바탕화면 등 바뀔 수 있는 위치의 사무실을 <span class="code">${esc(a.officesDir)}</span> 로 복사해 옮깁니다. 원본은 지우지 않습니다. 퇴근 상태에서만 할 수 있고, 처음 출근할 때 폴더 신뢰 확인이 다시 나옵니다.</span></div><button class="btn sm" data-act="office-migrate"${o.running ? ' disabled' : ''}>옮기기</button></div>` : ''}
      ${hermes ? '' : vDrives()}
      `;
    }
    html += `<div class="setting"><div><b>봇 삭제</b><span class="sub">${o.removeKind === 'close'
      ? `봇을 끄고 목록에서 없앱니다. 폴더(봇 토큰·업무 기록 포함)는 완전히 지우지 않고 <span class="code">${esc(a.dataHome)}\\closed</span> 로 옮겨 둡니다.`
      : '켜져 있으면 끄고, 이 프로그램의 목록에서 없앱니다. 폴더와 파일은 지우지 않고 그대로 두며, 나중에 「불러오기」로 다시 등록할 수 있어요.'}</span></div><button class="btn sm danger" data-act="office-remove">삭제하기</button></div></div>`;
  }
  html += vUpdateCard(S.ov.update, cfg);
  html += `<div class="card"><h2>프로그램 정보</h2><div class="setting" style="border:0"><div><b>AI-Office ${esc(a.version)}</b><span class="sub">프로그램: <span class="path">${esc(a.appHome)}</span><br>데이터: <span class="path">${esc(a.dataHome)}</span></span></div><button class="btn sm" data-act="open-data">데이터 폴더 열기</button></div>
    <p class="small muted">프로그램과 데이터는 고정 위치에 있어, 바탕화면을 정리하거나 폴더를 옮겨도 계속 동작합니다.</p></div>`;
  return html;
}

// ── 대화상자 ──
const dlg = () => $('#dlg');
function openDlg(html) { dlg().innerHTML = `<div class="dlg">${html}</div>`; if (!dlg().open) dlg().showModal(); }
function closeDlg() { if (dlg().open) dlg().close(); }
dlg().addEventListener('click', (e) => { if (e.target === dlg()) closeDlg(); });

async function loadPresets() { if (!S.presets) S.presets = await api('GET', '/api/presets'); return S.presets; }

async function dlgNewOffice() {
  const presets = await loadPresets();
  const groups = [...new Set(presets.map((p) => p.group))];
  const def = new Set(['researcher', 'planner', 'marketer', 'developer', 'reviewer']);
  openDlg(`<form data-form="new-office"><div class="dlg-head"><h2>새 사무실 만들기</h2><p>텔레그램 봇 하나와 부서들이 함께 일하는 분리된 작업 공간을 만듭니다.</p></div>
    <div class="dlg-body"><div class="formgrid"><div class="field"><label>사무실 이름</label><input type="text" name="name" required maxlength="40" placeholder="예: 우리 팀 사무실" autofocus></div>
      <div class="field"><label>봇이 나를 부르는 호칭</label><input type="text" name="honorific" value="${esc(S.ov.config.honorific)}" maxlength="20"></div></div>
      <div class="group-title" style="margin-top:18px">처음에 둘 부서 (나중에 언제든 바꿀 수 있어요)</div>
      ${groups.map((g) => `<div class="group-title">${esc(g)}</div><div class="chips">${presets.filter((p) => p.group === g).map((p) => `<label class="chip${def.has(p.key) ? ' on' : ''}"><input type="checkbox" name="preset" value="${esc(p.key)}" ${def.has(p.key) ? 'checked' : ''} hidden><span class="em">${esc(p.emoji)}</span><div><b>${esc(p.name)}</b><span>${esc(clip(p.role, 46))}</span></div></label>`).join('')}</div>`).join('')}</div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit">사무실 만들기</button></div></form>`);
}

function dlgImport(prefill = {}) {
  openDlg(`<form data-form="import-office"><div class="dlg-head"><h2>기존 사무실·봇 불러오기</h2><p>이미 쓰던 폴더를 등록합니다. 파일은 옮기거나 지우지 않습니다.</p></div>
    <div class="dlg-body"><div class="stack"><div class="field"><label>폴더 경로</label><input type="text" name="folder" required placeholder="C:\\Users\\내이름\\Desktop\\내사무실" value="${esc(prefill.folder || '')}"></div>
      <div class="formgrid"><div class="field"><label>이름 (선택)</label><input type="text" name="name" maxlength="40" value="${esc(prefill.name || '')}"></div>
      <div class="field"><label>종류</label><select name="kind"><option value="auto">자동 인식</option><option value="claude-office">Claude 사무실</option><option value="hermes">Hermes (읽기 전용)</option></select></div></div>
      <p class="small muted">Hermes(라피스 등) 별개의 봇은 <b>읽기 전용</b>으로만 인식합니다. 켜거나 끄거나 바꾸지 않습니다.</p></div></div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit">불러오기</button></div></form>`);
}

function dlgRelocate(prefill = '') {
  const o = cur();
  const cands = (o && o.moveCandidates) || [];
  openDlg(`<form data-form="relocate-office"><div class="dlg-head"><h2>사무실 위치 바꾸기</h2><p>폴더를 다른 드라이브·위치로 옮기셨다면 새 위치를 알려 주세요. 폴더 안 파일은 건드리지 않고, 출근 스크립트·텔레그램 연결 경로만 새 위치에 맞춥니다.</p></div>
    <div class="dlg-body"><div class="stack"><div class="field"><label>새 폴더 경로</label><input type="text" name="folder" required placeholder="F:\AI-Office" value="${esc(prefill || cands[0] || '')}" autofocus><span class="hint">지금 위치: ${esc(o ? o.folder : '')}</span></div>
      ${cands.length ? `<div class="small muted">자동으로 찾은 후보: ${cands.map((c) => `<a href="#" data-act="office-relocate-to" data-folder="${esc(c)}">${esc(c)}</a>`).join(', ')}</div>` : ''}
      <p class="small muted">근무 중이면 먼저 퇴근시킨 뒤 바꿔 주세요. 바꾼 뒤에는 새 위치에서 출근시키면 됩니다.</p></div></div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit">위치 바꾸기</button></div></form>`);
}

async function dlgTeamAdd(tab = 'preset') {
  const presets = await loadPresets();
  const d = S.detail;
  const have = new Set((d ? d.teams : []).map((t) => t.key));
  const groups = [...new Set(presets.map((p) => p.group))];
  const tabs = `<div class="dlg-tabs"><div class="tabs"><button class="${tab === 'preset' ? 'on' : ''}" data-act="team-add-tab" data-tab="preset">추천 부서에서 고르기</button><button class="${tab === 'custom' ? 'on' : ''}" data-act="team-add-tab" data-tab="custom">직접 만들기</button></div></div>`;
  const head = '<div class="dlg-head"><h2>부서 추가</h2><p>추가한 뒤 사무실을 다시 출근시키면 봇이 이 부서에 일을 맡길 수 있습니다.</p></div>';
  const foot = (label) => `<div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit">${label}</button></div>`;
  openDlg(head + tabs + (tab === 'preset'
    ? `<form data-form="team-add-preset"><div class="dlg-body">${groups.map((g) => `<div class="group-title">${esc(g)}</div><div class="chips">${presets.filter((p) => p.group === g).map((p) => `<label class="chip${have.has(p.key) ? ' disabled' : ''}"><input type="checkbox" name="preset" value="${esc(p.key)}" hidden ${have.has(p.key) ? 'disabled' : ''}><span class="em">${esc(p.emoji)}</span><div><b>${esc(p.name)}</b><span>${have.has(p.key) ? '이미 있음' : esc(clip(p.role, 46))}</span></div></label>`).join('')}</div>`).join('')}</div>${foot('선택한 부서 추가')}</form>`
    : `<form data-form="team-add-custom"><div class="dlg-body"><div class="formgrid"><div class="field"><label>부서 이름</label><input type="text" name="name" required maxlength="30" placeholder="예: 물류팀" autofocus></div><div class="field"><label>아이콘(이모지)</label><input type="text" name="emoji" maxlength="8" placeholder="🏷️"></div>
      <div class="field full"><label>담당 업무 (한 줄)</label><input type="text" name="role" required maxlength="200" placeholder="예: 배송 일정과 재고를 관리한다"></div>
      <div class="field full"><label>일하는 방식·지침 (선택)</label><textarea name="instructions" placeholder="- 결과는 표로 정리한다&#10;- 금액은 계산식을 함께 적는다"></textarea><span class="hint">봇이 이 부서에 일을 맡길 때 따를 규칙입니다. 나중에 고칠 수 있습니다.</span></div></div></div>${foot('부서 추가')}</form>`));
}

async function dlgTeamEdit(key) {
  const o = cur();
  const t = await api('GET', `/api/offices/${encodeURIComponent(o.id)}/teams/${encodeURIComponent(key)}`);
  openDlg(`<form data-form="team-edit" data-key="${esc(key)}"><div class="dlg-head"><h2>${esc(t.emoji)} ${esc(t.name)} 수정</h2><p class="mono">${esc(key)}</p></div>
    <div class="dlg-body"><div class="formgrid"><div class="field"><label>부서 이름</label><input type="text" name="name" required maxlength="30" value="${esc(t.name)}"></div><div class="field"><label>아이콘(이모지)</label><input type="text" name="emoji" maxlength="8" value="${esc(t.emoji)}"></div>
      <div class="field full"><label>담당 업무 (한 줄)</label><input type="text" name="role" required maxlength="200" value="${esc(t.role)}"></div>
      <div class="field full"><label>일하는 방식·지침</label><textarea name="instructions" style="min-height:190px">${esc(t.instructions || '')}</textarea>${t.managed === false ? '<span class="hint">직접 쓴 에이전트 파일의 본문입니다. 저장하면 원본을 보관함에 백업합니다.</span>' : ''}</div></div></div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn primary" type="submit">저장</button></div></form>`);
}

async function dlgDiagnose() {
  openDlg('<div class="dlg-head"><h2>Claude 진단 정보</h2><p>확인하는 중입니다…</p></div>');
  let d;
  try { d = await api('GET', '/api/claude/diagnose'); } catch (e) { openDlg(`<div class="dlg-head"><h2>Claude 진단 정보</h2><p>${esc(e.message)}</p></div><div class="dlg-foot"><button class="btn" data-act="dlg-close">닫기</button></div>`); return; }
  const L = [];
  L.push(`사용자: ${d.user}   홈: ${d.home}`, `Node ${d.node} / ${d.platform}`, '');
  L.push(`Claude Code: ${d.bin ? `${d.bin.path}  (버전 ${d.bin.version})` : '실행 가능한 파일 없음'}`);
  if (d.broken) L.push(`실행 실패: ${d.broken.path} → ${d.broken.error}`);
  L.push(`후보 경로: ${d.candidates.length ? d.candidates.join('  |  ') : '없음'}`, '');
  L.push(`CLAUDE_CONFIG_DIR: ${d.claudeConfigDirEnv}`, `ANTHROPIC_API_KEY: ${d.envKeys.ANTHROPIC_API_KEY} / ANTHROPIC_AUTH_TOKEN: ${d.envKeys.ANTHROPIC_AUTH_TOKEN} / CLAUDE_CODE_OAUTH_TOKEN: ${d.envKeys.CLAUDE_CODE_OAUTH_TOKEN}`);
  if (d.status) {
    L.push('', `claude auth status → 종료 코드 ${d.status.exitCode}${d.status.timedOut ? ' (시간 초과)' : ''}`, d.status.stdout || '(출력 없음)');
    if (d.status.stderr) L.push(`[오류 출력] ${d.status.stderr}`);
    L.push('', `설정 폴더: ${d.configDir} (${d.configDirExists ? '있음' : '없음'})   로그인 파일: ${d.credentialsFile}`);
  }
  const text = L.join('\n');
  openDlg(`<div class="dlg-head"><h2>Claude 진단 정보</h2><p>로그인이 안 잡힐 때 원인을 찾는 정보입니다. 비밀번호·토큰은 포함되지 않습니다.</p></div>
    <div class="dlg-body"><pre class="mono" style="white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:55vh;overflow:auto;user-select:text">${esc(text)}</pre></div>
    <div class="dlg-foot"><button class="btn" id="diagCopy">복사</button><button class="btn primary" data-act="dlg-close">닫기</button></div>`);
  $('#diagCopy').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('복사했습니다.'); } catch { toast('복사하지 못했습니다. 드래그해서 복사해 주세요.', true); } };
}

function dlgConfirm({ title, body, ok = '확인', danger = false, onOk }) {
  openDlg(`<div class="dlg-head"><h2>${esc(title)}</h2><p>${body}</p></div><div class="dlg-foot"><button class="btn" data-act="dlg-close">취소</button><button class="btn ${danger ? 'danger' : 'primary'}" id="confirmOk">${esc(ok)}</button></div>`);
  $('#confirmOk').onclick = async (e) => { e.target.disabled = true; await onOk(); closeDlg(); };
}

// 봇 삭제: 이름을 똑같이 입력해야 버튼이 눌린다(실수 방지). 이 프로그램이 만든 사무실은 폴더를 보관 위치로 옮기고, 불러온 폴더·Hermes 는 파일을 그대로 둔다.
function dlgRemoveOffice() {
  const o = cur();
  if (!o) return;
  const closing = o.removeKind === 'close';
  const stops = !o.readonly && o.running ? '지금 근무 중이라 먼저 퇴근시킵니다(진행 중인 업무는 중단됩니다). ' : '';
  openDlg(`<form data-form="office-remove"><div class="dlg-head"><h2>「${esc(o.name)}」 봇을 삭제할까요?</h2>
    <p>${stops}${closing
      ? `목록에서 사라지고 텔레그램 봇 연결도 끊어집니다. 폴더는 지우지 않고 <code>${esc(S.ov.app.dataHome)}\\closed</code> 로 옮겨 두므로, 필요하면 「기존 폴더 불러오기」로 되살릴 수 있습니다.`
      : `이 프로그램의 목록에서만 없어집니다. <b>폴더와 파일은 그대로</b> 두므로(${esc(o.folder)}), 필요하면 「기존 폴더 불러오기」로 다시 등록할 수 있습니다.`}</p></div>
    <div class="dlg-body"><div class="field"><label>확인을 위해 이름을 입력하세요</label><input type="text" name="confirm" autocomplete="off" placeholder="${esc(o.name)}" data-want="${esc(o.name)}"></div></div>
    <div class="dlg-foot"><button class="btn" type="button" data-act="dlg-close">취소</button><button class="btn danger" type="submit" id="removeOk" disabled>삭제하기</button></div></form>`);
  const input = $('#dlg input[name=confirm]');
  input.addEventListener('input', () => { $('#removeOk').disabled = input.value.trim() !== o.name; });
}

// 업데이트: 설치를 시키고, 서버가 새 버전으로 다시 뜰 때까지 기다렸다가 화면을 새로 고친다.
function dlgUpdate() {
  const u = S.ov && S.ov.update;
  if (!u || !u.latest) return;
  dlgConfirm({ title: `v${u.latest.version} 으로 업데이트할까요?`, body: `지금은 v${esc(u.current)} 입니다. 새 파일을 내려받아 교체하고 대시보드를 <b>잠시(약 10초) 다시 시작</b>합니다. 사무실(봇)은 끄지 않고, 이전 버전은 백업해 둡니다.`, ok: '업데이트', onOk: async () => {
    try {
      await api('POST', '/api/update/apply');
      toast('업데이트했습니다. 대시보드를 다시 시작하는 중…');
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try { const p = await api('GET', '/api/ping'); if (p.version === u.latest.version) { location.reload(); return; } } catch { /* 다시 뜨는 중 */ }
      }
      toast('대시보드가 다시 뜨지 않으면 바탕화면의 AI-Office 바로가기를 다시 눌러 주세요.', true);
    } catch (e) { toast(e.message, true); }
  } });
}

// ── 동작 ──
const lg = (action, body = {}) => api('POST', `/api/offices/${oid()}/telegram/legacy/${action}`, body);
const refresh = async () => { S.last = ''; await tick(); };
const oid = () => encodeURIComponent(S.officeId);

const ACT = {
  'dlg-close': () => closeDlg(),
  'new-office': () => dlgNewOffice(),
  'import-office': () => dlgImport(),
  'import-found': (b) => { const f = S.found[Number(b.dataset.i)]; if (f) dlgImport(f); },
  'select-office': (b) => { S.officeId = b.dataset.id; localStorage.setItem('office', S.officeId); refresh(); },
  'claude-login': (b) => doing(b, async () => { await api('POST', '/api/claude/login', { method: 'claudeai' }); toast('로그인 창을 열었습니다. 브라우저에서 로그인한 뒤 「다시 확인」을 눌러 주세요.'); }),
  'claude-login-console': (b) => doing(b, async () => { await api('POST', '/api/claude/login', { method: 'console' }); toast('로그인 창을 열었습니다. 로그인한 뒤 「다시 확인」을 눌러 주세요.'); }),
  'claude-logout': (b) => dlgConfirm({ title: 'Claude 로그아웃', body: '이 PC의 Claude Code에서 로그아웃합니다. 실행 중인 사무실은 다시 로그인할 때까지 일하지 못합니다.', ok: '로그아웃', danger: true, onOk: async () => { try { await api('POST', '/api/claude/logout'); toast('로그아웃했습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
  'claude-diagnose': () => dlgDiagnose(),
  'claude-refresh': (b) => doing(b, async () => { await api('POST', '/api/claude/refresh'); await refresh(); toast('계정 상태를 다시 확인했습니다.'); }),
  'claude-install': (b) => doing(b, async () => { await api('POST', '/api/claude/install'); toast('설치 창을 열었습니다. 설치가 끝나면 「다시 확인」을 눌러 주세요.'); }),
  'office-start': (b) => doing(b, async () => { await api('POST', `/api/offices/${oid()}/start`); toast('출근시켰습니다. 처음에는 작업 표시줄의 사무실 창에서 폴더 신뢰 질문에 Enter(Yes)를 눌러야 할 수 있습니다.'); S.restartNeeded[S.officeId] = false; setTimeout(refresh, 2500); }),
  'office-stop': (b) => dlgConfirm({ title: '퇴근시킬까요?', body: '사무실을 끕니다. 진행 중인 업무가 있으면 중단됩니다.', ok: '퇴근시키기', danger: true, onOk: async () => { try { await api('POST', `/api/offices/${oid()}/stop`); toast('퇴근시켰습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
  'office-restart': (b) => doing(b, async () => { await api('POST', `/api/offices/${oid()}/restart`); S.restartNeeded[S.officeId] = false; toast('잠시 뒤 다시 출근합니다.'); setTimeout(refresh, 3000); }),
  'office-open': (b) => doing(b, () => api('POST', `/api/offices/${oid()}/open`)),
  'open-data': (b) => doing(b, () => api('POST', '/api/open-data')),
  'office-remove': () => dlgRemoveOffice(),
  'hermes-mode': (b) => doing(b, async () => { const mode = b.dataset.mode; await api('PATCH', `/api/offices/${oid()}`, { mode }); toast(mode === 'office' ? '사무실용으로 바꿨어요. 이제 켜고 끌 수 있어요.' : '읽기 전용으로 바꿨어요. 이제 보기만 해요.'); await refresh(); }),
  'update-check': (b) => doing(b, async () => { const u = await api('POST', '/api/update/check'); await refresh(); toast(u.error || (u.available ? `새 버전 v${u.latest.version} 이(가) 있습니다.` : '지금이 최신 버전입니다.'), Boolean(u.error)); }),
  'update-apply': () => dlgUpdate(),
  'office-relocate': () => dlgRelocate(),
  'drive-add': () => dlgDriveAdd(),
  'drive-revoke': (b) => dlgConfirm({ title: '드라이브 접근을 거둘까요?', body: `<code>${esc(b.dataset.path)}</code> 에 맡긴 권한을 거둡니다. 이미 한 작업은 그대로입니다.`, ok: '해제', danger: true, onOk: async () => { try { const r = await api('DELETE', `/api/offices/${oid()}/drives`, { path: b.dataset.path }); if (r.needsRestart) S.restartNeeded[S.officeId] = true; toast('거뒀습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
  'office-relocate-to': (b) => doing(b, async () => { const r = await api('POST', `/api/offices/${oid()}/relocate`, { folder: b.dataset.folder }); closeDlg(); toast(`사무실 위치를 바꿨습니다: ${r.folder}`); await refresh(); }),
  'office-migrate': () => dlgConfirm({ title: '고정 위치로 옮길까요?', body: '사무실 폴더를 고정 위치로 <b>복사</b>하고, 이후 새 위치를 사용합니다. 원본은 그대로 남습니다.', ok: '옮기기', onOk: async () => { try { const r = await api('POST', `/api/offices/${oid()}/migrate`); toast(`옮겼습니다: ${r.to}`); } catch (e) { toast(e.message, true); } refresh(); } }),
  'team-add': () => dlgTeamAdd('preset'),
  'team-add-tab': (b) => dlgTeamAdd(b.dataset.tab),
  'team-edit': (b) => doing(b, () => dlgTeamEdit(b.dataset.key)),
  'team-remove': (b) => { const t = S.detail.teams.find((x) => x.key === b.dataset.key); dlgConfirm({ title: `${t.name}을(를) 없앨까요?`, body: '부서 파일은 지우지 않고 <code>보관함/부서보관</code> 폴더로 옮겨 둡니다.', ok: '없애기', danger: true, onOk: async () => { try { const r = await api('DELETE', `/api/offices/${oid()}/teams/${encodeURIComponent(t.key)}`); if (r.needsRestart) S.restartNeeded[S.officeId] = true; toast(`${t.name}을(를) 없앴습니다.`); } catch (e) { toast(e.message, true); } refresh(); } }); },
  'tg-token-clear': () => dlgConfirm({ title: '봇 토큰을 지울까요?', body: '저장된 토큰을 지웁니다. 다시 연결하려면 토큰을 새로 넣어야 합니다.', ok: '지우기', danger: true, onOk: async () => { try { await api('DELETE', `/api/offices/${oid()}/telegram/token`); toast('토큰을 지웠습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
  'tg-pair': (b) => doing(b, async () => { const r = await api('POST', `/api/offices/${oid()}/telegram/pair`, { code: b.dataset.code }); toast(`허용했습니다 (${r.senderId})`); refresh(); }),
  'tg-deny': (b) => doing(b, async () => { await api('POST', `/api/offices/${oid()}/telegram/deny`, { code: b.dataset.code }); refresh(); }),
  'tg-remove': (b) => doing(b, async () => { await api('POST', `/api/offices/${oid()}/telegram/remove`, { senderId: b.dataset.id }); toast('허용을 해제했습니다.'); refresh(); }),
  'lr-refresh': (b) => doing(b, async () => { await lg('refresh'); toast('방 이름과 봇 권한을 텔레그램에서 새로 확인했습니다.'); await refresh(); }),
  'lr-link': (b) => doing(b, async () => { await lg('link', { room: b.dataset.room }); toast('업무방으로 연결했습니다. 허용된 계정의 메시지만 비서실장에게 전달됩니다.'); await refresh(); }),
  'lr-unlink': (b) => dlgConfirm({ title: '이 방 연결을 해제할까요?', body: '이 방의 메시지가 더 이상 비서실장에게 가지 않습니다. 방과 주제 설정은 남습니다.', ok: '연결 해제', danger: true, onOk: async () => { try { await lg('unlink', { room: b.dataset.room }); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
  'lr-topic': (b) => {
    const room = b.dataset.room, input = document.querySelector('input[data-new="' + CSS.escape(room) + '"]'), sel = document.querySelector('select[data-newteam="' + CSS.escape(room) + '"]');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    return doing(b, async () => { const r = await lg('topic', { room, name, team: sel.value }); toast('주제를 만들었습니다: ' + r.result.name + (r.result.teamName ? ' → ' + r.result.teamName : '')); input.value = ''; await refresh(); });
  },
  'lr-trigger': (b) => doing(b, async () => { const v = document.getElementById('lr-trg-' + b.dataset.room).value.trim(); await lg('options', { room: b.dataset.room, options: { trigger: v } }); toast(v ? '이제 "' + v + '"로 시작하는 메시지만 비서실장이 받습니다.' : '기호 없이 내 메시지를 모두 받습니다.'); await refresh(); }),
  'lr-rt-test': (b) => doing(b, async () => { await lg('routinetest', { id: b.dataset.id }); toast('30초 안에 비서실장이 시험 보고를 작성해 올립니다.'); await refresh(); }),
  'room-refresh': (b) => doing(b, async () => { const r = await api('POST', `/api/offices/${oid()}/telegram/rooms/refresh`); toast(`방 ${r.checked}곳의 상태를 텔레그램에서 확인했습니다.`); refresh(); }),
  'room-connect': (b) => doing(b, async () => { await api('POST', `/api/offices/${oid()}/telegram/rooms/connect`, { chatId: b.dataset.chat }); toast('방을 연결했습니다. 방에서 @봇을 멘션하면 응답합니다.'); refresh(); }),
  'room-disconnect': (b) => dlgConfirm({ title: '이 방 연결을 해제할까요?', body: '봇이 이 방의 메시지를 더 이상 받지 않습니다. 봇은 방에 남아 있고, 업무 기록도 그대로입니다. 다시 연결할 수 있습니다.', ok: '연결 해제', danger: true, onOk: async () => { try { await api('POST', `/api/offices/${oid()}/telegram/rooms/disconnect`, { chatId: b.dataset.chat }); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
  'room-forget': (b) => doing(b, async () => { await api('POST', `/api/offices/${oid()}/telegram/rooms/forget`, { chatId: b.dataset.chat }); toast('목록에서 지웠습니다.'); refresh(); }),
  'diag-refresh': (b) => doing(b, async () => { await api('POST', '/api/diagnostics/refresh'); refresh(); }),
  'diag-clean': (b) => dlgConfirm({ title: '가로채는 프로세스를 정리할까요?', body: '사무실이 아닌 곳에서 텔레그램 수신을 잡고 있는 프로세스만 종료합니다. 그 Claude 창의 텔레그램 기능만 꺼지고, 창 자체는 그대로입니다.', ok: '정리하기', onOk: async () => { try { const r = await api('POST', '/api/diagnostics/clean-pollers'); toast(`${r.rogue}개를 정리했습니다.`); } catch (e) { toast(e.message, true); } refresh(); } }),
  'market-tab': (b) => { S.marketTab = b.dataset.tab; localStorage.setItem('marketTab', S.marketTab); paint(true); },
  'market-refresh': (b) => doing(b, async () => { const r = await api('POST', '/api/market/refresh'); toast(`마켓을 새로 불러왔습니다 (스킬 ${r.entries}개)`); await markMarket(); }),
  'market-detail': (b) => dlgMarketDetail(b.dataset.id),
  'market-publish': (b) => dlgPublish(b.dataset.office, b.dataset.skill),
  'market-publish-all': (b) => doing(b, () => dlgPublishAll(b.dataset.office)),
  'market-update': (b) => doing(b, async () => { await marketInstall(b.dataset.id, b.dataset.office, false, false); await markMarket(); }),
  'market-uninstall': (b) => dlgConfirm({ title: '이 스킬을 제거할까요?', body: '사무실의 스킬 폴더에서 <b>보관함/스킬제거</b> 로 옮깁니다(지우지 않습니다). 다시 받으려면 마켓에서 설치하면 됩니다.', ok: '제거', danger: true, onOk: async () => { try { const r = await api('POST', '/api/market/uninstall', { office: b.dataset.office, id: b.dataset.id }); if (r.needsRestart) S.restartNeeded[b.dataset.office] = true; toast('제거했습니다. 사무실을 다시 출근시키면 적용됩니다.'); } catch (e) { toast(e.message, true); } markMarket(); } }),
  'market-revoke': (b) => dlgConfirm({ title: '마켓에서 회수할까요?', body: `이 스킬을 마켓에서 내립니다. 이미 설치한 PC에는 “회수됨” 경고가 표시되고 새로 설치할 수 없게 됩니다. (내 PC의 스킬 파일은 그대로입니다)<div class="field" style="margin-top:10px"><label>회수 사유 (선택)</label><input type="text" id="revokeReason" maxlength="200" placeholder="예: 개인정보가 들어 있었음"></div>`, ok: '회수', danger: true, onOk: async () => { try { await api('POST', '/api/market/revoke', { id: b.dataset.id, reason: ($('#revokeReason') || {}).value || '' }); toast('회수했습니다.'); } catch (e) { toast(e.message, true); } markMarket(); } }),
  'market-req-dismiss': (b) => dlgConfirm({ title: '이 게시 요청을 거절할까요?', body: '스킬은 마켓에 올라가지 않습니다. 요청 메모는 지우지 않고 사무실의 <b>보관함/마켓요청_처리</b> 로 옮깁니다.', ok: '거절', onOk: async () => { try { await api('POST', '/api/market/requests/dismiss', { office: b.dataset.office, skillId: b.dataset.skill }); toast('요청을 거절했습니다.'); } catch (e) { toast(e.message, true); } markMarket(); } }),
  'market-disconnect': () => dlgConfirm({ title: '스킬 마켓 연결을 해제할까요?', body: '이 PC에서 마켓을 끕니다. 이미 설치한 스킬과 저장소의 게시 내용은 그대로 남습니다. 다시 연결하면 바로 쓸 수 있습니다.', ok: '연결 해제', danger: true, onOk: async () => { try { await api('POST', '/api/market/disconnect', { purge: true }); toast('연결을 해제했습니다.'); } catch (e) { toast(e.message, true); } S.market = null; markMarket(); } }),
  'diag-global-off': () => dlgConfirm({ title: '전역에서 텔레그램 플러그인을 끌까요?', body: '사용자 설정(<code>~/.claude/settings.json</code>)에서 텔레그램 플러그인을 끕니다. 원본은 <code>settings.json.bak-ai-office</code> 로 백업하고, 사무실 폴더의 설정은 그대로라 사무실은 계속 텔레그램을 받습니다.', ok: '끄기', onOk: async () => { try { await api('POST', '/api/diagnostics/disable-global-plugin'); toast('전역에서 껐습니다.'); } catch (e) { toast(e.message, true); } refresh(); } }),
};

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { navigate(go.dataset.go); return; }
  const chip = e.target.closest('label.chip');
  if (chip) { const cb = chip.querySelector('input[type=checkbox]'); if (cb && !cb.disabled) { e.preventDefault(); cb.checked = !cb.checked; chip.classList.toggle('on', cb.checked); } return; }
  const b = e.target.closest('[data-act]');
  if (b && ACT[b.dataset.act]) { e.preventDefault(); ACT[b.dataset.act](b); }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'officeSel') { S.officeId = el.value; localStorage.setItem('office', S.officeId); refresh(); return; }
  if (el.dataset.change === 'autostart') { const ok = await doing(null, () => api('PATCH', `/api/offices/${oid()}`, { autoStart: el.checked })); if (!ok) el.checked = !el.checked; else refresh(); }
  if (el.dataset.change === 'autoupdate') { const ok = await doing(null, () => api('PATCH', '/api/config', { autoUpdate: el.checked })); if (!ok) el.checked = !el.checked; else { toast(el.checked ? '새 버전이 확인되면 자동으로 설치합니다.' : '새 버전은 알림만 띄웁니다.'); refresh(); } return; }
  if (el.dataset.change === 'room-dept') {   // 고른 부서를 업무 칸에 채워 넣는다(저장은 직접)
    const ta = el.closest('form').querySelector('textarea');
    if (el.value) { ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + el.value; ta.focus(); }
    el.value = '';
    return;
  }
  if (el.dataset.change === 'lr-assign') { const r = await doing(null, () => lg('assign', { room: el.dataset.room, topic: el.dataset.topic, team: el.value })); if (r) toast('"' + r.result.name + '" 담당: ' + (r.result.teamName || '없음')); else refresh(); return; }
  if (el.dataset.change === 'lr-mention') { const ok = await doing(null, () => lg('options', { room: el.dataset.room, options: { requireMention: el.checked } })); if (!ok) el.checked = !el.checked; return; }
  if (el.dataset.change === 'lr-confirm') { const ok = await doing(null, () => lg('options', { room: el.dataset.room, options: { confirmPosts: el.checked } })); if (!ok) el.checked = !el.checked; return; }
  if (el.dataset.change === 'lr-rt-target') { if (!el.value) return; const r = await doing(null, () => lg('routinetarget', JSON.parse(el.value))); if (r) { toast('정기 보고를 "' + r.result.room + (r.result.topic ? ' › ' + r.result.topic : '') + '"로 받습니다.'); refresh(); } return; }
  if (el.dataset.change === 'lr-rt-time') { const r = await doing(null, () => lg('routinetime', { id: el.dataset.id, time: el.value })); if (r) { toast('시각을 ' + el.value + '로 바꿨습니다.'); refresh(); } return; }
  if (el.dataset.change === 'lr-rt-on') { const ok = await doing(null, () => lg('routinetime', { id: el.dataset.id, enabled: el.checked })); if (!ok) el.checked = !el.checked; else refresh(); return; }
  if (el.dataset.change === 'tg-policy') { await doing(null, () => api('POST', `/api/offices/${oid()}/telegram/policy`, { mode: el.value })); toast('저장했습니다.'); refresh(); }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fd = new FormData(f);
  const btn = f.querySelector('button[type=submit]');
  const kind = f.dataset.form;
  await doing(btn, async () => {
    if (kind === 'tg-token') { const r = await api('POST', `/api/offices/${oid()}/telegram/token`, { token: fd.get('token') }); f.reset(); toast(`@${r.username} 봇을 연결했습니다.`); }
    else if (kind === 'room-task') {
      const r = await api('POST', `/api/offices/${oid()}/telegram/rooms/task`, { chatId: f.dataset.chat, threadId: f.dataset.thread || null, task: fd.get('task') });
      toast(r.task ? '업무를 저장했습니다. 바로 적용됩니다.' : '업무를 해제했습니다.'); refresh();
    } else if (kind === 'room-default-task') {
      const r = await api('POST', `/api/offices/${oid()}/telegram/rooms/default-task`, { task: fd.get('task') });
      toast(r.defaultTask ? '기본 업무를 저장했습니다.' : '기본 업무를 해제했습니다.'); refresh();
    } else if (kind === 'tg-pair') { const r = await api('POST', `/api/offices/${oid()}/telegram/pair`, { code: fd.get('code') }); f.reset(); toast(`허용했습니다 (${r.senderId})`); }
    else if (kind === 'config') {
      await api('PATCH', '/api/config', { honorific: fd.get('honorific'), theme: fd.get('theme'), port: Number(fd.get('port')), autoRestart: fd.get('autoRestart') === 'on' });
      S.themePref = fd.get('theme'); localStorage.setItem('theme', S.themePref); applyTheme(); toast('저장했습니다.');
    } else if (kind === 'office-remove') {
      const r = await api('POST', `/api/offices/${oid()}/remove`, { confirmName: fd.get('confirm') });
      S.officeId = ''; localStorage.removeItem('office'); closeDlg(); toast(r.kind === 'closed' ? `「${r.name}」 봇을 삭제했습니다. 폴더는 보관 위치로 옮겨 뒀어요.` : `「${r.name}」 봇을 목록에서 삭제했습니다. 폴더와 파일은 그대로예요.`);
    } else if (kind === 'drive-add') {
      const r = await api('POST', `/api/offices/${oid()}/drives`, { path: fd.get('path'), level: fd.get('level'), confirmDelete: fd.get('confirmDelete') === 'on' });
      if (r.needsRestart) S.restartNeeded[S.officeId] = true;
      closeDlg(); toast(`맡겼습니다: ${r.grant.path}`);
    } else if (kind === 'relocate-office') {
      const r = await api('POST', `/api/offices/${oid()}/relocate`, { folder: fd.get('folder') });
      closeDlg(); toast(`사무실 위치를 바꿨습니다: ${r.folder}`);
    } else if (kind === 'new-office') {
      const o = await api('POST', '/api/offices', { name: fd.get('name'), honorific: fd.get('honorific'), presets: fd.getAll('preset') });
      S.officeId = o.id; localStorage.setItem('office', o.id); closeDlg(); toast(`「${o.name}」 사무실을 만들었습니다. 이제 봇을 연결해 볼까요?`); navigate('home');
    } else if (kind === 'import-office') {
      const o = await api('POST', '/api/offices/import', { folder: fd.get('folder'), name: fd.get('name'), kind: fd.get('kind') });
      S.officeId = o.id; localStorage.setItem('office', o.id); S.found = null; closeDlg(); toast(`「${o.name}」을(를) 불러왔습니다.`);
    } else if (kind === 'team-add-preset') {
      const keys = fd.getAll('preset');
      if (!keys.length) throw new Error('추가할 부서를 하나 이상 골라 주세요.');
      let restart = false;
      for (const k of keys) { const r = await api('POST', `/api/offices/${oid()}/teams`, { preset: k }); restart = restart || r.needsRestart; }
      if (restart) S.restartNeeded[S.officeId] = true;
      closeDlg(); toast(`${keys.length}개 부서를 추가했습니다.`);
    } else if (kind === 'team-add-custom') {
      const r = await api('POST', `/api/offices/${oid()}/teams`, { name: fd.get('name'), emoji: fd.get('emoji'), role: fd.get('role'), instructions: fd.get('instructions') });
      if (r.needsRestart) S.restartNeeded[S.officeId] = true;
      closeDlg(); toast(`${r.team.name}을(를) 추가했습니다.`);
    } else if (kind === 'team-edit') {
      const r = await api('PATCH', `/api/offices/${oid()}/teams/${encodeURIComponent(f.dataset.key)}`, { name: fd.get('name'), emoji: fd.get('emoji'), role: fd.get('role'), instructions: fd.get('instructions') });
      if (r.needsRestart) S.restartNeeded[S.officeId] = true;
      closeDlg(); toast('저장했습니다.');
    } else if (kind === 'market-connect') {
      const r = await api('POST', '/api/market/connect', { repo: fd.get('repo'), alias: fd.get('alias') });
      S.marketTab = 'browse'; S.marketDirty = true;
      toast(r.visibility === 'public' ? '⚠️ 연결했지만 이 저장소는 공개(public)입니다. 비공개로 바꾸는 것을 권합니다.' : `마켓에 연결했습니다 (스킬 ${r.entries}개)`, r.visibility === 'public');
    } else if (kind === 'market-install') {
      await marketInstallMany(f.dataset.id, fd.getAll('office'), fd.get('allowRisk') === 'on');
      S.marketDirty = true;
    } else if (kind === 'market-publish-all') {
      await publishAllSubmit(f, fd);
    } else if (kind === 'market-publish') {
      const r = await api('POST', '/api/market/publish', { office: f.dataset.office, skillId: f.dataset.skill, version: fd.get('version'), notes: fd.get('notes'), confirmWarnings: fd.get('cw') === 'on', confirmRisks: fd.get('cr') === 'on' });
      closeDlg(); S.marketDirty = true; toast(`v${r.version} 을(를) 마켓에 게시했습니다.`);
    }
    await refresh();
  });
});

// 마켓 검색: 다시 그리지 않고 카드만 숨겨서 입력 중에도 커서가 유지된다.
document.addEventListener('input', (e) => {
  if (e.target.dataset && e.target.dataset.filter === 'market') {
    S.marketQuery = e.target.value;
    const q = S.marketQuery.trim().toLowerCase();
    document.querySelectorAll('.mk-card').forEach((c) => { c.hidden = Boolean(q) && !c.dataset.text.includes(q); });
  }
});

function navigate(view) {
  if (!VIEWS[view]) view = 'home';
  S.view = view; location.hash = view; document.body.classList.remove('menu-open');
  if (view === 'market') S.marketDirty = true;
  paint(true); tick();
}
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (VIEWS[v] && v !== S.view) navigate(v); });
$('#newOffice').addEventListener('click', () => dlgNewOffice());
$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('menu-open'));
$('#scrim').addEventListener('click', () => document.body.classList.remove('menu-open'));
$('#themeBtn').addEventListener('click', () => { S.themePref = { auto: 'light', light: 'dark', dark: 'auto' }[S.themePref] || 'auto'; localStorage.setItem('theme', S.themePref); applyTheme(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
$('#content').addEventListener('focusout', () => setTimeout(() => { if (!$('#content').contains(document.activeElement)) paint(true); }, 50));

applyTheme();
if (!VIEWS[S.view]) S.view = 'home';
tick().then(async () => {
  try { S.found = await api('GET', '/api/discover'); paint(true); } catch { }
  if (S.ov && !S.ov.offices.length && !S.found?.length) dlgNewOffice();
});
setInterval(tick, 3000);
