// 로컬 AI 모델 장터: 실시간 목록 읽기, 한국어 설명 카드, PC 사양별 추천, 지우기·기본 모델.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sandbox } from './helpers.mjs';

sandbox();
const { parseLibrary, paramsB, buildCards, describeInstalled, createCatalog, fitFor, pcInfo, BUILTIN } = await import('../src/ollama-catalog.mjs');
const { createOllama } = await import('../src/ollama.mjs');

const li = (name, desc, { caps = [], sizes = [], cloud = false, pulls = '1M', updated = 'Oct 9, 2026 4:45 PM UTC' } = {}) => `
<li  class="flex items-baseline border-b"><a href="/library/${name}" class="group">
<div title="${name}"><h2><div><span>${name}</span></div></h2><p class="max-w-lg break-words text-neutral-800 text-md">${desc}</p></div>
<div><div>${caps.map((c) => `<span  class="inline-flex rounded-md bg-indigo-50 px-2 text-indigo-600">${c}</span>`).join('')}${cloud ? '<span class="inline-flex bg-cyan-50 text-cyan-500">cloud</span>' : ''}
${sizes.map((z) => `<span  class="inline-flex rounded-md bg-[#ddf4ff] px-2 text-blue-600">${z}</span>`).join('')}</div>
<p><span class="flex items-center"><span >${pulls}</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
<span class="flex items-center" title="${updated}"><span class="hidden sm:flex">Updated&nbsp;</span><span >2 days ago</span></span></p></div></a></li>`;
const HTML = '<ul>' + [
  li('gemma4', 'Gemma 4 for reasoning &amp; coding.', { caps: ['vision', 'tools', 'thinking'], sizes: ['e2b', 'e4b', '12b', '31b'], cloud: true, pulls: '26.8M' }),
  li('gemma3', 'Older Gemma.', { caps: ['vision'], sizes: ['1b', '4b', '12b'], pulls: '41M', updated: 'Mar 1, 2025 1:00 AM UTC' }),
  li('qwen2.5-coder', 'Code-specific Qwen models.', { caps: ['tools'], sizes: ['7b', '32b'], pulls: '9M' }),
  li('nomic-embed-text', 'Embedding model.', { caps: ['embedding'], pulls: '88M' }),
  li('kimi-k3', 'Cloud only.', { caps: ['tools'], cloud: true, pulls: '100K' }),
].join('') + '</ul>';

