import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sandbox } from './helpers.mjs';

const root = sandbox();
const O = await import('../src/offices.mjs');
const C = await import('../src/connectors.mjs');
const H = await import('../src/hermes-config.mjs');
const { FILES, CONNECTORS_DIR } = await import('../src/paths.mjs');
const P = await import('../src/permits.mjs');

// 실제 라피스 Hermes 프로필과 같은 모양(4칸 들여쓴 목록, 위쪽 주석)
const HERMES_YAML = [
  'model:', '  default: gemini-3.1-flash-lite', '  provider: gemini', 'agent:', '  max_turns: 8', '  disabled_toolsets:', '    - bfl',
  'memory:', '  memory_enabled: false', '  user_profile_enabled: false', '_config_version: 34',
  '# Claude Office의 원본을 직접 읽는다.', 'context_file_max_chars: 60000',
  'platform_toolsets:', '  cli:', '    - file', '    - search', '  telegram:', '    - browser', '    - file', '    - kanban', '    - lapis_files', '    - search', '    - skills',
  '  api_server:', '    - no_mcp', 'plugins:', '  enabled:', '    - lapis-local-files', '', '# ── Security ──', '# security:', '#   redact_secrets: true', '',
].join('\n');

function hermesProfile(name = 'pilot') {
  const dir = join(root, 'hermes', 'profiles', name);
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), HERMES_YAML.replace(/\n/g, '\r\n'), 'utf8');
  return O.importOffice({ folder: dir, name: '라피스' });
}

test('Hermes 설정: 텔레그램 기능 묶음을 읽고, 바꾸고, 다른 블록과 주석은 그대로 둔다', () => {
  assert.deepEqual(H.readToolsets(HERMES_YAML), ['browser', 'file', 'kanban', 'lapis_files', 'search', 'skills']);
  const out = H.applyTools(HERMES_YAML, { toolsets: ['web', 'file', 'cronjob', 'memory', 'vision'], maxTurns: 20 });
  assert.deepEqual(H.readToolsets(out), ['file', 'lapis_files', 'web', 'cronjob', 'memory', 'vision']);   // 순서는 지키고, 모르는 항목(플러그인)은 남긴다
  assert.equal(H.applyTools(HERMES_YAML, { toolsets: ['skills', 'search', 'kanban', 'file', 'browser'] }), HERMES_YAML);   // 같은 집합이면 파일이 바뀌지 않는다
  assert.equal(H.readScalar(out, 'agent', 'max_turns'), '20');
  assert.equal(H.readScalar(out, 'memory', 'memory_enabled'), 'true');   // 기억 기능 묶음을 켜면 기억도 켠다
  assert.deepEqual(H.readToolsets(out.replace(/telegram:[\s\S]*?api_server/, 'api_server')), null);
  for (const keep of ['  cli:\n    - file\n    - search', '  api_server:\n    - no_mcp', '    - bfl', '# Claude Office의 원본을 직접 읽는다.', '#   redact_secrets: true', 'plugins:\n  enabled:\n    - lapis-local-files']) assert.ok(out.includes(keep), keep);
  const view = H.toolsView(out);
  assert.equal(view.toolsets.find((t) => t.key === 'memory').on, true);
  assert.deepEqual(view.others, ['lapis_files']);
});

test('Hermes 설정: 위험한 기능은 확인이 있어야 켜지고, 범위 밖 단계 수는 거부한다', () => {
  assert.throws(() => H.applyTools(HERMES_YAML, { toolsets: ['terminal'] }), /확인이 필요/);
  assert.ok(H.readToolsets(H.applyTools(HERMES_YAML, { toolsets: ['terminal'], confirmRisk: true })).includes('terminal'));
  assert.throws(() => H.applyTools(HERMES_YAML, { maxTurns: 500 }), /단계 수/);
  assert.throws(() => H.applyTools(HERMES_YAML, { toolsets: ['rm_rf'] }), /알 수 없는/);
  // 기능 묶음 설정이 아예 없으면 새로 만든다
  const fresh = H.applyTools('model:\n  default: x\n', { toolsets: ['web'], maxTurns: 12 });
  assert.deepEqual(H.readToolsets(fresh), ['web']);
  assert.equal(H.readScalar(fresh, 'agent', 'max_turns'), '12');
  // 흐름 표기([a, b])도 읽는다
  assert.deepEqual(H.readToolsets('platform_toolsets:\n  telegram: [web, "file"]\n'), ['web', 'file']);
});

