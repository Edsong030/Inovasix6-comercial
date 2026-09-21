import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { OutboundAdapterRegistry } from './outbound-adapter.registry';
import { OutboundDispatcherService } from './outbound-dispatcher.service';

/** Pause before the next poll when the last one still had work (or more pages): short, but never a busy-loop. */
export const OUTBOUND_BUSY_DELAY_MS = 50;
/** Extra time, beyond the send timeout, that shutdown waits for a poll in flight. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * The polling loop around OutboundDispatcherService.dispatchCycle().
 *
 * It is a thin, replaceable shell: everything that decides what is delivered
 * lives in the dispatcher and the repository, so this can later run in its own
 * process (or be replaced by another trigger) without touching the engine.
 *
 *  - OFF unless OUTBOUND_WORKER_ENABLED=true (never in tests by default).
 *  - Nothing runs at import time: the loop starts in onApplicationBootstrap
 *    (or an explicit start()), and only then does a timer exist.
 *  - One poll at a time, chained with setTimeout (not setInterval): the next
 *    poll is scheduled only after the previous one finished, so polls never
 *    pile up behind a slow provider. Between polls it sleeps pollIntervalMs;
 *    it only re-polls quickly while there is more to do.
 *  - A failing poll (database down, ...) is logged and the loop carries on
 *    after the normal interval: one bad cycle never kills the process.
 *  - The timer is unref'd, so it can never keep the process alive on its own,
 *    and stop() (onModuleDestroy) cancels it and waits, bounded, for a poll
 *    already in flight before the database connection goes away.
 */
@Injectable()
export class OutboundWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboundWorker.name);
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private cursor: string | null = null;

  constructor(
    private readonly dispatcher: OutboundDispatcherService,
    private readonly adapters: OutboundAdapterRegistry,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outboundDelivery.workerEnabled) return;
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts polling. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const settings = this.config.outboundDelivery;
    const channels = this.adapters.channels();
    this.logger.log({
      event: 'outbound.worker.started',
      pollIntervalMs: settings.pollIntervalMs,
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      sendTimeoutMs: settings.sendTimeoutMs,
      adapterChannels: channels,
    });
    if (channels.length === 0) {
      // Explicit, not silent: with no adapter every message stays PENDING.
      this.logger.warn({ event: 'outbound.worker.no_adapters' });
    }
    this.schedule(0);
  }

  /** Stops polling and waits (bounded) for a poll in progress. Idempotent. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const current = this.inFlight;
    if (current) {
      let graceTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, this.config.outboundDelivery.sendTimeoutMs + SHUTDOWN_GRACE_MS);
        graceTimer.unref();
      });
      await Promise.race([current, grace]);
      clearTimeout(graceTimer);
    }
    this.logger.log({ event: 'outbound.worker.stopped' });
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const poll = this.poll().finally(() => {
        if (this.inFlight === poll) this.inFlight = null;
      });
      this.inFlight = poll;
    }, delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    let busy = false;
    try {
      const result = await this.dispatcher.dispatchCycle(this.cursor);
      this.cursor = result.nextCursor;
      busy = result.claimed + result.exhausted > 0 || result.nextCursor !== null;
    } catch (error) {
      // Name/code only: a database error message can quote data.
      const failure = error as { name?: unknown; code?: unknown } | null;
      this.logger.error({
        event: 'outbound.worker.cycle_error',
        errorName: typeof failure?.name === 'string' ? failure.name : 'UnknownError',
        code: typeof failure?.code === 'string' ? failure.code : undefined,
      });
      this.cursor = null;
    }
    this.schedule(busy ? OUTBOUND_BUSY_DELAY_MS : this.config.outboundDelivery.pollIntervalMs);
  }
}
