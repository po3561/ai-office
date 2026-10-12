// 로컬 AI 모델 카탈로그: ollama.com 의 공개 모델 목록을 실시간으로 읽어, 모델 이름 대신
// "무엇을 할 수 있고 얼마나 잘하는지, 이 PC 에서 돌아가는지" 를 한국어로 설명하는 카드로 바꾼다.
// - 목록은 한 시간 동안 기억하고(디스크에도 저장), 인터넷이 안 되면 마지막으로 받은 목록 → 내장 목록 순으로 쓴다.
// - 정확한 내려받기 크기는 Ollama 공식 레지스트리의 manifest 로 확인한다(읽기만 한다).
import { totalmem } from 'node:os';
import { readJson, writeJson, run } from './util.mjs';

const LIBRARY = 'https://ollama.com/library';
const REGISTRY = 'https://registry.ollama.ai/v2/library';
export const TTL_MS = 60 * 60 * 1000;
const UA = { 'user-agent': 'LAPIS-model-catalog' };

// ── 목록 읽기 ──
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const parseCount = (s) => { const m = /^([\d.,]+)\s*([KMB])?$/i.exec(String(s || '').trim()); if (!m) return 0; return Math.round(parseFloat(m[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1)); };

// "e4b" → 4, "270m" → 0.27, "16x17b" → 272(전문가 혼합: 전체 크기). 맥락 길이("1m")처럼 너무 작은 것은 버린다.
export function paramsB(tag) {
  const m = /^(?:e)?(?:(\d+)x)?(\d+(?:\.\d+)?)([bm])$/i.exec(String(tag || '').trim());
  if (!m) return 0;
  const v = parseFloat(m[2]) * (m[1] ? Number(m[1]) : 1) / (m[3].toLowerCase() === 'm' ? 1000 : 1);
  return v >= 0.05 ? v : 0;
}

export function parseLibrary(html) {
  const out = [];
  for (const li of String(html || '').match(/<li\b[\s\S]*?<\/li>/g) || []) {
    const name = /href="\/library\/([^"\/]+)"/.exec(li)?.[1];
    if (!name) continue;
    const desc = decode(/<p class="max-w-lg[^>]*>([\s\S]*?)<\/p>/.exec(li)?.[1]);
    const spans = (cls) => [...li.matchAll(new RegExp(`<span[^>]*${cls}[^>]*>([^<]*)</span>`, 'g'))].map((m) => decode(m[1])).filter(Boolean);
    const caps = spans('bg-indigo-50');
    const cloud = spans('bg-cyan-50').includes('cloud');
    const sizes = spans('bg-\\[#ddf4ff\\]');
    const pulls = parseCount(/<span\s*>([\d.,]+[KMB]?)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls/.exec(li)?.[1]);
    const updated = /title="([A-Z][a-z]{2} \d{1,2}, \d{4}[^"]*UTC)"/.exec(li)?.[1] || '';
    const t = updated ? Date.parse(updated.replace(' UTC', ' GMT')) : NaN;
    out.push({ name, desc, caps, cloud, sizes, pulls, updatedAt: Number.isFinite(t) ? new Date(t).toISOString() : '' });
  }
  return out;
}

// 인터넷이 전혀 안 될 때 쓰는 내장 목록(마지막 보루). 실시간 목록이 있으면 쓰이지 않는다.
export const BUILTIN = [
  { name: 'gemma4', desc: 'Google Gemma 4: reasoning, agentic workflows, coding, multimodal.', caps: ['vision', 'tools', 'thinking'], cloud: false, sizes: ['e2b', 'e4b', '12b', '26b', '31b'], pulls: 26e6 },
  { name: 'qwen3.6', desc: 'Qwen3.6: agentic coding and thinking.', caps: ['vision', 'tools', 'thinking'], cloud: false, sizes: ['27b', '35b'], pulls: 7e6 },
  { name: 'gpt-oss', desc: 'OpenAI open-weight reasoning models.', caps: ['tools', 'thinking'], cloud: false, sizes: ['20b', '120b'], pulls: 8e6 },
  { name: 'llama3.2', desc: 'Meta Llama 3.2 small models.', caps: ['tools'], cloud: false, sizes: ['1b', '3b'], pulls: 50e6 },
  { name: 'phi4-mini', desc: 'Phi-4-mini: multilingual, reasoning, math.', caps: ['tools'], cloud: false, sizes: ['3.8b'], pulls: 1.5e6 },
  { name: 'qwen2.5-coder', desc: 'Code-specific Qwen models.', caps: ['tools'], cloud: false, sizes: ['3b', '7b', '14b', '32b'], pulls: 9e6 },
].map((e, i) => ({ updatedAt: '', ...e, builtin: true, newestRank: i < 2 ? i : -1 }));