test('Hermes 설정: 커넥터 블록은 표식 사이만 바꾸고, 직접 적은 mcp_servers 는 덮어쓰지 않는다', () => {
  const one = H.writeMcpServers(HERMES_YAML, { lapis: { command: 'C:\\node\\node.exe', args: ['C:\\app\\x.mjs'], env: { A: '1' } } });
  assert.match(one, /^mcp_servers:$/m);
  assert.ok(one.includes('"lapis": {"command":"C:\\\\node\\\\node.exe"'));   // JSON 흐름 표기(역슬래시 이스케이프)
  const two = H.writeMcpServers(one, { github: { url: 'https://x/mcp' } });
  assert.equal((two.match(/^mcp_servers:/gm) || []).length, 1);
  assert.ok(!two.includes('"lapis"') && two.includes('"github"'));
  assert.equal(H.writeMcpServers(two, {}).trimEnd(), HERMES_YAML.trimEnd());   // 비우면 원래대로
  assert.throws(() => H.writeMcpServers(HERMES_YAML + 'mcp_servers:\n  mine:\n    command: x\n', { lapis: {} }), /직접 적은 mcp_servers/);
});

test('Claude 사무실: LAPIS 커넥터를 켜면 .mcp.json·settings.local.json·호출 키가 생기고, 끄면 내가 넣은 것만 걷어낸다', () => {
  const office = O.createOffice({ name: 'Conn Office', honorific: '팀장님', presets: [] });
  // 사용자가 직접 넣은 서버와 규칙
  writeFileSync(join(office.folder, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }), 'utf8');
  writeFileSync(join(office.folder, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(robocopy *기획*)'] }, enabledMcpjsonServers: ['mine'] }), 'utf8');

  const r = C.setConnectors(office.id, { lapis: { enabled: true, google: 'chat' }, custom: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer secret-token' } }] });
  assert.deepEqual(r.applied, ['lapis', 'github']);
  assert.equal(r.custom[0].headers.Authorization, '********');   // 화면에는 가려서 보낸다
  const mcp = JSON.parse(readFileSync(join(office.folder, '.mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ['github', 'lapis', 'mine']);
  assert.equal(mcp.github.type, 'http');
  assert.equal(mcp.lapis.command, process.execPath);
  assert.equal(mcp.lapis.env.LAPIS_CONNECTOR_TOKEN_FILE, C.tokenFile(office.id));
  assert.ok(!JSON.stringify(mcp.lapis).includes(readFileSync(C.tokenFile(office.id), 'utf8')));   // 키 자체는 설정 파일에 없다
  const local = JSON.parse(readFileSync(join(office.folder, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(local.enabledMcpjsonServers, ['mine', 'lapis', 'github']);
  assert.deepEqual(local.permissions.allow, ['Bash(robocopy *기획*)', 'mcp__lapis', 'mcp__github']);
  assert.deepEqual(P.listPermits(office.folder), ['Bash(robocopy *기획*)']);   // 커넥터 규칙은 봇이 연 규칙 목록에 섞이지 않는다
  const store = JSON.parse(readFileSync(FILES.connectors, 'utf8'));
  assert.equal(store.bots[office.id].tokenHash, createHash('sha256').update(readFileSync(C.tokenFile(office.id), 'utf8').trim()).digest('hex'));
  assert.equal(store.bots[office.id].name, 'Conn Office');

  // 가려진 값을 그대로 다시 보내면 저장된 값이 유지된다
  C.setConnectors(office.id, { custom: r.custom });
  assert.equal(JSON.parse(readFileSync(join(office.folder, '.mcp.json'), 'utf8')).mcpServers.github.headers.Authorization, 'Bearer secret-token');

  C.setConnectors(office.id, { lapis: { enabled: false }, custom: [] });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(office.folder, '.mcp.json'), 'utf8')).mcpServers), ['mine']);
  const after = JSON.parse(readFileSync(join(office.folder, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(after.enabledMcpjsonServers, ['mine']);
  assert.deepEqual(after.permissions.allow, ['Bash(robocopy *기획*)']);
  assert.equal(existsSync(C.tokenFile(office.id)), false);   // 끈 봇의 키는 없앤다
});

test('잘못된 커넥터는 거부하고, 사용자 서버와 이름이 겹치면 덮어쓰지 않는다', () => {
  const office = O.createOffice({ name: 'Bad Conn', honorific: '님', presets: [] });
  for (const bad of [{ name: 'lapis', url: 'https://a' }, { name: 'X', url: 'https://a' }, { name: 'web', url: 'http://evil.example/mcp' }, { name: 'cmd', command: '' }]) {
    assert.throws(() => C.setConnectors(office.id, { custom: [bad] }), (e) => e.status === 400, JSON.stringify(bad));
  }
  writeFileSync(join(office.folder, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'mine' } } }), 'utf8');
  assert.throws(() => C.setConnectors(office.id, { custom: [{ name: 'github', url: 'https://a/mcp' }] }), (e) => e.status === 409);
  assert.throws(() => C.setConnectors(office.id, { lapis: { enabled: true, google: 'everything' } }), /Google 사용 범위/);
});

test('Hermes: 읽기 전용이어도 커넥터·기능은 사용자가 바꿀 수 있고, 바꾸기 전에 백업한다', () => {
  const h = hermesProfile();
  assert.equal(O.isReadonly(O.getOffice(h.id)), true);
  const r = C.setConnectors(h.id, { lapis: { enabled: true, google: 'app', calendar: false } });
  assert.equal(r.appliedTo, 'config.yaml (mcp_servers)');
  const yaml = readFileSync(join(h.folder, 'config.yaml'), 'utf8');
  assert.ok(yaml.includes('\r\n'), '원본 줄바꿈(CRLF)을 지킨다');
  assert.ok(yaml.includes(JSON.stringify(C.lapisServer(h.id))));
  assert.equal(readdirSync(join(CONNECTORS_DIR, 'backup', h.id)).length, 1);

  const t = C.setHermesTools(h.id, { toolsets: ['web', 'file', 'skills', 'cronjob'], maxTurns: 16 });
  assert.equal(t.changed, true);
  assert.deepEqual(t.toolsets.filter((x) => x.on).map((x) => x.key), ['web', 'file', 'skills', 'cronjob']);
  assert.equal(t.maxTurns, 16);
  assert.equal(C.setHermesTools(h.id, { toolsets: ['web', 'file', 'skills', 'cronjob'], maxTurns: 16 }).changed, false);
  assert.match(readFileSync(join(h.folder, 'config.yaml'), 'utf8'), /mcp_servers:/);   // 기능을 바꿔도 커넥터 블록은 남는다
});

test('서버 시작 때 프로그램 경로가 바뀌었으면 커넥터 설정을 다시 맞춘다', () => {
  const office = O.createOffice({ name: 'Repair Conn', honorific: '님', presets: [] });
  C.setConnectors(office.id, { lapis: { enabled: true } });
  const f = join(office.folder, '.mcp.json');
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  doc.mcpServers.lapis.command = 'C:\\old\\node.exe';
  writeFileSync(f, JSON.stringify(doc), 'utf8');
  assert.equal(C.repairConnectors(), true);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).mcpServers.lapis.command, process.execPath);
  assert.equal(C.repairConnectors(), false);
});
