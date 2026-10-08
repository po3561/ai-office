// Provider counters only. Never infer token counts from text or API bills from subscriptions.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, need } from './util.mjs';
import { readDurableJson, writeDurableJson } from './durable-json.mjs';

const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
export function normalizeUsage(provider, raw = {}) {
  raw ||= {};
  let input, output, read, write;
  if (provider === 'openai') {
    input = count(raw.prompt_tokens ?? raw.input_tokens); output = count(raw.completion_tokens ?? raw.output_tokens);
    read = count(raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? 0);
    write = count(raw.prompt_tokens_details?.cache_write_tokens ?? raw.input_tokens_details?.cache_write_tokens ?? 0);
  } else if (provider === 'anthropic' || provider === 'claude') {
    read = count(raw.cache_read_input_tokens ?? 0); write = count(raw.cache_creation_input_tokens ?? 0);
    const uncached = count(raw.input_tokens);
    input = uncached === null || read === null || write === null ? null : uncached + read + write;
    output = count(raw.output_tokens);
  } else if (provider === 'codex') {
    input = count(raw.input_tokens); output = count(raw.output_tokens);
    read = count(raw.cached_input_tokens ?? 0); write = count(raw.cache_creation_input_tokens ?? raw.cache_write_tokens ?? 0);
  } else if (provider === 'ollama') {
    input = count(raw.prompt_eval_count); output = count(raw.eval_count);
    read = count(raw.prompt_eval_cached_count ?? 0); write = 0;
  }
  if (input == null || output == null || read == null || write == null || read + write > input) {
    return { status: 'unknown', ...Object.fromEntries(fields.map(f => [f, null])) };
  }
  return { status: 'measured', inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write };
}
const validLedger = v => Boolean(v && Array.isArray(v.events) && v.events.every(e => e && typeof e.requestId === 'string' && e.requestId
  && typeof e.provider === 'string' && typeof e.model === 'string' && Number.isFinite(Date.parse(e.at))
  && ['measured', 'estimated', 'unknown'].includes(e.status) && fields.every(f => e.status === 'unknown' ? e[f] === null : count(e[f]) !== null)));
const emptyPricing = () => ({ currency: 'USD', asOf: '', models: [] });
const rates = ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'];
const validPricing = v => Boolean(v && /^[A-Z]{3}$/.test(v.currency) && Array.isArray(v.models) && v.models.every(m => m && typeof m.provider === 'string' && typeof m.model === 'string' && rates.every(f => m[f] == null || (Number.isFinite(m[f]) && m[f] >= 0))));

