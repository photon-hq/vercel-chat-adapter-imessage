# OTel Observability Demo

Demonstrates the iMessage adapter's OpenTelemetry instrumentation with a self-hosted collector or SigNoz dashboard.

## Quick Start

### 1. Start the collector

**Option A — Standalone collector** (logs traces/metrics/logs to console):

```bash
./setup.sh collector
```

**Option B — Full SigNoz stack** (UI at http://localhost:8080):

```bash
./setup.sh signoz
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Run the demo

```bash
node --import ./register.js demo-app.js
```

## What the Demo Does

1. **adapter.initialize** — Creates a root span with a child `sdk.connect` span
2. **adapter.post_message x3** — Sends 3 messages, recording `messagesSent` counter and `messageSendDuration` histogram
3. **Error simulation** — Records an error span with `recordException` and increments `messageSendErrors`
4. **Gateway listener session** (5s) — Creates root span hierarchy, receives ~3-5 messages with per-message child spans, records `messagesReceived`, `gatewaySessions`, `activeGatewayListeners`, and `gatewaySessionDuration`
5. **Waits for metric export** — Ensures periodic metric reader flushes

## What to Verify

### In Collector Console (`docker compose logs -f otel-collector`)

- **Traces**: Look for `adapter.initialize`, `adapter.post_message`, `adapter.gateway_listener` spans
- **Metrics**: Look for `imessage.messages.sent`, `imessage.gateway.session_duration_ms` data points
- **Logs**: Look for log records with `body: "iMessage adapter initialized"` etc.
- **Error spans**: Look for spans with `status: { code: STATUS_CODE_ERROR }` and recorded exceptions

### In SigNoz UI (http://localhost:8080)

1. **Traces tab**: Filter by service `imessage-demo` — see span hierarchy
2. **Dashboards**: Create widgets for `imessage.messages.sent`, `imessage.gateway.session_duration_ms`
3. **Logs tab**: Search for correlated logs — click a trace to see associated log records
4. **Verify PII redaction**: Phone numbers appear as `+1555***4567` in span attributes

### Edge Cases to Test

- **Stop collector, run demo**: Adapter still runs fine, telemetry silently drops
- **Set `OTEL_EXPORTER_OTLP_ENDPOINT` to wrong port**: Same graceful degradation
- **Run demo twice rapidly**: Verify no metric collisions or duplicate spans

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP gRPC endpoint |
| `OTEL_SERVICE_NAME` | `imessage-demo` | Service name in traces |

## Cleanup

```bash
./setup.sh stop
```
