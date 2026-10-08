#!/usr/bin/env node
// LAPIS 커넥터 — 봇(Claude Code·Hermes)이 띄우는 MCP 서버(stdio, 줄 단위 JSON-RPC 2.0).
// 이 서버는 얇은 중계기다: 도구 목록과 실제 일은 LAPIS 대시보드(127.0.0.1)의 /api/connector/call 이 맡는다.
// 그래서 라피스 계정 로그인·Google 권한·쓰기 승인 규칙은 모두 대시보드 한 곳에서 정해지고, 이 파일에는 비밀이 없다.
// 환경 값: LAPIS_CONNECTOR_URL(대시보드 주소), LAPIS_CONNECTOR_TOKEN_FILE(이 봇의 호출 키 파일), LAPIS_CONNECTOR_BOT(봇 id)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const BASE = new URL(process.env.LAPIS_CONNECTOR_URL || 'http://127.0.0.1:4310');
const TOKEN_FILE = process.env.LAPIS_CONNECTOR_TOKEN_FILE || '';
const VERSION = '1.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'LAPIS 커넥터: 사용자의 라피스 계정에 연결된 Google 드라이브·시트·문서·슬라이드와 LAPIS 일정·할 일을 다룹니다.',
  '구글 시트 링크를 받으면 sheet_inspect 로 탭 이름과 현재 값을 먼저 확인하세요.',
  '쓰기는 두 단계입니다: sheet_write/doc_write 로 미리보기를 만들고, 결과를 사용자에게 보여 준 뒤 사용자가 진행하라고 하면 apply_change 를 부르세요.',
  '도구가 "권한이 꺼져 있다"고 하면 사용자에게 LAPIS 앱 「봇 스튜디오 → 커넥터」에서 켜 달라고 안내하세요.',
].join('\n');

// 대시보드가 꺼져 있거나 키가 없을 때도 봇이 이유를 사용자에게 설명할 수 있도록 이 도구 하나는 늘 보여 준다.
const STATUS_TOOL = { name: 'lapis_status', description: 'LAPIS 커넥터 연결 상태와 지금 쓸 수 있는 기능을 확인합니다.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };

function token() {
  try { return readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

// 대시보드 호출. fetch 는 Origin 머리말을 붙일 수 있어(대시보드가 브라우저 요청으로 보고 거절) node:http 를 쓴다.
function call(tool, args = {}, timeout = 90000) {
  return new Promise((resolve) => {
    const tok = token();
    if (!tok) return resolve({ status: 0, data: { error: '이 봇의 커넥터 키가 없습니다. LAPIS 앱 「봇 스튜디오 → 커넥터」에서 LAPIS 커넥터를 다시 저장해 주세요.' } });
    const body = Buffer.from(JSON.stringify({ tool, args }));
    const req = http.request({
      host: BASE.hostname, port: BASE.port || 80, path: '/api/connector/call', method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: `Bearer ${tok}`, host: `${BASE.hostname}:${BASE.port || 80}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = { error: '대시보드 응답을 읽지 못했습니다.' }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, data: { error: e.message === 'timeout' ? 'LAPIS 대시보드 응답이 늦어 기다리지 않았습니다. 같은 요청을 자동으로 반복하지 마세요.' : 'LAPIS 앱(대시보드)이 꺼져 있어 연결하지 못했습니다. PC에서 LAPIS 앱을 켜 달라고 사용자에게 알려 주세요.' } }));
    req.end(body);
  });
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function listTools() {
  const r = await call('_list', {}, 15000);
  const tools = r.status === 200 && Array.isArray(r.data.tools) ? r.data.tools : [];
  return [STATUS_TOOL, ...tools.filter((t) => t && typeof t.name === 'string' && t.name !== STATUS_TOOL.name)];
}

async function callTool(name, args) {
  if (name === STATUS_TOOL.name) {
    const r = await call('_status', {}, 15000);
    return r.status === 200 ? text(r.data.text || JSON.stringify(r.data, null, 2)) : text(r.data.error || `연결 확인 실패 (${r.status})`, true);
  }
  const r = await call(name, args && typeof args === 'object' ? args : {});
  if (r.status === 200) return text(r.data.text || JSON.stringify(r.data.result ?? r.data, null, 2));
  const msg = r.data.error || `요청 실패 (${r.status})`;
  return text(r.status === 401 && /로그인/.test(msg) ? `${msg} (PC의 LAPIS 앱에서 라피스 계정에 로그인되어 있어야 합니다.)` : msg, true);
}

// ── JSON-RPC ──
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lapis', title: 'LAPIS 커넥터', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return reply(id, {});
      case 'tools/list': return reply(id, { tools: await listTools() });
      case 'tools/call': return reply(id, await callTool(String(params?.name || ''), params?.arguments));
      default:
        if (isRequest) return fail(id, -32601, `지원하지 않는 요청입니다: ${method}`);   // 알림(notifications/*)은 답하지 않는다
    }
  } catch (e) {
    if (isRequest) fail(id, -32603, e.message || '처리 중 오류가 발생했습니다.');
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 형식이 아닙니다.' } }); continue; }
    if (Array.isArray(msg)) msg.forEach((m) => handle(m)); else handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
