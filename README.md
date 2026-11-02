# webhook-retry-check

Three successful HTTP responses can still create three records.

This small, zero-dependency Node.js CLI sends an explicit duplicate-delivery scenario and checks an observable counter. It is for developers testing their own webhook receivers and workflow integrations.

## What it checks

1. Read the receiver's counter through a separate GET endpoint.
2. Send two concurrent POST requests with the same JSON payload.
3. Send that identical payload once more after both requests finish.
4. Wait for the configured observation window and read the counter again.
5. Report whether the counter increased by exactly one and all three requests received successful HTTP responses.

HTTP status alone is never enough for a PASS. An unavailable or invalid observation is INCONCLUSIVE.

## Try the local demonstration

Requires Node.js 22 or newer. Download or clone this repository, then open a terminal in its directory. There are no packages to install.

```sh
npm test
npm run demo
```

The one-command demo runs all three isolated examples and closes its servers. To inspect a receiver manually instead:

```sh
npm run demo:safe
```

In a second terminal:

```sh
node cli.mjs \
  --url http://127.0.0.1:8787/hook \
  --observe-url http://127.0.0.1:8787/stats \
  --payload payload.json
```

On Windows PowerShell, put the command on one line instead of using the shell continuation characters above.

The safe demonstration should produce a counter change from 0 to 1. Stop it with Ctrl+C, then run `npm run demo:broken` and repeat the command. Its three HTTP 200 responses produce a counter change from 0 to 3, so the check fails.

See the [captured synthetic demo output](demo-output.txt).

`npm run demo:blind` demonstrates an unreadable observation endpoint. The check returns INCONCLUSIVE before sending any POST requests.

Use a fresh event ID or restart the isolated demonstration for each run. Replaying an event that was already processed in a previous run can correctly create zero new records; this first version specifically expects one new result.

## Use it with your receiver

Your POST endpoint accepts JSON. A separate GET endpoint must expose a numeric counter scoped to the test, for example:

```json
{"created": 1}
```

Choose a nested counter with `--count-path stats.created`. Counters must be nonnegative safe integers. Use an isolated environment and synthetic payloads: other writers or counter resets can invalidate the comparison.

```sh
node cli.mjs --help
```

Options:

| Option | Purpose |
| --- | --- |
| `--url` | Receiver URL for the three POST requests |
| `--observe-url` | GET endpoint for the before/after counter |
| `--payload` | Path to a JSON object; sent unchanged each time |
| `--count-path` | Dot-separated counter path; default `created` |
| `--settle-ms` | Observation delay after delivery; default 250 ms, maximum 5000 ms |
| `--timeout-ms` | Per-request timeout; default 3000 ms, allowed range 100–10000 ms |
| `--allow-remote` | Explicitly allow non-loopback destinations you are authorized to test |
| `--json` | Print a machine-readable report |

By default, both destinations must be loopback addresses. Redirects are not followed. The scenario is limited to three POSTs and a payload of at most 64 KiB. The report omits raw payloads, response bodies and URL paths/query strings. These are reporting precautions, not a general secret-detection guarantee.

## Exit codes

| Code | Verdict | Meaning |
| --- | --- | --- |
| 0 | PASS | All three POSTs succeeded and the observed counter delta is one |
| 1 | FAIL | A POST was rejected or the observed delta differs from one |
| 2 | INCONCLUSIVE | Configuration, transport or observation prevented a reliable result |

## What a PASS does not prove

A PASS describes this one scenario and observation window. It does not prove exactly-once delivery, eventual completion, crash recovery, atomic database writes, or correctness under production load. Side effects after the observation window are outside the check. A global counter with unrelated traffic is not reliable evidence for one event.

This CLI does not implement receiver deduplication, capture traffic through a tunnel, manage secrets, send alerts, or emulate every provider's retry policy. In particular, GitHub does not automatically redeliver failed webhook deliveries. The repeated requests here are a deliberate test scenario, not a statement about a specific provider.

## Why this exists

- [n8n's idempotency guide](https://blog.n8n.io/idempotency-api/) describes duplicate operations caused by retries and the need for stable event keys.
- [GitHub's delivery documentation](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) explains its different redelivery behavior.

There are mature webhook tools, including tunnels and replay services. This experiment focuses narrowly on a local concurrency check tied to an observable result.

## Contributing and support

Reproducible issues and small improvements are welcome. Include your Node.js version, operating system, synthetic reproduction, expected result and actual verdict. Never post credentials, production payloads or customer records in an issue.

You can support the project by reporting a reproducible problem, contributing a test case or improving the documentation.

MIT licensed. See [LICENSE](LICENSE).
