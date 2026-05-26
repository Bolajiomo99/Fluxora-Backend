# Observability — OpenTelemetry Distributed Tracing

## Overview

Fluxora Backend instruments all major I/O boundaries with the OpenTelemetry SDK:

| Boundary | Instrumentation |
|---|---|
| Inbound HTTP (Express) | `@opentelemetry/instrumentation-express` + `instrumentation-http` |
| Outbound HTTP (fetch / node:http) | `@opentelemetry/instrumentation-http` |
| PostgreSQL (`pg`) | `@opentelemetry/instrumentation-pg` |
| Redis (`ioredis`) | `@opentelemetry/instrumentation-ioredis` |
| Stellar RPC | `traceStellarRpc()` helper |
| Webhook dispatch | `traceWebhookDispatch()` helper |
| WebSocket broadcast | `recordWsBroadcast()` helper |

Trace context is propagated via the **W3C `traceparent` header** on all inbound and outbound HTTP calls.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OTEL_SDK_DISABLED` | `false` | Set to `true` to disable the SDK entirely (zero overhead) |
| `OTEL_SERVICE_NAME` | `fluxora-backend` | Service name shown in your tracing UI |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base URL of your OTLP collector (Jaeger, Tempo, etc.) |
| `OTEL_EXPORTER_OTLP_HEADERS` | _(empty)_ | Comma-separated `key=value` auth headers, e.g. `Authorization=Bearer <token>` |

Copy `.env.example` and set these before starting the server.

---

## Quick Start — Local Jaeger

```bash
# 1. Start Jaeger all-in-one (OTLP HTTP on :4318, UI on :16686)
docker run --rm -p 4318:4318 -p 16686:16686 \
  jaegertracing/all-in-one:latest

# 2. Configure the backend
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=fluxora-backend

# 3. Start the backend
pnpm dev

# 4. Make a request
curl http://localhost:3000/health

# 5. Open Jaeger UI
open http://localhost:16686
```

---

## Quick Start — Grafana Tempo

```yaml
# docker-compose.override.yml
services:
  tempo:
    image: grafana/tempo:latest
    command: ["-config.file=/etc/tempo.yaml"]
    ports:
      - "4318:4318"   # OTLP HTTP
      - "3200:3200"   # Tempo query API
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318` in your app service.

---

## Trace Context Propagation

The SDK injects and extracts the `traceparent` header automatically on all HTTP calls.

**Inbound request** — if the caller sends a `traceparent` header, the backend continues the same trace. If not, a new root span is created.

**Outbound calls** — `traceparent` is injected into every outgoing HTTP request made via `node:http`, `node:https`, or `fetch`.

---

## Business Span Helpers

Use these typed helpers in application code to create spans with consistent semantic attributes:

```ts
import {
  traceDbQuery,
  traceRedisCommand,
  traceStellarRpc,
  traceWebhookDispatch,
  recordWsBroadcast,
} from './tracing/hooks.js';

// PostgreSQL query
const rows = await traceDbQuery('SELECT * FROM streams WHERE id = $1', 'fluxora', () =>
  pool.query('SELECT * FROM streams WHERE id = $1', [id]),
);

// Redis command
const cached = await traceRedisCommand('GET', `stream:${id}`, () =>
  redis.get(`stream:${id}`),
);

// Stellar RPC
const ledger = await traceStellarRpc('getLatestLedger', () =>
  rpcClient.getLatestLedger(),
);

// Webhook dispatch (attempt = 0 for first try, 1+ for retries)
await traceWebhookDispatch('stream.created', endpoint, attempt, () =>
  fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) }),
);

// WebSocket broadcast (attaches an event to the current active span)
recordWsBroadcast(streamId, eventId, recipientCount);
```

---

## Security Notes

- **Auth headers are never logged.** `OTEL_EXPORTER_OTLP_HEADERS` is consumed from the environment only; values are passed directly to the exporter and never written to logs or span attributes.
- **SQL statements are recorded as span attributes.** Never interpolate user-controlled values into the `sql` argument of `traceDbQuery`; always use parameterised queries.
- **Cache keys must not contain PII.** The `key` argument of `traceRedisCommand` is recorded as a span attribute.
- **Webhook URLs must not contain secrets.** The `url` argument of `traceWebhookDispatch` is recorded as a span attribute; use opaque endpoint URLs.
- **SDK startup failures are non-fatal.** If the SDK cannot start (e.g., invalid config), the error is logged to stderr and the application continues without tracing.
- **OTLP exporter failures are non-fatal.** The OTel SDK handles retries and back-pressure internally; a collector outage does not affect request handling.

---

## Disabling Tracing

Set `OTEL_SDK_DISABLED=true` to skip SDK initialisation entirely. All auto-instrumentation patches are skipped and the business span helpers become no-ops with zero overhead.

---

## Operator Diagnostics

| Symptom | Check |
|---|---|
| No traces in Jaeger/Tempo | Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is reachable from the app container |
| Traces missing DB spans | Confirm `pg` / `ioredis` are imported **after** `startTracing()` is called |
| Traces missing HTTP spans | Confirm `src/tracing/index.ts` is the first import in `src/index.ts` |
| High cardinality span names | Check that `db.statement` does not include dynamic values |
| Auth errors from collector | Set `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>` |

---

## Related Files

| File | Purpose |
|---|---|
| `src/tracing/index.ts` | OTel SDK bootstrap (`startTracing` / `stopTracing`) |
| `src/tracing/hooks.ts` | Custom hook system + business span helpers |
| `src/tracing/middleware.ts` | Express middleware for request-level spans |
| `src/tracing/builtin.ts` | In-memory span buffer and metrics collector |
| `tests/tracing/otel.test.ts` | Tests for SDK bootstrap and business helpers |
| `docs/TRACING.md` | Deep-dive on the custom hook-based tracing system |
