// 방 대화 읽기: 대화 기록(jsonl)에서 텔레그램 수신·발신을 뽑고, 새로 붙은 줄만 이어 읽는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLine, plain, inboundText, projectSlug, officeProjectDirs, officeActivity, officeSummary, botActivity, botSummary } from '../src/roomlog.mjs';

const chan = (id, thread, text, ts) => `<channel source="plugin:telegram:telegram" chat_id="-100" message_id="${id}" user="946" user_id="946" chat_type="group" room="방" thread_id="${thread}" topic="월례회" ts="${ts}">\n${text}\n</channel>`;
const enqueue = (id, thread, text, ts) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: chan(id, thread, text, ts) });
const queued = (id, thread, text, ts) => JSON.stringify({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: chan(id, thread, text, ts) } });
const reply = (tid, thread, text, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: tid, name: 'mcp__plugin_telegram_telegram__reply', input: { chat_id: '-100', thread_id: thread, format: 'html', text } }] } });

test('수신 메시지에서 사무실이 덧붙인 맥락(〔…〕)은 뺀다', () => {
  const m = parseLine(enqueue(1, '149', '회의 몇 시야?\n\n〔오늘 일정〕 확인: 내부 맥락', '2026-10-01T05:00:00.000Z'));
  assert.equal(m.text, '회의 몇 시야?');
  assert.equal(m.thread, '149');
  assert.equal(m.role, 'user');
  assert.equal(m.who, '');   // 숫자 아이디는 이름으로 보이지 않는다
});

test('reply 도구 호출은 HTML 을 걷어 낸 글로 읽힌다', () => {
  const m = parseLine(reply('t1', '149', '<b>확인</b> 했어요 &amp; 끝<br>다음줄', '2026-10-01T05:01:00.000Z'));
  assert.equal(m.role, 'bot');
  assert.equal(m.text, '확인 했어요 & 끝\n다음줄');
  assert.equal(plain('<blockquote>a</blockquote>b'), 'a\nb');
  assert.equal(inboundText('x\n</channel>'), 'x');
});

test('관계없는 줄과 깨진 줄은 건너뛴다', () => {
  assert.equal(parseLine('{"type":"user","message":"telegram 이야기"}'), null);
  assert.equal(parseLine('telegram {깨진'), null);
});

test('같은 메시지가 두 번 기록돼도 한 번만 나오고, 시간순이며, 주제별로 나뉜다', () => {
  const home = mkdtempSync(join(tmpdir(), 'roomlog-'));
  const office = { folder: 'F:/AI-Office' };
  assert.equal(projectSlug('F:/AI-Office'), 'F--AI-Office');
  const [dir] = officeProjectDirs(office, home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 's.jsonl');
  writeFileSync(file, [
    enqueue(1, '149', '첫 질문', '2026-10-01T05:00:00.000Z'),
    queued(1, '149', '첫 질문', '2026-10-01T05:00:01.000Z'),
    reply('t1', '149', '첫 답', '2026-10-01T05:00:30.000Z'),
    enqueue(2, '863', '다른 주제', '2026-10-01T06:00:00.000Z'),
  ].join('\n') + '\n');
  const got = officeActivity([dir], '-100', '149');
  assert.deepEqual(got.map((m) => [m.role, m.text]), [['user', '첫 질문'], ['bot', '첫 답']]);
  assert.equal(officeActivity([dir], '-100', '863').length, 1);
  assert.equal(officeActivity([dir], '-100').length, 3);   // 방 전체

  // 파일이 커진 만큼만 이어 읽는다(마지막 줄이 아직 덜 써졌으면 다음에 읽는다)
  appendFileSync(file, enqueue(3, '149', '새 질문', '2026-10-02T01:00:00.000Z') + '\n' + enqueue(4, '149', '쓰는 중', '2026-10-02T02:00:00.000Z').slice(0, 40));
  assert.deepEqual(officeActivity([dir], '-100', '149').map((m) => m.text), ['첫 질문', '첫 답', '새 질문']);
  appendFileSync(file, enqueue(4, '149', '쓰는 중', '2026-10-02T02:00:00.000Z').slice(40) + '\n');
  assert.equal(officeActivity([dir], '-100', '149').at(-1).text, '쓰는 중');

  const sum = officeSummary([dir]);
  assert.equal(sum['-100'].topics['149'].count, 4);
  assert.equal(sum['-100'].topics['149'].last.text, '쓰는 중');
  assert.equal(sum['-100'].topics['863'].last.role, 'user');
});

test('기록 폴더가 없으면 빈 결과', () => {
  assert.deepEqual(officeActivity(['C:/없는/폴더'], '-1', '2'), []);
  assert.deepEqual(officeSummary(['C:/없는/폴더']), {});
});

test('LAPIS 봇은 대화 기억(history)에서 읽는다', () => {
  const folder = mkdtempSync(join(tmpdir(), 'roomlog-bot-'));
  mkdirSync(join(folder, 'history'));
  writeFileSync(join(folder, 'history', '-100_5.json'), JSON.stringify([{ role: 'user', content: '질문' }, { role: 'assistant', content: '답' }]));
  const got = botActivity(folder, '-100', '5');
  assert.deepEqual(got.map((m) => [m.role, m.text]), [['user', '질문'], ['bot', '답']]);
  assert.ok(got[1].at && !got[0].at);
  const sum = botSummary(folder, [{ id: '-100', topics: [{ id: '5' }, { id: '6' }] }]);
  assert.equal(sum['-100'].topics['5'].last.text, '답');
  assert.equal(sum['-100'].topics['6'].last, null);
});
