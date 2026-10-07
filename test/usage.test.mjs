import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const U = await import('../src/usage.mjs');
const { createEngines } = await import('../src/engines.mjs');
test('provider token formats include total input and distinct cached reads/writes', () => {
  assert.deepEqual(U.normalizeUsage('openai', { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } }),
    { status: 'measured', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 });
  assert.equal(U.normalizeUsage('anthropic', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }).inputTokens, 140);
  assert.equal(U.normalizeUsage('codex', { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30 }).cacheReadTokens, 30);
  assert.equal(U.normalizeUsage('ollama', { prompt_eval_count: 100, eval_count: 20 }).outputTokens, 20);
  assert.equal(U.normalizeUsage('hermes', {}).inputTokens, null);
});
test('engine preserves text callers while recording actual response model and usage with bot identity', async () => {
  const events = [];
  const engines = createEngines({ secrets: { get: async () => 'test-key' }, usage: { record: e => events.push(e) },
    fetchImpl: async () => new Response(JSON.stringify({ id: 'provider-id', model: 'actual', choices: [{ message: { content: 'Answer' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } })) });
  const result = await engines.complete({ engine: { type: 'openai', model: 'alias' }, messages: [{ role: 'user', content: 'Test' }],
    context: { requestId: 'request-one', botId: 'bot', botName: 'Test bot', agentKey: 'qa' } });
  assert.equal(result, 'Answer');
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'actual');
  assert.equal(events[0].botId, 'bot');
  assert.equal(events[0].inputTokens, 12);
  assert.equal(events[0].providerRequestId, 'provider-id');
});
test('engine failure records unknown usage instead of inventing zero token counts', async () => {
  const events = [];
  const engines = createEngines({ secrets: { get: async () => 'test-key' }, usage: { record: e => events.push(e) }, fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(engines.complete({ engine: { type: 'openai', model: 'm' }, messages: [{ role: 'user', content: 'Test' }] }), /offline/);
  assert.equal(events[0].success, false);
  assert.equal(events[0].inputTokens, null);
});
test('CLI JSON yields measured subscription usage and actual Claude model without storing prompts', async () => {
  const engines = createEngines({ components: { detect: async () => ({ installed: true, path: 'claude' }) }, runImpl: async (_path, args) => {
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    return { code: 0, stdout: JSON.stringify({ result: 'CLI answer', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }, modelUsage: { 'claude-actual': {} } }) };
  } });
  const result = await engines.completeDetailed({ engine: { type: 'claude', model: 'sonnet' }, messages: [{ role: 'user', content: 'Private prompt' }] });
  assert.equal(result.text, 'CLI answer');
  assert.equal(result.inputTokens, 13);
  assert.equal(result.model, 'claude-actual');
  assert.equal(result.billing, 'subscription');
  assert.equal(result.modelSource, 'provider');
  assert.equal(JSON.stringify(result).includes('Private prompt'), false);
});
test('null usage and invalid provider counters stay unknown', () => {
  assert.equal(U.normalizeUsage('openai', null).status, 'unknown');
  assert.equal(U.normalizeUsage('openai', { prompt_tokens: -1, completion_tokens: 3 }).status, 'unknown');
});
test('ledger persists, deduplicates request IDs and calculates only priced measured API usage', () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-test-'));
  const usage = U.createUsage({ home });
  usage.setPricing({ currency: 'USD', asOf: '2026-10-07', models: [{ provider: 'openai', model: 'actual', inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 1, cacheWritePerMillion: 3 }] });
  const event = { requestId: 'one', botId: 'bot', provider: 'openai', model: 'actual', success: true, billing: 'api', ...U.normalizeUsage('openai', { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } }) };
  usage.record(event); usage.record(event);
  usage.record({ ...event, requestId: 'two', billing: 'subscription' });
  usage.record({ requestId: 'three', provider: 'hermes', model: 'm', botId: 'bot', success: false, ...U.normalizeUsage('hermes', {}) });
  const result = U.createUsage({ home }).query();
  assert.equal(result.totals.requests, 3);
  assert.equal(result.events[0].cost, 0.00034);
  assert.equal(result.events[1].cost, null);
  assert.equal(result.totals.cost, null);
  assert.equal(result.totals.inputTokens, null);
  assert.equal(result.totals.knownTokens.inputTokens, 200);
  assert.equal(result.bots[0].unknown, 1);
  assert.equal(usage.query({ model: 'actual' }).totals.requests, 2);
  assert.throws(() => usage.setPricing({ currency: 'USD', models: [{ provider: 'openai', model: 'm', inputPerMillion: -1 }] }), /단가/);
});
test('structurally damaged usage ledger recovers a valid previous ledger instead of displaying fabricated zeros', () => {
  const home = mkdtempSync(join(tmpdir(), 'usage-recovery-'));
  const usage = U.createUsage({ home });
  usage.record({ requestId: 'first', provider: 'hermes', ...U.normalizeUsage('hermes') });
  usage.record({ requestId: 'second', provider: 'hermes', ...U.normalizeUsage('hermes') });
  writeFileSync(join(home, 'usage', 'ledger.json'), '{"events":[{}]}');
  assert.equal(usage.query().totals.requests, 1);
  assert.equal(usage.query().events[0].requestId, 'first');
  assert.equal(usage.query().totals.inputTokens, null);
});