// ── 이 PC 사양 ──
export async function pcInfo({ runImpl = run, ramBytes = totalmem() } = {}) {
  let vramGB = 0, gpu = '';
  try {
    const r = await runImpl('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000 });
    if (r.code === 0) {
      for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
        const [n, mb] = line.split(',').map((x) => x.trim());
        const g = (Number(mb) || 0) / 1024;
        if (g > vramGB) { vramGB = g; gpu = n; }
      }
    }
  } catch { /* 그래픽카드 정보를 못 읽으면 CPU 기준으로 본다 */ }
  // 등급(그래픽 메모리 기준): S 8GB 미만(또는 그래픽카드 없음) · M 8~32GB · L 32GB 이상
  const tier = vramGB >= 32 ? 'L' : vramGB >= 8 ? 'M' : 'S';
  return { ramGB: Math.round(ramBytes / 2 ** 30 * 10) / 10, vramGB: Math.round(vramGB * 10) / 10, gpu, tier };
}

// ── 설명 만들기 ──
// 4비트 양자화 기준 대략 크기(GB). 정확한 값은 내려받기 직전에 레지스트리에서 다시 확인한다.
export const estimateGB = (b) => Math.round((b * 0.62 + 0.5) * 10) / 10;
// "e4b" 같은 '유효 크기' 표기는 실제 메모리를 두 배쯤 쓴다.
export const estimateTag = (tag) => { const b = paramsB(tag); return !b ? 0 : /^e\d/i.test(tag) ? estimateGB(b * 2.2) : estimateGB(b); };

export const FIT = {
  fast: { label: '이 PC에서 빠르게 돌아가요', level: 3 },
  ok: { label: '이 PC에서 돌아가요 (조금 느릴 수 있어요)', level: 2 },
  slow: { label: '겨우 돌아가요 (많이 느려요)', level: 1 },
  no: { label: '이 PC에는 너무 커요', level: 0 },
};
export function fitFor(sizeGB, pc) {
  if (pc.vramGB && sizeGB * 1.15 <= pc.vramGB) return 'fast';
  if (sizeGB * 1.3 + 3 <= pc.ramGB) return 'ok';
  if (sizeGB * 1.1 <= pc.ramGB) return 'slow';
  return 'no';
}

const FAMILY = [
  [/^qwen3-coder-next/, 'Qwen 코딩 전용 모델이에요. 코드를 읽고 고치는 에이전트 작업에 맞춰져 있고, 용량이 커서 고사양 PC용이에요.'],
  [/^qwen3\.8/, '알리바바 Qwen의 가장 최신 세대예요. 코딩·업무 문서·자료 조사·긴 작업을 스스로 끝까지 해내고, 사진·영상도 이해해요.'],
  [/^qwen3\.6/, 'Qwen 3.6 세대예요. 코딩 에이전트(코드를 읽고 고치는 작업)에 특히 강하고 사진도 이해해요.'],
  [/^qwen3\.5/, 'Qwen 3.5 세대예요. 작은 크기부터 큰 크기까지 폭넓게 있어, 사양이 낮은 PC에서도 최신 Qwen을 쓸 수 있어요.'],
  [/^qwen/, '알리바바 Qwen 계열이에요. 한국어와 도구 사용이 뛰어나 범용 기본 모델로 많이 써요.'],
  [/^gemma|^medgemma/, '구글 Gemma 계열이에요. 작은 크기에서도 한국어가 자연스럽고 성능이 좋아요.'],
  [/^llama/, '메타 Llama 계열이에요. 가장 널리 쓰이는 범용 모델이에요.'],
  [/^deepseek/, 'DeepSeek 계열이에요. 수학·논리 추론에 강해요.'],
  [/^gpt-oss/, 'OpenAI가 공개한 모델이에요. 추론과 도구 사용에 강해요.'],
  [/^(mistral|ministral|magistral|devstral|codestral)/, '프랑스 Mistral 계열이에요. 가볍고 빠르며 코딩에도 잘 맞아요.'],
  [/^phi/, '마이크로소프트 Phi 계열이에요. 크기는 작은데 추리·수학이 좋아요.'],
  [/^granite/, 'IBM Granite 계열이에요. 문서 요약과 자료 검색 기반 답변(RAG) 같은 업무용에 안정적이에요.'],
  [/^(glm|kimi|minimax)/, '중국 최신 계열이에요. 코딩과 긴 작업(에이전트)에 강해요.'],
  [/^exaone/, 'LG AI연구원 EXAONE 계열이에요. 한국어와 수학·코딩 추론에 강해요.'],
  [/^nemotron/, 'NVIDIA Nemotron 계열이에요. 추론과 에이전트 작업에 강해요.'],
  [/^(smollm|tinyllama|lfm)/, '아주 작은 초경량 계열이에요. 사양이 낮은 PC에서도 돌아가요.'],
];

