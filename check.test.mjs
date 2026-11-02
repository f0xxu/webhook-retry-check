import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWebhook } from './check.mjs';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const event = { eventId: 'SYNTHETIC-event-1', note: 'SYNTHETIC DATA ONLY' };

async function fixture(t, handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/hook`, observeUrl: `${origin}/stats` };
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let value = '';
  for await (const chunk of req) value += chunk;
  return value;
}

function options(target, overrides = {}) {
  return { url: target.url, observeUrl: target.observeUrl, payload: event, settleMs: 0, ...overrides };
}

test('safe receiver passes from a non-zero baseline; all deliveries contain the identical event', async t => {
  let created = 7;
  const seen = new Set();
  const received = [];
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created });
    const raw = await body(req);
    received.push(raw);
    const { eventId } = JSON.parse(raw);
    if (!seen.has(eventId)) { seen.add(eventId); created++; }
    return json(res, 200, { accepted: true });
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.equal(result.before, 7);
  assert.equal(result.after, 8);
  assert.equal(result.delta, 1);
  assert.equal(received.length, 3);
  assert.equal(new Set(received).size, 1);
  assert.deepEqual(JSON.parse(received[0]), event);
  assert.deepEqual(result.requests.map(r => r.status), [200, 200, 200]);
});

test('three HTTP 200 responses cannot hide three business effects', async t => {
  let created = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created });
    await body(req);
    created++;
    return json(res, 200, { accepted: true });
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.equal(result.delta, 3);
  assert.deepEqual(result.requests.map(r => r.status), [200, 200, 200]);
});

test('the initial pair overlaps and the third request starts after the pair has finished', async t => {
  let posts = 0;
  let active = 0;
  let maxActive = 0;
  let completedPair = 0;
  let thirdSawCompletedPair = false;
  let releasePair;
  const barrier = new Promise(resolve => { releasePair = resolve; });
  const fallback = setTimeout(() => releasePair(), 500);
  t.after(() => clearTimeout(fallback));
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created: posts ? 1 : 0 });
    await body(req);
    const index = ++posts;
    active++;
    maxActive = Math.max(maxActive, active);
    if (index <= 2) {
      if (index === 2) releasePair();
      await barrier;
      completedPair++;
    } else thirdSawCompletedPair = completedPair === 2;
    active--;
    return json(res, 200, {});
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'PASS');
  assert.equal(maxActive, 2, 'a serial sender cannot reach both waiting handlers together');
  assert.equal(posts, 3);
  assert.equal(thirdSawCompletedPair, true);
});

test('an unreadable baseline stops before any POST is sent', async t => {
  let posts = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'POST') posts++;
    return json(res, 503, { created: 0 });
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(result.exitCode, 2);
  assert.equal(result.before, null);
  assert.equal(posts, 0);
  assert.equal(result.requests.length, 0);
  assert.equal(result.deliveryCount, 0);
});

test('losing observation after delivery is inconclusive rather than a duplicate verdict', async t => {
  let observations = 0;
  let posts = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, ++observations === 1 ? 200 : 500, { created: 9 });
    await body(req);
    posts++;
    return json(res, 200, {});
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(result.exitCode, 2);
  assert.equal(result.before, 9);
  assert.equal(result.after, null);
  assert.equal(result.delta, null);
  assert.equal(posts, 3);
});

test('counter must be an actual non-negative safe integer, before sending anything', async t => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1', true, {}]) {
    await t.test(`rejects ${JSON.stringify(value)}`, async sub => {
      let posts = 0;
      const target = await fixture(sub, (req, res) => {
        if (req.method === 'POST') posts++;
        return json(res, 200, { created: value });
      });
      const result = await checkWebhook(options(target));
      assert.equal(result.verdict, 'INCONCLUSIVE');
      assert.equal(result.exitCode, 2);
      assert.equal(posts, 0);
    });
  }
});

test('nested counters work, while inherited numeric properties are not treated as observations', async t => {
  let posts = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { stats: { accepted: posts ? 4 : 3 } });
    await body(req);
    posts++;
    return json(res, 200, {});
  });
  const nested = await checkWebhook(options(target, { countPath: 'stats.accepted' }));
  assert.equal(nested.verdict, 'PASS');
  assert.equal(nested.delta, 1);

  posts = 0;
  const key = 'testOnlyInheritedWebhookCounter';
  assert.equal(Object.hasOwn(Object.prototype, key), false);
  Object.defineProperty(Object.prototype, key, { value: 17, configurable: true });
  try {
    const inherited = await checkWebhook(options(target, { countPath: key }));
    assert.equal(inherited.verdict, 'INCONCLUSIVE');
    assert.equal(posts, 0);
  } finally {
    delete Object.prototype[key];
  }
});

test('prototype traversal and remote endpoints are rejected before any local request', async t => {
  let calls = 0;
  const target = await fixture(t, (_req, res) => {
    calls++;
    return json(res, 200, { created: 0 });
  });
  for (const countPath of ['__proto__.created', 'stats.constructor.value', 'stats.prototype.value']) {
    await assert.rejects(checkWebhook(options(target, { countPath })), /INVALID_COUNT_PATH/);
  }
  await assert.rejects(checkWebhook(options(target, { url: 'https://example.invalid/hook' })), /REMOTE_URL_REQUIRES_ALLOW_REMOTE/);
  await assert.rejects(checkWebhook(options(target, { observeUrl: 'https://example.invalid/stats' })), /REMOTE_URL_REQUIRES_ALLOW_REMOTE/);
  await assert.rejects(checkWebhook(options(target, { url: target.url.replace('://', '://user:PRIVATE_CREDENTIAL@') })), /INVALID_URL/);
  assert.equal(calls, 0);
});

test('an observer redirect is not followed and no delivery occurs', async t => {
  let trapCalls = 0;
  let posts = 0;
  const trap = await fixture(t, (_req, res) => { trapCalls++; return json(res, 200, { created: 0 }); });
  const target = await fixture(t, (req, res) => {
    if (req.method === 'POST') posts++;
    return json(res, 302, {}, { Location: trap.observeUrl });
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(trapCalls, 0);
  assert.equal(posts, 0);
});

test('POST redirects are recorded as failures without contacting the redirected target', async t => {
  let trapCalls = 0;
  let posts = 0;
  const trap = await fixture(t, (_req, res) => { trapCalls++; return json(res, 200, {}); });
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created: 0 });
    await body(req);
    posts++;
    return json(res, 307, {}, { Location: trap.url });
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.equal(posts, 3);
  assert.equal(trapCalls, 0);
  assert.deepEqual(result.requests.map(r => r.status), [307, 307, 307]);
});

test('a single business effect does not hide rejected HTTP responses', async t => {
  let posts = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created: posts ? 1 : 0 });
    await body(req);
    posts++;
    return json(res, 500, { private: 'NOT_FOR_REPORT' });
  });

  const result = await checkWebhook(options(target));
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.delta, 1);
  assert.equal(result.reason, 'HTTP_STATUS_REJECTED');
});

test('the observation window allows a deliberately delayed local business effect', async t => {
  let created = 0;
  let scheduled = false;
  let timer;
  t.after(() => clearTimeout(timer));
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created });
    await body(req);
    if (!scheduled) {
      scheduled = true;
      timer = setTimeout(() => { created++; }, 20);
    }
    return json(res, 200, {});
  });

  const result = await checkWebhook(options(target, { settleMs: 100 }));
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.delta, 1);
});

test('request timeouts remain bounded and are reported as inconclusive', { timeout: 5000 }, async t => {
  let posts = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created: 0 });
    await body(req);
    posts++;
    // Intentionally leave the response open until the client's timeout cancels it.
  });

  const started = performance.now();
  const result = await checkWebhook(options(target, { timeoutMs: 100 }));
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(result.exitCode, 2);
  assert.equal(posts, 3);
  assert.equal(result.requests.length, 3);
  assert.equal(result.requests.every(r => r.status === null && typeof r.error === 'string'), true);
  assert.ok(performance.now() - started < 4000);
});

test('reports omit body, query, path and response canaries', async t => {
  const canaries = ['PAYLOAD_SECRET_CANARY', 'QUERY_SECRET_CANARY', 'PATH_SECRET_CANARY', 'RESPONSE_SECRET_CANARY'];
  let posts = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created: posts ? 1 : 0, private: canaries[3] });
    await body(req);
    posts++;
    return json(res, 200, { private: canaries[3] });
  });

  const result = await checkWebhook(options(target, {
    payload: { eventId: 'SYNTHETIC-event-1', secret: canaries[0] },
    url: `${target.origin}/${canaries[2]}?token=${canaries[1]}`,
    observeUrl: `${target.origin}/stats?token=${canaries[1]}`,
  }));
  assert.equal(result.verdict, 'PASS');
  const serialized = JSON.stringify(result);
  for (const canary of canaries) assert.equal(serialized.includes(canary), false);
  assert.equal(result.targetOrigin, target.origin);
});

test('CLI help is available without a target or payload file', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, '--help'], { timeout: 5000 });
  assert.match(stdout, /--url/);
  assert.match(stdout, /--observe-url/);
  assert.match(stdout, /--payload/);
  assert.equal(stderr, '');
});

test('CLI JSON report and process exit code preserve a duplicate failure', async t => {
  let created = 0;
  const target = await fixture(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { created });
    await body(req);
    created++;
    return json(res, 200, {});
  });
  const directory = await mkdtemp(join(tmpdir(), 'webhook-retry-check-test-'));
  const payloadPath = join(directory, 'synthetic.json');
  await writeFile(payloadPath, JSON.stringify(event));
  t.after(async () => { await unlink(payloadPath); await rmdir(directory); });
  try {
    await execFileAsync(process.execPath, [cliPath, '--url', target.url, '--observe-url', target.observeUrl,
      '--payload', payloadPath, '--settle-ms', '0', '--json'], { timeout: 5000 });
    assert.fail('duplicate effects must not produce a successful process exit');
  } catch (error) {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.verdict, 'FAIL');
    assert.equal(report.delta, 3);
    assert.equal(error.stderr, '');
  }
});

test('CLI unreadable-file errors contain no private path or raw exception', async () => {
  const missing = join(tmpdir(), 'PRIVATE_PATH_CANARY', 'missing.json');
  try {
    await execFileAsync(process.execPath, [cliPath, '--url', 'http://127.0.0.1:1/hook',
      '--observe-url', 'http://127.0.0.1:1/stats', '--payload', missing, '--json'], { timeout: 5000 });
    assert.fail('an unreadable payload file must fail');
  } catch (error) {
    assert.equal(error.code, 2);
    const report = JSON.parse(error.stdout);
    assert.equal(report.verdict, 'INCONCLUSIVE');
    assert.equal(report.reason, 'PAYLOAD_FILE_UNREADABLE');
    assert.equal((error.stdout + error.stderr).includes('PRIVATE_PATH_CANARY'), false);
    assert.equal((error.stdout + error.stderr).includes('ENOENT'), false);
  }
});
