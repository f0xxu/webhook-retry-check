#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { checkWebhook } from './check.mjs';

const HELP = `webhook-retry-check 0.1.0

Check a fresh test event with two concurrent POSTs and one later repeat.
An independent GET counter must increase by exactly one.

Usage:
  webhook-retry-check --url URL --observe-url URL --payload file.json [options]

Options:
  --count-path PATH    Own-property dot path to the counter (default: created)
  --settle-ms NUMBER   Observation delay, 0..5000 (default: 250)
  --timeout-ms NUMBER  Each request timeout, 100..10000 (default: 3000)
  --allow-remote      Allow non-loopback URLs for explicitly authorized tests
  --json              Emit a machine-readable report
  --help              Show this help

Only test endpoints you own or have permission to exercise. The three POSTs
can create real effects. Use synthetic data and an isolated counter. PASS
describes this scenario and observation window, not an exactly-once guarantee.
Reports omit payloads, response bodies, headers, URL paths and query strings.
`;

const VALUE_FLAGS = new Map([
  ['--url', 'url'], ['--observe-url', 'observeUrl'], ['--payload', 'payloadFile'],
  ['--count-path', 'countPath'], ['--settle-ms', 'settleMs'], ['--timeout-ms', 'timeoutMs'],
]);
const BOOLEAN_FLAGS = new Map([['--allow-remote', 'allowRemote'], ['--json', 'json']]);

function parse(args) {
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error('INVALID_CLI_ARGUMENTS');
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) {
      options[BOOLEAN_FLAGS.get(flag)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag) || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new Error('INVALID_CLI_ARGUMENTS');
    }
    options[VALUE_FLAGS.get(flag)] = args[++index];
  }
  if (!options.url || !options.observeUrl || !options.payloadFile) throw new Error('MISSING_REQUIRED_ARGUMENTS');
  for (const key of ['settleMs', 'timeoutMs']) {
    if (options[key] !== undefined) {
      if (!/^\d+$/.test(options[key])) throw new Error('INVALID_CLI_ARGUMENTS');
      options[key] = Number(options[key]);
    }
  }
  return options;
}

function failure(code) {
  return { verdict: 'INCONCLUSIVE', exitCode: 2, reason: code, before: null, after: null, delta: null, plannedDeliveries: 3, deliveryCount: 0, requests: [] };
}

function display(result, json) {
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const value = number => number === null ? 'unknown' : number;
  const lines = [
    `${result.verdict}: ${result.reason}`,
    `Deliveries: ${result.deliveryCount}/${result.plannedDeliveries}`,
    `Counter: ${value(result.before)} -> ${value(result.after)} (delta ${value(result.delta)})`,
  ];
  if (result.requests.length) {
    lines.push('HTTP: ' + result.requests.map(request => request.status ?? request.error).join(', '));
  }
  if (result.targetOrigin) lines.push('Target origin: ' + result.targetOrigin);
  lines.push('Bounded test only; not an exactly-once guarantee.');
  process.stdout.write(lines.join('\n') + '\n');
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write(HELP);
} else {
  let result;
  try {
    const options = parse(args);
    let contents;
    try {
      const info = await stat(options.payloadFile);
      if (!info.isFile()) throw new Error('PAYLOAD_FILE_UNREADABLE');
      if (info.size > 64 * 1024) throw new Error('PAYLOAD_FILE_TOO_LARGE');
      contents = await readFile(options.payloadFile, 'utf8');
      if (Buffer.byteLength(contents, 'utf8') > 64 * 1024) throw new Error('PAYLOAD_FILE_TOO_LARGE');
    } catch (error) {
      throw new Error(error?.message === 'PAYLOAD_FILE_TOO_LARGE' ? 'PAYLOAD_FILE_TOO_LARGE' : 'PAYLOAD_FILE_UNREADABLE');
    }
    try { options.payload = JSON.parse(contents); } catch { throw new Error('INVALID_PAYLOAD_JSON'); }
    result = await checkWebhook(options);
  } catch (error) {
    const allowed = new Set([
      'INVALID_CLI_ARGUMENTS', 'MISSING_REQUIRED_ARGUMENTS', 'PAYLOAD_FILE_UNREADABLE',
      'PAYLOAD_FILE_TOO_LARGE', 'INVALID_PAYLOAD_JSON', 'INVALID_OPTIONS', 'INVALID_URL',
      'INVALID_URL_PROTOCOL', 'INVALID_URL_CREDENTIALS', 'REMOTE_URL_REQUIRES_ALLOW_REMOTE',
      'INVALID_PAYLOAD', 'PAYLOAD_TOO_LARGE', 'INVALID_COUNT_PATH', 'INVALID_SETTLE_MS',
      'INVALID_TIMEOUT_MS', 'INVALID_ALLOW_REMOTE',
    ]);
    result = failure(allowed.has(error?.message) ? error.message : 'UNEXPECTED_ERROR');
  }
  display(result, args.includes('--json'));
  process.exitCode = result.exitCode;
}