const TIER = [
  [1.5, '아주 가볍고 빠른 기본 대화 AI', '짧은 질문·분류·간단한 요약에 알맞아요. 복잡한 일은 어려워요.', 1],
  [4.5, '빠르고 무난한 일상 비서', '요약·메일 초안·간단한 질문 답변을 빠르게 해요. 길고 어려운 일은 실수가 있어요.', 2],
  [10, '일상 업무를 거의 맡길 수 있는 AI', '문서 요약·글쓰기·정리 같은 대부분의 사무 업무를 안정적으로 해요.', 3],
  [24, '문서·분석까지 해내는 고성능 AI', '긴 문서 분석, 복잡한 정리, 코드 작성까지 꽤 정확해요.', 4],
  [60, '복잡한 일도 해내는 최상급 AI', '어려운 추론·코딩·긴 작업에 강해요. 대신 고사양 PC가 필요해요.', 5],
  [Infinity, '서버급 초대형 AI', '일반 PC에서는 거의 쓸 수 없어요. 고성능 서버용이에요.', 5],
];

const CODE_RE = /coder|devstral|codestral|codegemma|codellama|starcoder|deepseek-coder|rnj|codeqwen/;
const VISION_ONLY_RE = /-vl$|vision|llava|minicpm-v|moondream|^medgemma/;
const SPECIAL_RE = /guard|safeguard|decision|clef|nimble|reader-lm|reranker/;

export const isChatModel = (e) => !e.caps.some((c) => /embedding|decision/.test(c)) && !SPECIAL_RE.test(e.name) && !(e.cloud && !e.sizes.length);

