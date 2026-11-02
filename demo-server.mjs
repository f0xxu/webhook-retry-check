import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MODES = new Set(['safe', 'broken', 'blind']);

async function readEvent(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  let event;
  try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_EVENT'); }
  if (!event || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 120) {
    throw new Error('INVALID_EVENT');
  }
  return event;
}

/** Synthetic, in-memory examples only. The safe mode is not durable storage. */
export async function startDemoServer({ mode = 'safe', port = 0 } = {}) {
  if (!MODES.has(mode) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('INVALID_DEMO_OPTIONS');
  }
  const ids = new Set();
  let created = 0;
  let received = 0;
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/stats') {
      send(mode === 'blind' ? 500 : 200, mode === 'blind' ? { error: 'OBSERVATION_UNAVAILABLE' } : { created, received });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/hook') {
      send(404, { error: 'NOT_FOUND' });
      return;
    }
    try {
      const event = await readEvent(request);
      received++;
      if (mode === 'broken') {
        created++;
      } else if (!ids.has(event.eventId)) {
        // Claim and count synchronously, before any later async operation.
        ids.add(event.eventId);
        created++;
      }
      send(200, { accepted: true });
    } catch (error) {
      send(error.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_EVENT' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    server, baseUrl,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let mode = 'safe';
    let port = 8787;
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!['--mode', '--port'].includes(flag) || seen.has(flag) || !args[index + 1]) {
        throw new Error('INVALID_DEMO_OPTIONS');
      }
      seen.add(flag);
      const value = args[++index];
      if (flag === '--mode') mode = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error('INVALID_DEMO_OPTIONS');
        port = Number(value);
      }
    }
    const demo = await startDemoServer({ mode, port });
    process.stdout.write(JSON.stringify({ mode, baseUrl: demo.baseUrl, hookUrl: demo.baseUrl + '/hook', observeUrl: demo.baseUrl + '/stats' }) + '\n');
    const stop = () => demo.close().catch(() => { process.exitCode = 2; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    process.stderr.write('INCONCLUSIVE: DEMO_START_FAILED\n');
    process.exitCode = 2;
  }
}
