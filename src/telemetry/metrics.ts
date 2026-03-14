import {
  metrics,
  type Meter,
  type Counter,
  type Histogram,
  type UpDownCounter,
  type MeterProvider,
} from "@opentelemetry/api";

import { LIBRARY_NAME, LIBRARY_VERSION } from "./config.js";

/**
 * Create a {@link Meter} scoped to this library.
 *
 * If no explicit provider is given the globally-registered MeterProvider is
 * used (which may be the no-op provider if the consumer hasn't configured one).
 */
export function createMeter(provider?: MeterProvider): Meter {
  const mp = provider ?? metrics.getMeterProvider();
  return mp.getMeter(LIBRARY_NAME, LIBRARY_VERSION);
}

/**
 * Holds every OTel metrics instrument used by the iMessage chat adapter and
 * provides a single place to look up metric names and descriptions.
 */
export class AdapterMetrics {
  // ── Counters ────────────────────────────────────────────────────────────

  readonly messagesReceived: Counter;
  readonly messagesSent: Counter;
  readonly messageSendErrors: Counter;
  readonly gatewaySessions: Counter;
  readonly gatewayErrors: Counter;
  readonly reactionsSent: Counter;
  readonly pollsCreated: Counter;
  readonly pollVotesReceived: Counter;
  readonly pollVotesDropped: Counter;
  readonly attachmentsSent: Counter;
  readonly initErrors: Counter;

  // ── Histograms ──────────────────────────────────────────────────────────

  readonly messageSendDuration: Histogram;
  readonly messageReceiveToProcessDuration: Histogram;
  readonly gatewaySessionDuration: Histogram;
  readonly gatewayConnectDuration: Histogram;
  readonly attachmentUploadDuration: Histogram;
  readonly fetchDuration: Histogram;

  // ── Gauges (UpDownCounter) ──────────────────────────────────────────────

  readonly activeGatewayListeners: UpDownCounter;

  constructor(meter: Meter) {
    // Counters
    this.messagesReceived = meter.createCounter(
      "imessage.messages.received",
      { description: "Number of inbound messages received" },
    );
    this.messagesSent = meter.createCounter("imessage.messages.sent", {
      description: "Number of outbound messages sent",
    });
    this.messageSendErrors = meter.createCounter(
      "imessage.messages.send_errors",
      { description: "Number of failed message sends" },
    );
    this.gatewaySessions = meter.createCounter(
      "imessage.gateway.sessions",
      { description: "Number of gateway listener sessions started" },
    );
    this.gatewayErrors = meter.createCounter("imessage.gateway.errors", {
      description: "Number of gateway-level errors",
    });
    this.reactionsSent = meter.createCounter("imessage.reactions.sent", {
      description: "Number of reactions sent",
    });
    this.pollsCreated = meter.createCounter("imessage.polls.created", {
      description: "Number of polls created",
    });
    this.pollVotesReceived = meter.createCounter(
      "imessage.polls.votes_received",
      { description: "Number of valid poll votes processed" },
    );
    this.pollVotesDropped = meter.createCounter(
      "imessage.polls.votes_dropped",
      { description: "Number of dropped poll votes" },
    );
    this.attachmentsSent = meter.createCounter(
      "imessage.attachments.sent",
      { description: "Number of file attachments sent" },
    );
    this.initErrors = meter.createCounter("imessage.init.errors", {
      description: "Number of initialization failures",
    });

    // Histograms (all in milliseconds)
    this.messageSendDuration = meter.createHistogram(
      "imessage.message.send_duration",
      { description: "Time to send a message", unit: "ms" },
    );
    this.messageReceiveToProcessDuration = meter.createHistogram(
      "imessage.message.receive_to_process_duration",
      { description: "Time from receive to processMessage", unit: "ms" },
    );
    this.gatewaySessionDuration = meter.createHistogram(
      "imessage.gateway.session_duration",
      { description: "Actual gateway listener session length", unit: "ms" },
    );
    this.gatewayConnectDuration = meter.createHistogram(
      "imessage.gateway.connect_duration",
      { description: "SDK connection time", unit: "ms" },
    );
    this.attachmentUploadDuration = meter.createHistogram(
      "imessage.attachment.upload_duration",
      { description: "Per-attachment upload time", unit: "ms" },
    );
    this.fetchDuration = meter.createHistogram(
      "imessage.fetch.duration",
      { description: "fetchMessages/fetchThread latency", unit: "ms" },
    );

    // Gauges (modelled as UpDownCounter)
    this.activeGatewayListeners = meter.createUpDownCounter(
      "imessage.gateway.active_listeners",
      { description: "Number of currently active gateway listeners" },
    );
  }
}

const NOOP_COUNTER = {
  add(): void {},
} as Counter;

const NOOP_HISTOGRAM = {
  record(): void {},
} as Histogram;

const NOOP_UP_DOWN_COUNTER = {
  add(): void {},
} as UpDownCounter;

function createNoopMetrics(): AdapterMetrics {
  return Object.freeze(
    Object.assign(Object.create(AdapterMetrics.prototype), {
      messagesReceived: NOOP_COUNTER,
      messagesSent: NOOP_COUNTER,
      messageSendErrors: NOOP_COUNTER,
      gatewaySessions: NOOP_COUNTER,
      gatewayErrors: NOOP_COUNTER,
      reactionsSent: NOOP_COUNTER,
      pollsCreated: NOOP_COUNTER,
      pollVotesReceived: NOOP_COUNTER,
      pollVotesDropped: NOOP_COUNTER,
      attachmentsSent: NOOP_COUNTER,
      initErrors: NOOP_COUNTER,
      messageSendDuration: NOOP_HISTOGRAM,
      messageReceiveToProcessDuration: NOOP_HISTOGRAM,
      gatewaySessionDuration: NOOP_HISTOGRAM,
      gatewayConnectDuration: NOOP_HISTOGRAM,
      attachmentUploadDuration: NOOP_HISTOGRAM,
      fetchDuration: NOOP_HISTOGRAM,
      activeGatewayListeners: NOOP_UP_DOWN_COUNTER,
    }),
  ) as AdapterMetrics;
}

/** No-op metrics — used when OTel is disabled */
export const NOOP_METRICS = createNoopMetrics();