export function createUsage({ home, now = () => new Date().toISOString() }) {
  const ledgerFile = join(home, 'usage', 'ledger.json');
  const pricingFile = join(home, 'usage', 'pricing.json');
  function readLedger() {
    const r = readDurableJson(ledgerFile, validLedger);
    need(r.value || r.status === 'missing', '사용량 원장이 손상되었습니다. 복구가 필요합니다.', 409);
    return r.value || { version: 1, events: [] };
  }
  function pricing() {
    const r = readDurableJson(pricingFile, validPricing);
    need(r.value || r.status === 'missing', '사용량 단가 설정이 손상되었습니다.', 409);
    return r.value || emptyPricing();
  }
  function setPricing(value) {
    need(validPricing(value), '단가 형식이 올바르지 않습니다. 음수·무한대 단가는 사용할 수 없습니다.');
    need(new Set(value.models.map(m => `${m.provider}\0${m.model}`)).size === value.models.length, '같은 공급자·모델 단가가 중복됩니다.');
    const p = { currency: value.currency, asOf: String(value.asOf || now()).slice(0, 40), models: value.models.map(m => ({ provider: m.provider, model: m.model, ...Object.fromEntries(rates.map(f => [f, m[f] ?? null])) })) };
    writeDurableJson(pricingFile, p, validPricing); return p;
  }
  function record(input) {
    const ledger = readLedger();
    const requestId = String(input.requestId || randomUUID());
    if (ledger.events.some(e => e.requestId === requestId && e.botId === String(input.botId || ''))) return false;
    const status = ['measured', 'estimated'].includes(input.status) && fields.every(f => count(input[f]) !== null) ? input.status : 'unknown';
    const event = { requestId, providerRequestId: String(input.providerRequestId || ''), provider: String(input.provider || ''), model: String(input.model || ''),
      botId: String(input.botId || ''), botName: String(input.botName || ''), agentKey: String(input.agentKey || ''), at: input.at || now(), success: input.success !== false,
      requestedModel: String(input.requestedModel || input.model || ''), modelSource: ['provider', 'requested'].includes(input.modelSource) ? input.modelSource : 'unknown',
      billing: ['api', 'subscription', 'local'].includes(input.billing) ? input.billing : 'unknown', status,
      ...Object.fromEntries(fields.map(f => [f, status === 'unknown' ? null : input[f]])) };
    ledger.events.push(event); writeDurableJson(ledgerFile, ledger, validLedger); return true;
  }
  function cost(event, p) {
    if (event.status === 'unknown' || event.billing !== 'api') return null;
    const m = p.models.find(m => m.provider === event.provider && m.model === event.model);
    // 단가를 정하지 않았으면 공급자 쪽(Hermes 등)이 스스로 계산해 둔 값을 쓴다.
    if (!m) return Number.isFinite(event.providerCostUsd) ? event.providerCostUsd : null;
    const amounts = [Math.max(0, event.inputTokens - event.cacheReadTokens - event.cacheWriteTokens), event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens];
    if (amounts.some((n, i) => n > 0 && m[rates[i]] == null)) return null;
    return Number((amounts.reduce((sum, n, i) => sum + n * (m[rates[i]] ?? 0), 0) / 1e6).toFixed(12));
  }
  // 바깥 기록(Hermes 세션 요약 등)은 한 줄이 여러 번의 호출(calls)을 담는다.
  const calls = e => e.calls || 1;
  const n = (events, test) => events.reduce((sum, e) => sum + (test(e) ? calls(e) : 0), 0);
  function aggregate(events) {
    const knownTokens = Object.fromEntries(fields.map(f => [f, events.reduce((sum, e) => sum + (e[f] ?? 0), 0)]));
    const unknown = n(events, e => e.status === 'unknown');
    const unpricedRequests = n(events, e => e.cost === null);
    const knownCost = Number(events.reduce((sum, e) => sum + (e.cost ?? 0), 0).toFixed(12));
    return { requests: n(events, () => true), successful: n(events, e => e.success), measured: n(events, e => e.status === 'measured'),
      unknown, estimated: n(events, e => e.status === 'estimated'), ...Object.fromEntries(fields.map(f => [f, unknown ? null : knownTokens[f]])),
      knownTokens, cost: unpricedRequests ? null : knownCost, knownCost, unpricedRequests };
  }
  // observed: 이 프로그램 밖에서 일한 봇(Claude 사무실·Hermes)의 기록에서 읽어 온 사건. 원장에는 저장하지 않는다.
  // 응답에는 최근 사건만 싣는다(합계는 전체로 계산). 사무실 기록은 몇 주면 수천 건이 된다.
  function query({ from, to, botId, model } = {}, observed = [], { eventsLimit = 300 } = {}) {
    for (const date of [from, to]) need(!date || Number.isFinite(Date.parse(date)), '기간 날짜가 올바르지 않습니다.');
    const p = pricing();
    const events = [...readLedger().events, ...observed].filter(e => (!from || Date.parse(e.at) >= Date.parse(from)) && (!to || Date.parse(e.at) <= Date.parse(to)) && (!botId || e.botId === botId) && (!model || e.model === model))
      .map(e => ({ ...e, cost: cost(e, p) })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const grouped = key => { const map = new Map(); for (const e of events) { const k = key(e); if (!map.has(k)) map.set(k, []); map.get(k).push(e); } return [...map.values()]; };
    return { totals: aggregate(events), bots: grouped(e => e.botId).map(es => ({ botId: es[0].botId, botName: es[0].botName, ...aggregate(es) })),
      models: grouped(e => `${e.provider}\0${e.model}`).map(es => ({ provider: es[0].provider, model: es[0].model, ...aggregate(es) })), events: events.slice(-eventsLimit), pricing: p };
  }
  return { record, query, setPricing, pricing };
}
