// Claude Office 화면 코드(app.js · style.css)를 통합 화면용으로 변환해 web/office.js · web/office.css 를 만든다.
// 원본은 건드리지 않는다. 변환 규칙 중 하나라도 원본에서 찾지 못하면(Office 가 바뀐 경우) 멈추고 알린다.
// 사용: node scripts/build-office-ui.mjs [Office 폴더]   (기본: OFFICE_SRC 환경변수, 없으면 설치된 AI-Office)
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const source=resolve(process.argv[2]||process.env.OFFICE_SRC||join(process.env.LOCALAPPDATA||'','AI-Office/app'));
const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
const serverSrc=await readFile(join(source,'src/server.mjs'),'utf8');
let js=await readFile(join(source,'web/app.js'),'utf8');
let css=await readFile(join(source,'web/style.css'),'utf8');

function swap(label,from,to,{all=false}={}){
  const hit=typeof from==='string'?js.includes(from):from.test(js);
  if(!hit)throw new Error('Office 코드가 바뀌어 변환 규칙을 적용하지 못했습니다: '+label);
  js=all?js.replaceAll(from,()=>to):js.replace(from,()=>to);
}

// ── 통신: 통합 서버의 /office 경로로, 통합 화면이 보낸 요청임을 표시 ──
swap('fetch',"const res = await fetch(path, {","const res = await fetch('/office' + path, {");
swap('header',"'x-ai-office': '1' }","'x-ai-office': '1', 'x-lapis-request': '1' }");
swap('office default',"localStorage.getItem('office') || ''","localStorage.getItem('office') || 'ai-office'");

// ── 라우팅은 통합 화면이 맡는다 ──
swap('initial view',"view: (location.hash || '#home').slice(1),","view: 'home',");
swap('themeDefault',"localStorage.getItem('theme') || 'auto'","localStorage.getItem('theme') || 'light'");
swap('theme cycle',"{ auto: 'light', light: 'dark', dark: 'auto' }[S.themePref] || 'auto'","{ auto: 'dark', light: 'dark', dark: 'light' }[S.themePref] || 'light'");
swap('auto theme',"r.removeAttribute('data-theme');","r.setAttribute('data-theme', 'auto');");

// 화면 이름(메뉴)은 통합 화면의 사이드바가 그린다: Office 쪽은 내용·배지 숫자만 알려 준다.
swap('title',"  $('#title').textContent = (VIEWS[S.view] || VIEWS.home).title;\n","");
swap('nav',/  \$\('#nav'\)\.innerHTML = Object\.keys\(VIEWS\)\.map\(\(k\) => \{[\s\S]*?\}\)\.join\(''\);\n/,
`  const chrome = {
    teams: o && !o.readonly ? o.teamsCount : null, skills: offices().length,
    market: marketUpdates() + marketRequests(), connectFlag: Boolean(needs.connect), drives: (S.detail && S.detail.drives || []).length, ok: S.ok };
  window.__officeChrome = chrome; document.dispatchEvent(new CustomEvent('office:chrome', { detail: chrome }));
`);

