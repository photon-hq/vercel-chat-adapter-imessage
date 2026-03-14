/**
 * Demo app that exercises the iMessage adapter with OTel enabled.
 *
 * This simulates the key adapter operations so you can see traces, metrics,
 * and logs flowing through the OTel Collector into SigNoz (or console).
 *
 * Usage:
 *   node --import ./register.js demo-app.js
 *
 * Prerequisites:
 *   1. Run `./setup.sh collector` (or `./setup.sh signoz` for full UI)
 *   2. Run `pnpm install` in this directory
 */

import { trace, metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

// --- Simulate adapter construction with OTel enabled ---
// In a real app you'd import from the built library:
//   import { iMessageAdapter } from "chat-adapter-imessage";
//
// For this demo, we call the OTel API directly to show what the adapter
// does under the hood, since we can't instantiate the adapter without
// a real iMessage server.

const tracer = trace.getTracer("chat-adapter-imessage", "0.1.1");
const meter = metrics.getMeter("chat-adapter-imessage", "0.1.1");
const logger = logs.getLoggerProvider().getLogger("chat-adapter-imessage");

// --- Create the same metrics the adapter creates ---
const messagesReceived = meter.createCounter("imessage.messages.received", {
  description: "Number of inbound messages received",
});
const messagesSent = meter.createCounter("imessage.messages.sent", {
  description: "Number of outbound messages sent",
});
const messageSendErrors = meter.createCounter("imessage.messages.send_errors", {
  description: "Number of outbound message send failures",
});
const messageSendDuration = meter.createHistogram("imessage.messages.send_duration_ms", {
  description: "Time to send outbound messages",
  unit: "ms",
});
const gatewaySessions = meter.createCounter("imessage.gateway.sessions", {
  description: "Total gateway listener sessions started",
});
const gatewaySessionDuration = meter.createHistogram("imessage.gateway.session_duration_ms", {
  description: "Duration of gateway listener sessions",
  unit: "ms",
});
const activeGatewayListeners = meter.createUpDownCounter("imessage.gateway.active_listeners", {
  description: "Number of currently active gateway listeners",
});

const MODE_ATTR = { "imessage.mode": "remote" };

// --- Simulate adapter operations ---

async function simulateInitialize() {
  return tracer.startActiveSpan("adapter.initialize", { attributes: MODE_ATTR }, async (span) => {
    logger.emit({ body: "iMessage adapter initialized", attributes: { ...MODE_ATTR, local: false } });

    await tracer.startActiveSpan("sdk.connect", { attributes: MODE_ATTR }, async (connectSpan) => {
      await sleep(50 + Math.random() * 100); // simulate connect latency
      logger.emit({ body: "SDK connected to remote server" });
      connectSpan.end();
    });

    span.end();
  });
}

async function simulatePostMessage(threadId, text) {
  const chatGuid = threadId.replace("imessage:", "");
  const attrs = { ...MODE_ATTR, "imessage.chat_guid": chatGuid };
  const start = Date.now();

  return tracer.startActiveSpan("adapter.post_message", { attributes: attrs }, async (span) => {
    try {
      await tracer.startActiveSpan("sdk.send_message", { attributes: attrs }, async (sendSpan) => {
        const latency = 30 + Math.random() * 200;
        await sleep(latency);
        logger.emit({ body: `Message sent to ${chatGuid}`, attributes: { latency_ms: latency } });
        sendSpan.end();
      });

      messagesSent.add(1, MODE_ATTR);
      messageSendDuration.record(Date.now() - start, MODE_ATTR);
      span.end();
      return { id: `msg-${Date.now()}`, threadId };
    } catch (error) {
      messageSendErrors.add(1, MODE_ATTR);
      span.recordException(error);
      span.end();
      throw error;
    }
  });
}

async function simulateGatewaySession(durationMs) {
  const sessionStart = Date.now();
  gatewaySessions.add(1, MODE_ATTR);
  activeGatewayListeners.add(1, MODE_ATTR);

  return tracer.startActiveSpan("adapter.gateway_listener", {
    attributes: { ...MODE_ATTR, "imessage.gateway.duration_ms": durationMs },
  }, async (listenerSpan) => {
    return tracer.startActiveSpan("adapter.gateway_runner", {
      attributes: { ...MODE_ATTR, "imessage.gateway.duration_ms": durationMs },
    }, async (runnerSpan) => {
      logger.emit({ body: "Starting iMessage Gateway listener", attributes: { durationMs, mode: "remote" } });

      let messagesProcessed = 0;

      // Simulate receiving messages during the session
      const messageInterval = setInterval(() => {
        if (Date.now() - sessionStart > durationMs) return;

        messagesProcessed++;
        const chatGuid = Math.random() > 0.5
          ? "iMessage;-;+1555***4567"  // DM (redacted)
          : "iMessage;+;chat493787071395575843";  // Group

        tracer.startActiveSpan("message.receive", {
          attributes: { ...MODE_ATTR, "imessage.chat_guid": chatGuid, "imessage.message_id": `msg-${messagesProcessed}` },
        }, (msgSpan) => {
          messagesReceived.add(1, { ...MODE_ATTR, source: "remote" });
          logger.emit({ body: `Received message #${messagesProcessed}`, attributes: { chatGuid } });
          msgSpan.end();
        });
      }, 500 + Math.random() * 1500);

      await sleep(durationMs);
      clearInterval(messageInterval);

      runnerSpan.setAttribute("imessage.gateway.messages_received", messagesProcessed);
      runnerSpan.setAttribute("imessage.gateway.errors", 0);
      runnerSpan.setAttribute("imessage.gateway.aborted", false);

      logger.emit({ body: "Gateway listener duration elapsed, disconnecting" });

      await tracer.startActiveSpan("sdk.disconnect", { attributes: MODE_ATTR }, async (disconnectSpan) => {
        await sleep(20);
        disconnectSpan.end();
      });

      activeGatewayListeners.add(-1, MODE_ATTR);
      gatewaySessionDuration.record(Date.now() - sessionStart, MODE_ATTR);

      runnerSpan.end();
      listenerSpan.end();

      return messagesProcessed;
    });
  });
}

async function simulateSendError() {
  const attrs = { ...MODE_ATTR, "imessage.chat_guid": "iMessage;-;+1555***9999" };

  return tracer.startActiveSpan("adapter.post_message", { attributes: attrs }, async (span) => {
    const error = new Error("Connection timeout: server unreachable");
    messageSendErrors.add(1, { ...MODE_ATTR, "imessage.error.type": "Error" });
    span.recordException(error);
    span.setStatus({ code: 2, message: error.message }); // SpanStatusCode.ERROR = 2
    logger.emit({
      body: `Failed to send message: ${error.message}`,
      severityNumber: 17, // ERROR
      attributes: { error: error.message },
    });
    span.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main demo flow ---

async function main() {
  console.log("\n=== chat-adapter-imessage OTel Demo ===\n");

  // Step 1: Initialize
  console.log("[1/5] Simulating adapter.initialize()...");
  await simulateInitialize();
  console.log("  -> Done\n");

  // Step 2: Send some messages
  console.log("[2/5] Simulating postMessage() x3...");
  for (let i = 0; i < 3; i++) {
    const result = await simulatePostMessage(
      `imessage:iMessage;-;+1555***456${i}`,
      `Hello from demo message ${i + 1}!`
    );
    console.log(`  -> Sent ${result.id}`);
  }
  console.log();

  // Step 3: Simulate an error
  console.log("[3/5] Simulating a send failure (error span)...");
  await simulateSendError();
  console.log("  -> Error recorded\n");

  // Step 4: Gateway listener session
  const sessionDuration = 5000;
  console.log(`[4/5] Simulating gateway session (${sessionDuration / 1000}s)...`);
  const msgCount = await simulateGatewaySession(sessionDuration);
  console.log(`  -> Session ended, processed ${msgCount} messages\n`);

  // Step 5: Wait for export
  console.log("[5/5] Waiting 3s for metric export interval...");
  await sleep(3000);
  console.log("  -> Done\n");

  console.log("=== Demo complete ===");
  console.log("Check your OTel Collector logs or SigNoz UI at http://localhost:8080\n");

  // Give the SDK time to flush
  await sleep(2000);
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
