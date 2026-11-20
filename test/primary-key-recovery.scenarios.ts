import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/server/config-defaults.js';
import { startApp, postJson, startUpstream, captureBody, writeJsonResponse, waitForLogEntry } from './helpers/server-test-utils.js';

afterEach(() => vi.restoreAllMocks());

it('returns a healthy spread key to HTTP traffic after a short transient incident', async () => {
  let incident = true;
  const used: string[] = [];
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    const key = req.headers.authorization === 'Bearer synthetic-a' ? 'a' : 'b';
    used.push(key);
    writeJsonResponse(res, incident && key === 'a' ? { error: 'Service unavailable' }
      : { id: `resp-${used.length}`, status: 'completed', output: [] }, incident && key === 'a' ? 503 : 200);
  });
  const primary = { ...DEFAULT_CONFIG.primary, base_url: upstream.url, api_key: '', api_key_env: '', key_strategy: 'spread',
    api_keys: ['a', 'b'].map(id => ({ id, label: id, api_key: `synthetic-${id}`, enabled: true })) };
  let roll = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => roll);
  const app = await startApp(upstream.url, undefined, { primary, profile_scopes: { codex: {
    active_profile_id: 'p', profiles: [{ id: 'p', name: 'P', config: { primary } }]
  } } });
  let clock = Date.now();
  const originalNow = performance.now.bind(performance);
  let elapsed = 0;
  async function request(session: string) {
    const response = await postJson(app.url, '/v1/responses', { model: 'fixture', input: 'hi', prompt_cache_key: session });
    await response.text();
    await waitForLogEntry(app.url, log => log.request_id === response.headers.get('x-compactgate-request-id'));
    return response.status;
  }
  expect(await request('incident')).toBe(503);
  expect(await request('incident')).toBe(503);
  incident = false;
  elapsed = 7 * 24 * 60 * 60 * 1000;
  clock += elapsed;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(performance, 'now').mockImplementation(() => originalNow() + elapsed);
  // Sweep the draw after all documented cooldowns and session TTLs have elapsed.
  for (let i = 0; i < 20; i++) {
    roll = i / 20;
    expect(await request(`new-${i}`)).toBe(200);
  }
  expect(used.slice(2)).toContain('a');
});
