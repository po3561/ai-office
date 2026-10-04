// 개발용 가짜 라피스 클라우드: 실제 서버·계정 없이 회원가입·로그인·프로필·사진·동기화 화면을 끝까지 시험한다.
// 메모리에만 저장하고, 끄면 모두 사라진다. 실제 서버와 같은 경로·필드 이름을 쓴다.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';

export async function startFakeCloud() {
  const users = new Map();      // id -> {id,username,email,name,password,profile,avatar,sync}
  const sessions = new Map();   // access token -> user id
  const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  const session = (u) => { const access = 'access-' + randomUUID(); sessions.set(access, u.id); return { ok: true, access_token: access, refresh_token: 'refresh-' + u.id, user: { id: u.id, username: u.username, email: u.email, name: u.profile.name } }; };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/api\/v1/, '');
    const json = () => { try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return {}; } };
    if (path === '/legal/consents/current') return send(res, 200, { documents: [{ consent_type: 'terms', version: '1', title: '이용약관', body_markdown: '(개발용) 라피스 이용약관 예시입니다.', document_hash: 'h1', required: true }, { consent_type: 'marketing', version: '1', title: '소식 받기', body_markdown: '(개발용) 선택 동의 예시입니다.', document_hash: 'h2', required: false }] });
    if (path === '/auth/register') {
      const b = json();
      if ([...users.values()].some((u) => u.email === b.email || u.username === b.username)) return send(res, 409, { error: 'Email or username is already registered' });
      const u = { id: randomUUID(), username: b.username, email: b.email, password: b.password, profile: { name: b.display_name, phone: b.phone, revision: 1 }, avatar: null, sync: null, syncRev: 0 };
      users.set(u.id, u);
      return send(res, 201, session(u));
    }
    if (path === '/auth/login') {
      const b = json();
      const u = [...users.values()].find((x) => x.email === String(b.identifier).toLowerCase() || x.username === b.identifier);
      return u && u.password === b.password ? send(res, 200, session(u)) : send(res, 401, { error: 'Identifier or password is incorrect' });
    }
    if (path === '/auth/refresh' || path === '/auth/logout') return send(res, path === '/auth/logout' ? 200 : 401, { ok: true });
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const u = users.get(sessions.get(token));
    if (!u) return send(res, 401, { error: 'Unauthorized' });
    if (path === '/auth/me') return send(res, 200, { ok: true, user: { id: u.id, username: u.username, email: u.email, name: u.profile.name, created_at: '2026-10-04' } });
    if (path === '/me/identity-profile' && req.method === 'GET') return send(res, 200, { ok: true, profile: { name: u.profile.name, phone: u.profile.phone }, revision: u.profile.revision });
    if (path === '/me/identity-profile' && req.method === 'PUT') {
      const b = json();
      if (b.expected_revision !== u.profile.revision) return send(res, 409, { error: 'changed' });
      u.profile = { name: b.name, phone: b.phone, revision: u.profile.revision + 1 };
      return send(res, 200, { ok: true, profile: { name: u.profile.name, phone: u.profile.phone }, revision: u.profile.revision });
    }
    if (path === '/me/avatar' && req.method === 'GET') return u.avatar ? send(res, 200, u.avatar.bytes, { 'content-type': u.avatar.type }) : send(res, 404, '');
    if (path === '/me/avatar' && req.method === 'PUT') { u.avatar = { bytes: raw, type: req.headers['content-type'] }; return send(res, 200, { ok: true }); }
    if (path === '/me/avatar' && req.method === 'DELETE') { u.avatar = null; return send(res, 200, { ok: true }); }
    if (path === '/dashboard-sync' && req.method === 'GET') return send(res, 200, { ok: true, revision: u.syncRev, updatedAt: u.sync ? new Date().toISOString() : null, snapshot: u.sync });
    if (path === '/dashboard-sync' && req.method === 'PUT') { u.sync = json().snapshot; u.syncRev += 1; return send(res, 200, { ok: true, revision: u.syncRev, updatedAt: new Date().toISOString() }); }
    if (path === '/integrations/google-drive/status') return send(res, 200, { ok: true, connected: false, configured: true });
    return send(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/api/v1`, server };
}
