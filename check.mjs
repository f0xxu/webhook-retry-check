import { setTimeout as sleep } from 'node:timers/promises';

const MAX_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(code) {
  throw new Error(code);
}

function endpoint(value, allowRemote) {
  if (typeof value !== 'string') invalid('INVALID_URL');
  let parsed;
  try { parsed = new URL(value); } catch { invalid('INVALID_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) invalid('INVALID_URL_PROTOCOL');
  if (parsed.username || parsed.password) invalid('INVALID_URL_CREDENTIALS');
  if (!allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    invalid('REMOTE_URL_REQUIRES_ALLOW_REMOTE');
  }
  return parsed;
}

function boundedInteger(value, fallback, min, max, code) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) invalid(code);
  return resolved;
}

function optionsFor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('INVALID_OPTIONS');
  if (options.allowRemote !== undefined && typeof options.allowRemote !== 'boolean') {
    invalid('INVALID_ALLOW_REMOTE');
  }
  const allowRemote = options.allowRemote ?? false;
  const target = endpoint(options.url, allowRemote);
  const observer = endpoint(options.observeUrl, allowRemote);
  if (!options.payload || typeof options.payload !== 'object' || Array.isArray(options.payload)) {
    invalid('INVALID_PAYLOAD');
  }
  let body;
  try { body = JSON.stringify(options.payload); } catch { invalid('INVALID_PAYLOAD'); }
  // A custom toJSON must not turn the required object into a primitive or array.
  let parsedBody;
  try { parsedBody = JSON.parse(body); } catch { invalid('INVALID_PAYLOAD'); }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    invalid('INVALID_PAYLOAD');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) invalid('PAYLOAD_TOO_LARGE');
  const countPath = options.countPath ?? 'created';
  if (typeof countPath !== 'string' || countPath.length > 256) invalid('INVALID_COUNT_PATH');
  const parts = countPath.split('.');
  if (parts.length > 16 || parts.some(part => !part || UNSAFE_KEYS.has(part))) {
    invalid('INVALID_COUNT_PATH');
  }
  return {
    target, observer, body, parts,
    settleMs: boundedInteger(options.settleMs, 250, 0, 5000, 'INVALID_SETTLE_MS'),
    timeoutMs: boundedInteger(options.timeoutMs, 3000, 100, 10000, 'INVALID_TIMEOUT_MS'),
  };
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_JSON');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

function readCounter(document, parts) {
  let value = document;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) {
      throw new Error('COUNTER_INVALID');
    }
    value = value[part];
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('COUNTER_INVALID');
  return value;
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Only headers are required for a delivery. */ }
}

async function observe(url, parts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal, cache: 'no-store' });
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      return { error: 'REDIRECT_REJECTED' };
    }
    if (!response.ok) {
      await discard(response);
      return { error: 'HTTP_ERROR' };
    }
    const document = await responseJson(response);
    return { value: readCounter(document, parts), error: null };
  } catch (error) {
    if (controller.signal.aborted) return { error: 'TIMEOUT' };
    if (['INVALID_JSON', 'COUNTER_INVALID', 'BODY_TOO_LARGE'].includes(error?.message)) {
      return { error: error.message };
    }
    return { error: 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const status = response.status;
    await discard(response);
    return { status, error: status >= 300 && status < 400 ? 'REDIRECT_REJECTED' : null };
  } catch {
    return { status: null, error: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver two concurrent duplicates and one later repeat, then check the
 * independent counter delta. PASS describes only this bounded observation.
 * Validation errors are thrown with fixed codes, before network activity.
 */
export async function checkWebhook(options) {
  const settings = optionsFor(options);
  const result = {
    verdict: 'INCONCLUSIVE',
    exitCode: 2,
    reason: 'NOT_RUN',
    before: null,
    after: null,
    delta: null,
    plannedDeliveries: 3,
    deliveryCount: 0,
    requests: [],
    targetOrigin: settings.target.origin,
    observeOrigin: settings.observer.origin,
    settleMs: settings.settleMs,
  };
  const baseline = await observe(settings.observer, settings.parts, settings.timeoutMs);
  if (baseline.error) {
    result.reason = 'BEFORE_OBSERVATION_' + baseline.error;
    return result;
  }
  result.before = baseline.value;
  result.requests.push(...await Promise.all([
    deliver(settings.target, settings.body, settings.timeoutMs),
    deliver(settings.target, settings.body, settings.timeoutMs),
  ]));
  result.requests.push(await deliver(settings.target, settings.body, settings.timeoutMs));
  result.deliveryCount = result.requests.length;
  await sleep(settings.settleMs);
  const final = await observe(settings.observer, settings.parts, settings.timeoutMs);
  if (final.error) {
    result.reason = 'AFTER_OBSERVATION_' + final.error;
    return result;
  }
  result.after = final.value;
  result.delta = result.after - result.before;
  if (result.delta < 0) {
    result.reason = 'COUNTER_DECREASED';
    return result;
  }
  if (result.requests.some(request => request.status === null)) {
    result.reason = 'DELIVERY_UNCERTAIN';
    return result;
  }
  if (result.requests.some(request => request.status < 200 || request.status >= 300)) {
    result.verdict = 'FAIL';
    result.exitCode = 1;
    result.reason = 'HTTP_STATUS_REJECTED';
    return result;
  }
  result.verdict = result.delta === 1 ? 'PASS' : 'FAIL';
  result.exitCode = result.delta === 1 ? 0 : 1;
  result.reason = result.delta === 1 ? 'ONE_NEW_RESULT_OBSERVED' : 'EXPECTED_ONE_NEW_RESULT';
  return result;
}