// 내용 영역: 홈은 통합 홈 안의 칸에, 나머지는 사무실 영역에 그린다.
swap('content render',"  const el = $('#content');\n  if (!S.ov) {","  const el = contentEl();\n  if (!S.ov) {");
swap('view table',"{ home: vHome, board: vBoard, teams: vTeams, skills: vSkills, market: vMarket, connect: vConnect, settings: vSettings }","{ home: vHome, board: vBoard, teams: vTeams, skills: vSkills, market: vMarket, connect: vConnect, settings: vSettings, drive: vDrive }");
swap('typing check',"a && $('#content').contains(a)","a && contentEl().contains(a)");
swap('focusout',"$('#content').addEventListener('focusout', () => setTimeout(() => { if (!$('#content').contains(document.activeElement)) paint(true); }, 50));",
"document.addEventListener('focusout', () => setTimeout(() => { if (!contentEl().contains(document.activeElement)) paint(true); }, 50));");
swap('navigate',/function navigate\(view\) \{[\s\S]*?\n\}\nwindow\.addEventListener\('hashchange'.*\n/,
`function navigate(view) { location.hash = '#' + view; }
function setView(view) {
  S.view = VIEWS[view] ? view : 'home';
  if (S.view === 'market') S.marketDirty = true;
  paint(true); tick();
}
const contentEl = () => $(S.view === 'home' ? '#home-office' : '#office-content');
window.__office = { setView, refresh: () => tick(), select: (id) => { S.officeId = id; localStorage.setItem('office', id); paint(true); tick(); } };
`);
swap('menu',"$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('menu-open'));\n","");
swap('scrim',"$('#scrim').addEventListener('click', () => document.body.classList.remove('menu-open'));\n","");

// ── Office 본체가 꺼져 있거나 없을 때: 계속 '불러오는 중'으로 두지 않고 이유와 해결 방법을 알려 준다 ──
swap('tried flag',"  } catch { S.ok = false; }","  } catch { S.ok = false; S.tried = true; }");
swap('tried success',"    S.ov = ov; S.ok = true;","    S.ov = ov; S.ok = true; S.tried = true;");
swap('offline message',"  if (!S.ov) { el.innerHTML = '<div class=\"empty\"><div class=\"big\">⏳</div><b>불러오는 중…</b></div>'; return; }",
"  if (!S.ov) { el.innerHTML = S.tried ? '<div class=\"card\"><div class=\"empty\"><div class=\"big\">🔌</div><b>Claude Office 본체에 연결되지 않았어요</b><p>사무실 기능(현황판·부서·스킬·마켓·드라이브)은 Claude Office가 켜져 있을 때 쓸 수 있어요. Office를 다시 켜면 이 화면이 자동으로 이어집니다. 백업해 둔 Office는 Documents 폴더의 LAPIS_백업 폴더의 「복원.ps1」로 되돌릴 수 있어요.</p></div></div>' : '<div class=\"empty\"><div class=\"big\">⏳</div><b>불러오는 중…</b></div>'; return; }");

// ── 화면 색상: 통합 화면은 밝은 하늘색 / 어두운 블랙 두 가지 ──
swap('view list',"  settings: { title: '설정',","  drive: { title: '드라이브', icon: '<ellipse cx=\"12\" cy=\"6\" rx=\"8\" ry=\"3\"/><path d=\"M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6\"/>' },\n  settings: { title: '설정',");

swap('paint signature',"S.market, S.marketTab]);","S.market, S.marketTab, S.driveUsage, S.tried]);");
// ── 드라이브: 설정 안의 한 줄이던 것을 독립 화면으로 ──
swap('settings drives',"      ${hermes ? '' : vDrives()}\n","");
swap('drive dlg signature',"function dlgDriveAdd() {","function dlgDriveAdd(prefill = 'D:\\\\') {");
swap('drive dlg value','placeholder="D:\\\\" value="D:\\\\" autofocus','placeholder="D:\\\\" value="${esc(prefill)}" autofocus');
swap('drive act',"'drive-add': () => dlgDriveAdd(),","'drive-add': (b) => dlgDriveAdd(b && b.dataset && b.dataset.path || undefined),");
swap('drive page marker',"function vSettings() {",`const fmtBytes = (n) => (n >= 1e12 ? (n / 1e12).toFixed(1) + ' TB' : (n / 1e9).toFixed(n >= 1e11 ? 0 : 1) + ' GB');
function vDrive() {
  const o = cur(), d = S.detail;
  if (!o) return noOffice();
  if (o.readonly) return '<div class="card"><div class="empty"><div class="big">🔒</div><b>읽기 전용 봇입니다</b><p>별개의 봇이라 드라이브 접근을 바꾸지 않습니다.</p></div></div>';
  if (o.kind === 'hermes') return '<div class="card"><div class="empty"><div class="big">🤖</div><b>Hermes 봇에는 드라이브 접근 설정이 없어요</b><p>Hermes 는 자체 설정으로 관리해요. 이 프로그램은 켜고 끄기와 항상 켜두기만 도와요.</p></div></div>';
  const grants = (d && d.drives) || [];
  const usage = S.driveUsage || [];
  const granted = (letter) => grants.filter((g) => g.path.slice(0, 2).toUpperCase() === letter + ':');
  const bar = (u) => { const used = u.total - u.free; const pct = Math.min(100, Math.round(used / u.total * 100)); return \`<div class="meter" role="img" aria-label="사용 \${pct}%"><i style="width:\${pct}%"></i></div><div class="small muted">\${fmtBytes(used)} 사용 · \${fmtBytes(u.free)} 남음 · 전체 \${fmtBytes(u.total)}</div>\`; };
  const cards = usage.map((u) => { const gs = granted(u.letter); return \`<div class="card drive-card\${gs.length ? ' selected-mark' : ''}" style="margin:0"><div class="top-row"><div><h3>\${esc(u.letter)} 드라이브</h3><div class="badges">\${gs.length ? pill('ok', '사무실에 맡김') : pill('', '맡기지 않음')}</div></div>\${gs.length ? '' : \`<button class="btn sm" data-act="drive-add" data-path="\${esc(u.letter)}:\\\\">맡기기</button>\`}</div>\${bar(u)}\${gs.map((g) => \`<div class="row" style="justify-content:space-between;gap:10px"><span><span class="code">\${esc(g.path)}</span> · \${DRIVE_LEVEL[g.level] || ''}</span><button class="btn sm" data-act="drive-revoke" data-path="\${esc(g.path)}">해제</button></div>\`).join('')}</div>\`; }).join('');
  const other = grants.filter((g) => !usage.some((u) => g.path.slice(0, 2).toUpperCase() === u.letter + ':'));
  return \`<div class="card"><div class="card-head"><div><h2>드라이브 접근 · 파일 서버처럼 쓰기</h2><p class="sub">D 드라이브처럼 이 PC의 드라이브를 사무실이 읽고, 만들고, 고치고, 필요하면 지울 수 있게 맡깁니다. 여기서 직접 켠 위치만 열리며, 봇이 스스로 열 수는 없습니다. 바꾼 뒤에는 다시 출근해야 새 지침이 적용됩니다.</p></div>
    <button class="btn primary" data-act="drive-add">＋ 위치 추가</button></div>
    \${usage.length ? \`<div class="grid cols-3">\${cards}</div>\` : '<p class="muted">이 PC의 드라이브 정보를 불러오는 중이거나, 읽을 수 있는 드라이브가 없습니다.</p>'}
    \${other.length ? \`<div class="stack" style="margin-top:14px"><div class="group-title">그 밖에 맡긴 위치</div>\${other.map((g) => \`<div class="row" style="justify-content:space-between"><span><span class="code">\${esc(g.path)}</span> · \${DRIVE_LEVEL[g.level] || ''}</span><button class="btn sm" data-act="drive-revoke" data-path="\${esc(g.path)}">해제</button></div>\`).join('')}</div>\` : ''}</div>
    <div class="card"><h2>알아 두세요</h2><ol class="guide"><li>맡긴 위치 밖과 봇의 토큰·설정 폴더는 계속 막혀 있습니다.</li><li>삭제까지 맡기면 휴지통 없이 지워질 수 있으니, 정말 필요한 폴더만 맡기고 중요한 자료는 먼저 백업하세요.</li><li>Windows가 설치된 드라이브의 시스템·계정 폴더는 맡길 수 없습니다.</li></ol></div>\`;
}
async function loadDriveUsage() { try { S.driveUsage = (await api('GET', '/../api/drives')).drives; } catch { S.driveUsage = []; } }

function vSettings() {`);
// 드라이브 용량은 통합 서버(/api/drives)에서 읽는다: Office 경로(/office) 밖이라 따로 요청한다.
js=js.replace("S.driveUsage = (await api('GET', '/../api/drives')).drives;","S.driveUsage = (await (await fetch('/api/drives')).json()).drives || [];");
swap('drive refresh',"    S.ov = ov; S.ok = true;","    S.ov = ov; S.ok = true;\n    if (S.view === 'drive' && Date.now() - (S.driveAt || 0) > 15000) { S.driveAt = Date.now(); await loadDriveUsage(); }");

// 설정 화면의 '화면 색상' 설명: 두 가지 테마
js=js.replace(/<option value="light"\$\{cfg\.theme === 'light' \? ' selected' : ''\}>밝게<\/option>/,"<option value=\"light\"${cfg.theme === 'light' ? ' selected' : ''}>화이트 · 하늘색</option>")
    .replace(/<option value="dark"\$\{cfg\.theme === 'dark' \? ' selected' : ''\}>어둡게<\/option>/,"<option value=\"dark\"${cfg.theme === 'dark' ? ' selected' : ''}>블랙 · 그레이</option>");

// ── 스타일: 공통 부품 이후만 가져온다(틀·메뉴는 통합 화면이 직접 그린다) ──
const start=css.indexOf('/* 공통 부품 */');
if(start<0)throw new Error('Office 스타일이 바뀌어 변환할 수 없습니다: 공통 부품 표시를 찾지 못했습니다.');
css=css.slice(start);
const media=css.indexOf('@media (max-width: 980px) {');
if(media<0)throw new Error('Office 스타일이 바뀌어 변환할 수 없습니다: 좁은 화면 규칙을 찾지 못했습니다.');
const mediaEnd=css.indexOf('\n}\n',media)+3;
css=css.slice(0,media)+`@media (max-width: 980px) {
  .split { grid-template-columns: 1fr; }
  .grid.cols-2 { grid-template-columns: 1fr; }
  .formgrid { grid-template-columns: 1fr; }
}
`+css.slice(mediaEnd);
const before=css;
css=css.replace(/(\.btn\.primary \{[^}]*?)color: #fff;/,'$1color: var(--on-accent);').replace(/(\.step\.now \.n \{[^}]*?)color: #fff;/,'$1color: var(--on-accent);');
if(css===before)throw new Error('Office 스타일이 바뀌어 변환할 수 없습니다: 기본 버튼 색을 찾지 못했습니다.');

const header='/* 자동 생성: scripts/build-office-ui.mjs — Claude Office '+pkg.version+' 화면을 통합용으로 변환한 것. 직접 고치지 말고 스크립트를 고치세요. */\n';
await writeFile(join(root,'web/office.js'),header+js);
await writeFile(join(root,'web/office.css'),header+css);

// Office 가 열어 둔 API 목록: 통합 서버가 이 목록 안의 경로만 전달한다.
const routes=[...serverSrc.matchAll(/route\('(GET|POST|PATCH|DELETE)', '([^']+)'/g)].map(m=>({method:m[1],path:m[2]}));
if(routes.length<59)throw new Error('Office API 목록을 읽지 못했습니다.');
await writeFile(join(root,'src/office-routes.json'),JSON.stringify(routes,null,2)+'\n');
const provPath=join(root,'docs/module-provenance.json');
const provenance=JSON.parse(await readFile(provPath,'utf8'));
provenance.capturedAt=new Date().toISOString();
Object.assign(provenance.office,{version:pkg.version,source,routeCount:routes.length,sourceSha256:createHash('sha256').update(serverSrc).digest('hex'),
  changes:['local API prefix','local request guard','default ai-office selection','embedded in unified shell (no iframe)','drive page','two themes (sky-white / black-gray)']});
await writeFile(provPath,JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({version:pkg.version,routes:routes.length,source}));