// 같은 계열의 세대 구분: 숫자를 뺀 이름이 같으면 같은 계열(gemma3·gemma4 → gemma).
// 새로 나온 순서(ollama.com 'newest')로 이 안에 들면 아직 최신 세대로 본다(Qwen 3.5·3.6·3.8 이 함께 보이도록).
const RECENT_RANK = 30;
export const familyKey = (name) => name.replace(/v?\d+(?:\.\d+)?/g, '');
const versionOf = (name) => (name.match(/\d+(?:\.\d+)?/g) || ['0']).map(Number);
const cmpVersion = (a, b) => { const x = versionOf(a), y = versionOf(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

export function purposesOf(e, bestB) {
  const p = [];
  if (bestB && bestB <= 4.5) p.push('light');
  if (!VISION_ONLY_RE.test(e.name) && !CODE_RE.test(e.name)) p.push('work');
  if (e.caps.includes('vision')) p.push('vision');
  if (CODE_RE.test(e.name) || /cod(?:e|ing)/i.test(e.desc) && !VISION_ONLY_RE.test(e.name)) p.push('code');
  if (e.caps.includes('thinking')) p.push('think');
  if (e.caps.includes('tools')) p.push('tools');
  return p;
}

// 카드 한 장. e: 목록 항목, tag: 고른 크기(없으면 latest), sizeGB: 알면 실제 크기.
export function describe(e, tag, sizeGB, pc) {
  const b = paramsB(tag) || 0;
  const gb = sizeGB || estimateTag(tag);
  const tier = TIER.find((t) => b <= t[0]) || TIER[TIER.length - 1];
  const fit = gb ? fitFor(gb, pc) : 'ok';
  const code = CODE_RE.test(e.name), visionOnly = VISION_ONLY_RE.test(e.name);
  const headline = code ? '코딩을 도와주는 AI' : visionOnly ? '사진·화면을 보고 설명하는 AI' : e.caps.includes('thinking') && b > 10 ? '오래 생각하고 답하는 똑똑한 AI' : tier[1];
  const can = [];
  if (!code && !visionOnly) can.push('대화·요약·글쓰기');
  if (code) can.push('코드 작성·수정·설명');
  if (e.caps.includes('vision')) can.push('사진·캡처 화면 이해');
  if (e.caps.includes('tools')) can.push('봇이 도구(파일·검색 등)를 불러 일 처리');
  if (e.caps.includes('thinking')) can.push('어려운 문제를 단계별로 생각한 뒤 답변');
  if (e.caps.includes('audio')) can.push('음성 알아듣기');
  const family = FAMILY.find(([re]) => re.test(e.name))?.[1] || '';
  return {
    headline, expect: tier[2], family, can,
    quality: tier[3], speed: fit === 'fast' ? 3 : fit === 'ok' ? 2 : 1,
    fit, fitLabel: FIT[fit].label, sizeGB: gb, params: b,
  };
}

const bestVariant = (variants) => {
  const usable = variants.filter((v) => v.fit === 'fast' || v.fit === 'ok');
  if (!usable.length) return [...variants].sort((a, b) => a.sizeGB - b.sizeGB)[0] || null;
  // 쾌적하게 도는 가장 큰 것. 단, 느린 혼합 실행(ok)은 너무 큰 것보다 한 단계 작은 것을 권한다.
  const fast = usable.filter((v) => v.fit === 'fast');
  const pool = fast.length ? fast : usable;
  return pool.sort((a, b) => b.sizeGB - a.sizeGB)[0];
};

// 목록 → 화면용 카드. installed: 내려받은 모델 이름 배열, exact: { '이름:태그': 실제 바이트 }(알려진 것만).
export function buildCards(entries, pc, installed = [], exact = {}) {
  const have = new Set(installed);
  const chat = entries.filter((e) => isChatModel(e));
  const cards = chat.map((e) => {
    const tags = e.sizes.length ? e.sizes : ['latest'];
    const variants = tags.map((tag) => {
      const modelName = `${e.name}:${tag}`;
      const real = exact[modelName] ? Math.round(exact[modelName] / 1e9 * 10) / 10 : 0;
      const sizeGB = real || estimateTag(tag);
      return { tag, name: modelName, sizeGB, exact: !!real, fit: sizeGB ? fitFor(sizeGB, pc) : 'ok', installed: have.has(modelName) || (tag === 'latest' && have.has(e.name)) };
    });
    const best = bestVariant(variants);
    return { e, variants, best, d: describe(e, best?.tag, best?.sizeGB, pc) };
  });
  // 같은 계열에서 더 새 세대가 있고 그것이 이 PC 에서 돌아가면, 옛 세대는 '이전 세대' 로 내린다.
  const usable = (c) => c.d.fit === 'fast' || c.d.fit === 'ok';
  const out = cards.map((c) => {
    const k = familyKey(c.e.name);
    const recent = c.e.newestRank >= 0 && c.e.newestRank < RECENT_RANK;
    const outdated = !recent && cards.some((o) => o !== c && familyKey(o.e.name) === k && cmpVersion(o.e.name, c.e.name) > 0 && usable(o));
    const unknownSize = !c.best?.sizeGB;
    const ageDays = c.e.updatedAt ? (Date.now() - Date.parse(c.e.updatedAt)) / 864e5 : null;
    const isNew = c.e.newestRank >= 0 && c.e.newestRank < 20;
    const score = Math.log10(Math.max(c.e.pulls, 1)) * 10 + (isNew ? 12 : 0) + (ageDays != null && ageDays < 45 ? 6 : 0) - (ageDays != null && ageDays > 400 ? 20 : 0) + FIT[c.d.fit].level * 8 + (c.e.caps.includes('tools') ? 3 : 0) - (outdated ? 40 : 0) - (c.d.fit === 'no' ? 30 : 0) - (unknownSize ? 12 : 0);
    return {
      id: c.e.name, name: c.e.name, ...c.d,
      variants: c.variants, best: c.best?.tag || '', caps: c.e.caps, purposes: purposesOf(c.e, c.best ? paramsB(c.best.tag) : 0),
      isNew, outdated, popular: c.e.pulls, updatedAt: c.e.updatedAt, about: c.e.desc, installed: c.variants.some((v) => v.installed), score,
    };
  });
  out.sort((a, b) => b.score - a.score);
  // 「추천」: 용도마다 가장 좋은 둘씩(이 PC 에서 돌아가고 크기를 아는 최신 모델).
  const picked = new Set();
  for (const purpose of ['work', 'code', 'vision', 'think', 'light']) {
    out.filter((c) => !c.outdated && c.purposes.includes(purpose) && (c.fit === 'fast' || c.fit === 'ok') && c.sizeGB > 0 && !picked.has(c.name)).slice(0, 2).forEach((c) => picked.add(c.name));
  }
  for (const c of out) c.featured = picked.has(c.name);
  return out;
}

// 이미 내려받은 모델(이름·크기) → 카드. 목록에 없는 모델(직접 만든 것 등)은 일반 설명을 붙인다.
export function describeInstalled(model, entries, pc) {
  const [base, tag = 'latest'] = String(model.name).split(':');
  const e = entries.find((x) => x.name === base);
  const sizeGB = Math.round(model.size / 1e9 * 10) / 10;
  if (!e) {
    const b = Math.max(0.1, (sizeGB - 0.5) / 0.62);
    const d = describe({ name: base, desc: '', caps: [], sizes: [] }, `${b.toFixed(1)}b`, sizeGB, pc);
    return { name: model.name, base, tag, sizeGB, custom: true, caps: [], purposes: ['work'], ...d, headline: '내가 가져오거나 직접 만든 모델', family: '', can: ['대화·요약·글쓰기'], expect: '목록에 없는 모델이라 정확한 성능은 알 수 없어요. 크기로 보면 ' + d.expect };
  }
  return { name: model.name, base, tag, sizeGB, custom: false, caps: e.caps, purposes: purposesOf(e, paramsB(tag)), ...describe(e, tag, sizeGB, pc) };
}

// ── 목록 가져오기(기억·저장) ──
export function createCatalog({ fetchImpl = fetch, cacheFile = '', now = Date.now } = {}) {
  let mem = null;
  const load = () => { if (mem) return mem; const j = cacheFile ? readJson(cacheFile, null) : null; if (j?.entries?.length) mem = j; return mem; };
  const page = async (sort) => {
    const r = await fetchImpl(`${LIBRARY}?sort=${sort}`, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`ollama.com 응답 ${r.status}`);
    return parseLibrary(await r.text());
  };
  async function refresh() {
    const [popular, newest] = await Promise.all([page('popular'), page('newest')]);
    const byName = new Map();
    for (const e of [...popular, ...newest]) if (!byName.has(e.name)) byName.set(e.name, e);
    const newestChat = newest.filter((e) => isChatModel(e));
    const entries = [...byName.values()].map((e) => ({ ...e, newestRank: newestChat.findIndex((x) => x.name === e.name) }));
    if (!entries.length) throw new Error('모델 목록을 읽지 못했습니다(ollama.com 화면 구조가 바뀌었을 수 있어요).');
    mem = { fetchedAt: new Date(now()).toISOString(), entries };
    if (cacheFile) { try { writeJson(cacheFile, mem); } catch { /* 저장 실패는 무시 */ } }
    return mem;
  }
  // 반환: { entries, fetchedAt, source: 'live'|'cache'|'builtin', error? }
  async function get({ force = false } = {}) {
    const have = load();
    const fresh = have && now() - Date.parse(have.fetchedAt) < TTL_MS;
    if (have && fresh && !force) return { ...have, source: 'cache' };
    try { const m = await refresh(); return { ...m, source: 'live' }; }
    catch (e) {
      if (have) return { ...have, source: 'cache', error: e.message };
      return { entries: BUILTIN, fetchedAt: '', source: 'builtin', error: e.message };
    }
  }
  // 내려받을 정확한 크기(바이트). 라이브러리 모델이 아니거나 못 읽으면 null.
  async function exactSize(name) {
    const [base, tag = 'latest'] = String(name).split(':');
    if (!/^[a-z0-9._-]+$/.test(base) || !/^[A-Za-z0-9._-]+$/.test(tag)) return null;
    try {
      const r = await fetchImpl(`${REGISTRY}/${base}/manifests/${tag}`, { headers: { ...UA, accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return null;
      const j = await r.json();
      const sum = (j.layers || []).reduce((a, l) => a + (l.size || 0), 0) + (j.config?.size || 0);
      return sum > 0 ? sum : null;
    } catch { return null; }
  }
  return { get, exactSize };
}

export const _test = { decode, parseCount };