const serve = (t, handler) => new Promise((resolve) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => { t.after(() => s.close()); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const PC_BIG = { ramGB: 32, vramGB: 8, gpu: 'x' }, PC_SMALL = { ramGB: 8, vramGB: 0, gpu: '' };

test('목록 읽기: 이름·설명·기능·크기·인기·업데이트 날짜, 클라우드 전용과 임베딩은 카드에서 빠진다', () => {
  const e = parseLibrary(HTML);
  assert.equal(e.length, 5);
  const g = e[0];
  assert.deepEqual([g.name, g.caps, g.sizes, g.cloud, g.pulls], ['gemma4', ['vision', 'tools', 'thinking'], ['e2b', 'e4b', '12b', '31b'], true, 26800000]);
  assert.equal(g.desc, 'Gemma 4 for reasoning & coding.');
  assert.equal(g.updatedAt, '2026-10-09T16:45:00.000Z');
  const names = buildCards(e, PC_BIG).map((c) => c.name);
  assert.ok(names.includes('gemma4') && !names.includes('nomic-embed-text') && !names.includes('kimi-k3'));
});

test('크기 표기 해석: e4b·270m·16x17b, 맥락 길이(1m)는 무시', () => {
  assert.equal(paramsB('e4b'), 4);
  assert.equal(paramsB('270m'), 0.27);
  assert.equal(paramsB('16x17b'), 272);
  assert.equal(paramsB('1m'), 0);
  assert.equal(paramsB('latest'), 0);
});

test('카드는 모델 이름이 아니라 한국어 설명·기대 성능·이 PC 적합도를 준다', () => {
  const cards = buildCards(parseLibrary(HTML), PC_BIG, ['gemma3:12b']);
  const g4 = cards.find((c) => c.name === 'gemma4');
  assert.match(g4.headline, /[가-힣]/);
  assert.ok(g4.can.some((x) => /사진/.test(x)) && g4.can.some((x) => /생각/.test(x)));
  assert.ok(g4.expect.length > 10 && g4.fitLabel.length > 5 && g4.quality >= 1);
  assert.ok(g4.variants.every((v) => v.name === `gemma4:${v.tag}` && v.sizeGB > 0));
  const coder = cards.find((c) => c.name === 'qwen2.5-coder');
  assert.equal(coder.headline, '코딩을 도와주는 AI');
  assert.ok(coder.purposes.includes('code'));
  assert.equal(cards.find((c) => c.name === 'gemma3').installed, true);
});

test('같은 계열의 옛 세대는 이전 세대로 내려가고, 새 세대가 이 PC에 안 맞으면 그대로 둔다', () => {
  const e = parseLibrary(HTML);
  assert.equal(buildCards(e, PC_BIG).find((c) => c.name === 'gemma3').outdated, true);
  assert.equal(buildCards(e, { ramGB: 1, vramGB: 0, gpu: '' }).find((c) => c.name === 'gemma3').outdated, false);
});

test('PC 사양에 따라 적합도가 달라진다', () => {
  const e = parseLibrary(HTML);
  const small = buildCards(e, PC_SMALL).find((c) => c.name === 'qwen2.5-coder');
  assert.equal(small.variants.find((v) => v.tag === '32b').fit, 'no');
  assert.notEqual(small.variants.find((v) => v.tag === '7b').fit, 'no');
  assert.equal(fitFor(3, PC_SMALL), 'ok');
  assert.equal(fitFor(4.7, PC_SMALL), 'slow');
  assert.equal(fitFor(30, PC_SMALL), 'no');
});

test('레지스트리의 실제 크기가 있으면 추정 대신 쓴다', () => {
  const c = buildCards(parseLibrary(HTML), PC_BIG, [], { 'qwen2.5-coder:7b': 4.7 * 1e9 }).find((x) => x.name === 'qwen2.5-coder');
  const v = c.variants.find((x) => x.tag === '7b');
  assert.equal(v.exact, true);
  assert.equal(v.sizeGB, 4.7);
});

test('내려받은 모델 설명: 목록에 있으면 설명, 없으면 일반 설명', () => {
  const e = parseLibrary(HTML);
  const a = describeInstalled({ name: 'gemma3:12b', size: 8 * 1e9 }, e, PC_BIG);
  assert.equal(a.custom, false);
  assert.ok(a.can.length && a.sizeGB === 8);
  const b = describeInstalled({ name: 'lapis-a1:latest', size: 2 * 1e9 }, e, PC_BIG);
  assert.equal(b.custom, true);
  assert.match(b.headline, /직접 만든/);
});

test('목록 가져오기: 새로 받고 → 기억하고 → 실패하면 기억한 것 → 아무것도 없으면 내장 목록', async (t) => {
  let hits = 0, fail = false;
  const base = await serve(t, (req, res) => { hits++; if (fail) { res.statusCode = 500; return res.end('x'); } res.end(HTML); });
  const fetchImpl = (u, o) => fetch(String(u).replace('https://ollama.com', base), o);
  let clock = 1e12;
  const cat = createCatalog({ fetchImpl, now: () => clock });
  const a = await cat.get();
  assert.equal(a.source, 'live'); assert.equal(hits, 2);
  assert.equal((await cat.get()).source, 'cache'); assert.equal(hits, 2);
  clock += 2 * 3600 * 1000; fail = true;
  const c = await cat.get();
  assert.equal(c.source, 'cache'); assert.ok(c.error);
  const none = await createCatalog({ fetchImpl, now: () => clock }).get();
  assert.equal(none.source, 'builtin'); assert.equal(none.entries, BUILTIN);
});

test('실제 크기 확인: 레지스트리 manifest 의 층 크기를 더한다', async (t) => {
  const base = await serve(t, (req, res) => res.end(JSON.stringify({ config: { size: 10 }, layers: [{ size: 100 }, { size: 900 }] })));
  const cat = createCatalog({ fetchImpl: (u, o) => fetch(String(u).replace('https://registry.ollama.ai', base), o) });
  assert.equal(await cat.exactSize('gemma4:12b'), 1010);
  assert.equal(await cat.exactSize('hf.co/a/b:Q4'), null);
});

test('모델 지우기와 기본 모델: 지우면 기본값도 풀린다', async (t) => {
  const deleted = [];
  let tags = [{ name: 'a:1b', size: 5 }, { name: 'b:2b', size: 6 }];
  const base = await serve(t, (req, res) => {
    if (req.url === '/api/version') return res.end('{"version":"0.1.0"}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: tags }));
    if (req.url === '/api/delete' && req.method === 'DELETE') { let b = ''; req.on('data', (d) => { b += d; }); return req.on('end', () => { const n = JSON.parse(b).model; deleted.push(n); tags = tags.filter((m) => m.name !== n); res.end('{}'); }); }
    res.statusCode = 404; res.end();
  });
  const o = createOllama({ baseUrl: base });
  assert.equal(o.setActive('a:1b'), 'a:1b');
  assert.equal((await o.models()).active, 'a:1b');
  await o.remove('a:1b');
  assert.deepEqual(deleted, ['a:1b']);
  assert.equal((await o.models()).active, '');
  await assert.rejects(o.remove('bad name'), /모델 이름/);
});

test('PC 등급: 그래픽 메모리 기준 S(8GB 미만)·M(8~32GB)·L(32GB 이상)', async () => {
  const gpu = (mb) => async () => ({ code: 0, stdout: `GPU, ${mb}
` });
  assert.equal((await pcInfo({ runImpl: gpu(24576) })).tier, 'M');
  assert.equal((await pcInfo({ runImpl: gpu(49152) })).tier, 'L');
  assert.equal((await pcInfo({ runImpl: gpu(6144) })).tier, 'S');
  assert.equal((await pcInfo({ runImpl: async () => ({ code: 1, stdout: '' }) })).tier, 'S');
});

test('최근 나온 세대(Qwen 3.5·3.6·3.8)는 함께 보이고, 오래된 세대만 이전 세대로 내려간다', () => {
  const e = parseLibrary('<ul>' + [
    li('qwen3.8', 'Newest.', { caps: ['vision', 'tools', 'thinking'], sizes: ['27b'], pulls: '3M' }),
    li('qwen3.6', 'Agentic coding.', { caps: ['vision', 'tools', 'thinking'], sizes: ['27b', '35b'], pulls: '7M' }),
    li('qwen3', 'Old gen.', { caps: ['tools'], sizes: ['4b', '8b'], pulls: '39M' }),
  ].join('') + '</ul>').map((x, i) => ({ ...x, newestRank: i < 2 ? i : 52 }));
  const cards = buildCards(e, PC_BIG);
  const flag = (n) => cards.find((c) => c.name === n).outdated;
  assert.equal(flag('qwen3.8'), false);
  assert.equal(flag('qwen3.6'), false);
  assert.equal(flag('qwen3'), true);
  assert.match(cards.find((c) => c.name === 'qwen3.6').family, /코딩 에이전트/);
});
