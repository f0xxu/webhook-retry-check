import { checkWebhook } from './check.mjs';
import { startDemoServer } from './demo-server.mjs';

const expected = { broken: 'FAIL', safe: 'PASS', blind: 'INCONCLUSIVE' };
const captured = [];
for (const mode of ['broken', 'safe', 'blind']) {
  const demo = await startDemoServer({ mode, port: 0 });
  try {
    const report = await checkWebhook({
      url: demo.baseUrl + '/hook',
      observeUrl: demo.baseUrl + '/stats',
      payload: { eventId: 'synthetic-demo-' + mode, name: 'Synthetic lead' },
    });
    captured.push({ mode, expected: expected[mode], report });
  } finally {
    await demo.close();
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ syntheticLocalDemo: true, scenarios: captured }, null, 2));
} else {
  console.log('Synthetic local demonstration; no production integration.');
  for (const { mode, report } of captured) {
    const http = report.requests.map(request => request.status ?? request.error).join(', ') || 'no POSTs';
    const before = report.before ?? 'unknown';
    const after = report.after ?? 'unknown';
    console.log(`${mode}: HTTP ${http} | counter ${before} -> ${after} | ${report.verdict}`);
  }
  console.log('A PASS describes only the tested scenario and observation window.');
}
if (captured.some(item => item.report.verdict !== item.expected)) process.exitCode = 1;
