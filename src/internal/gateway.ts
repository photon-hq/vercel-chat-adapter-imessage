import type { Logger } from "chat";
import type {
  Message as SpectrumMessage,
  Space as SpectrumSpace,
} from "spectrum-ts";

type InboundTuple = [SpectrumSpace, SpectrumMessage];

/**
 * A single, long-lived consumer of spectrum-ts's `app.messages` stream. One
 * persistent pump (rather than a fresh subscription per gateway call) avoids
 * dropping an in-flight message on timeout and keeps the connection warm across
 * overlapping cron windows.
 */
export class MessagePump {
  private started = false;
  private iterator: AsyncIterator<InboundTuple> | null = null;

  constructor(
    private readonly source: () => AsyncIterable<InboundTuple>,
    private readonly onMessage: (
      space: SpectrumSpace,
      message: SpectrumMessage
    ) => Promise<void>,
    private readonly logger: Logger
  ) {}

  /** Start consuming if not already running. Idempotent. */
  ensureRunning(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const iterator = this.source()[Symbol.asyncIterator]();
    this.iterator = iterator;

    void (async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            break;
          }
          const [space, message] = next.value;
          try {
            await this.onMessage(space, message);
          } catch (error) {
            this.logger.error("iMessage inbound handler error", {
              error: String(error),
            });
          }
        }
      } catch (error) {
        this.logger.error("iMessage message stream error", {
          error: String(error),
        });
      } finally {
        // Reset so a future ensureRunning() can restart the pump if the stream
        // ended/threw on its own. Guard against clobbering a newer iterator
        // installed by a concurrent restart.
        if (this.iterator === iterator) {
          this.iterator = null;
          this.started = false;
        }
        this.logger.info("iMessage Gateway listener stopped");
      }
    })();
  }

  /** Close the underlying stream and stop consuming. */
  stop(): void {
    const iterator = this.iterator;
    this.iterator = null;
    this.started = false;
    if (iterator?.return) {
      void iterator.return();
    }
  }
}
