import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { backoffDelayMs, hasAttemptsLeft } from './delivery-policy';
import { OutboundAdapterRegistry } from './outbound-adapter.registry';
import {
  OUTBOUND_ERROR_CODE_PATTERN,
  OutboundChannelAdapter,
  OutboundDeliveryError,
  OutboundFailureKind,
  OutboundSendResult,
} from './outbound-channel-adapter';
import { ClaimedMessage, OutboundDeliveryRepository } from './outbound-delivery.repository';

/** Tenants looked at per poll, and how many are served at the same time. */
export const TENANTS_PER_POLL = 50;
export const TENANT_CONCURRENCY = 4;
/** A tenant/channel with undeliverable messages is reported at most this often. */
const NO_ADAPTER_REPORT_EVERY_MS = 5 * 60_000;
const MAX_EXTERNAL_ID_LENGTH = 512;

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  /** Finalizations refused because the lease was no longer ours (the message is somebody else's now). */
  leaseLost: number;
  /** Messages moved to FAILED by the claim because their attempts ran out. */
  exhausted: number;
  /** Messages whose outcome could not be written (database error); their lease will expire. */
  finalizeErrors: number;
}

export interface CycleResult extends DispatchSummary {
  tenants: number;
  /** Where the next poll continues; null = the last page was reached, start over. */
  nextCursor: string | null;
}

const emptySummary = (): DispatchSummary => ({
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  leaseLost: 0,
  exhausted: 0,
  finalizeErrors: 0,
});

/**
 * Delivers OUTBOUND / PENDING messages through the channel adapters.
 *
 * It does not care who authored the message (SYSTEM automatic reply or AGENT):
 * OUTBOUND + PENDING + queued (next_attempt_at) is all it takes, which is why
 * the first-contact reply and a human's message use the very same path.
 *
 * FLOW per tenant: claim (short committed transaction, lease + attempt counted)
 * -> adapter.send() with NO transaction open -> finalize with a compare-and-set
 * on the lease token: SENT + externalId, or back to the queue with backoff, or
 * FAILED. See OutboundDeliveryRepository for the SQL and the lease protocol.
 *
 * DELIVERY SEMANTICS: AT-LEAST-ONCE, at most OUTBOUND_MAX_ATTEMPTS attempts.
 * It is NOT exactly-once and does not pretend to be. The unavoidable window:
 *
 *     provider accepted the message
 *       -> the process died (or the database was unreachable) before SENT was
 *          persisted
 *       -> the lease expires, the message is PENDING and due again
 *       -> it is sent AGAIN, and the customer may receive it twice.
 *
 * Choosing the opposite (mark SENT before sending, at-most-once) would silently
 * lose messages on a crash, including the first-contact reply, which the
 * product wants to guarantee. The engine narrows the window (attempt counted
 * before sending, short transactions, timeout below the lease) and hands the
 * message id to the adapter as an idempotency key so a provider that honours
 * one can drop the duplicate; it cannot close the window. SENT also does not
 * mean delivered: DELIVERED/READ come only from the provider's own
 * confirmation, which is not this component's job.
 *
 * Logs carry ids, channel, attempt, result codes and the provider's message id.
 * Never the body, the recipient, names or provider payloads.
 */
@Injectable()
export class OutboundDispatcherService {
  private readonly logger = new Logger(OutboundDispatcherService.name);
  private readonly noAdapterReportedAt = new Map<string, number>();

  /** Injectable for tests. */
  random: () => number = Math.random;
  clock: () => number = Date.now;

  constructor(
    private readonly repository: OutboundDeliveryRepository,
    private readonly adapters: OutboundAdapterRegistry,
    private readonly config: AppConfigService,
  ) {}

  /**
   * One poll: find tenants with something due (paged by `cursor`), then serve
   * them. Never throws for a single tenant's problem: it is logged and the
   * others go on.
   */
  async dispatchCycle(cursor: string | null = null): Promise<CycleResult> {
    const tenantIds = await this.repository.discoverTenants(TENANTS_PER_POLL, cursor);
    const total = emptySummary();

    await mapWithConcurrency(tenantIds, TENANT_CONCURRENCY, async (tenantId) => {
      try {
        add(total, await this.dispatchTenant(tenantId));
      } catch (error) {
        this.logger.error({ event: 'outbound.tenant_error', tenantId, ...describeError(error) });
      }
    });

    return {
      ...total,
      tenants: tenantIds.length,
      nextCursor: tenantIds.length >= TENANTS_PER_POLL ? tenantIds[tenantIds.length - 1] : null,
    };
  }

  /** Claims and delivers one batch of one tenant. */
  async dispatchTenant(tenantId: string): Promise<DispatchSummary> {
    const settings = this.config.outboundDelivery;
    const summary = emptySummary();

    const { claimed, exhausted } = await this.repository.claim(tenantId, {
      channels: this.adapters.channels(),
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
    });

    for (const message of exhausted) {
      summary.exhausted += 1;
      this.logger.error({
        event: 'outbound.failed',
        tenantId,
        messageId: message.id,
        conversationId: message.conversationId,
        attempt: message.attempt,
        code: message.code,
        reason: 'attempts_exhausted',
      });
    }

    if (claimed.length === 0) {
      if (exhausted.length === 0) await this.reportMessagesWithoutAdapter(tenantId);
      return summary;
    }

    summary.claimed = claimed.length;
    // All of the batch goes out at the same time, so the slowest send (bounded
    // by the timeout, which is below the lease) decides how long a lease is
    // really held, not the sum of the batch.
    const outcomes = await Promise.all(claimed.map((message) => this.deliver(message, settings.sendTimeoutMs)));
    for (const outcome of outcomes) summary[outcome] += 1;
    return summary;
  }

  private async deliver(message: ClaimedMessage, timeoutMs: number): Promise<'sent' | 'retried' | 'failed' | 'leaseLost' | 'finalizeErrors'> {
    const base = {
      tenantId: message.tenantId,
      messageId: message.id,
      conversationId: message.conversationId,
      channel: message.channel,
      attempt: message.attempt,
    };
    this.logger.log({ event: 'outbound.claimed', ...base });

    let result: OutboundSendResult | null = null;
    let failure: { kind: OutboundFailureKind; code: string } | null = null;

    // Reasons the engine itself knows the message cannot go out: no provider call.
    const adapter = this.adapters.get(message.channel);
    if (!adapter) failure = { kind: 'temporary', code: 'NO_ADAPTER' };
    else if (!message.body || message.body.trim().length === 0) failure = { kind: 'permanent', code: 'EMPTY_BODY' };
    else if (!message.recipientExternalId) failure = { kind: 'permanent', code: 'NO_RECIPIENT' };
    else {
      try {
        result = await this.sendWithTimeout(adapter, message, timeoutMs);
        if (!isValidResult(result)) {
          // A contract violation of the adapter, not something a retry can fix (and
          // repeating a send to a real customer over an adapter bug would be worse).
          result = null;
          failure = { kind: 'permanent', code: 'INVALID_ADAPTER_RESULT' };
        }
      } catch (error) {
        failure = classify(error);
      }
    }

    try {
      if (result && !failure) return await this.finishSent(message, result, base);
      return await this.finishFailure(message, failure ?? { kind: 'temporary', code: 'ADAPTER_ERROR' }, base);
    } catch (error) {
      // The outcome could not be written. The lease is left to expire: the
      // message will be due again (at-least-once: it may already have been
      // accepted by the provider).
      this.logger.error({ event: 'outbound.finalize_error', ...base, ...describeError(error) });
      return 'finalizeErrors';
    }
  }

  private async finishSent(message: ClaimedMessage, result: OutboundSendResult, base: Record<string, unknown>): Promise<'sent' | 'leaseLost'> {
    const outcome = await this.repository.markSent(message.tenantId, message.id, message.leaseToken, result.externalMessageId);
    if (outcome === 'lease_lost') {
      // The provider accepted the message but we no longer own it: another
      // worker re-claimed it after the lease expired, so it may be sent twice.
      this.logger.warn({ event: 'outbound.lease_lost', ...base, externalMessageId: result.externalMessageId, accepted: true });
      return 'leaseLost';
    }
    if (outcome === 'sent_external_id_conflict') {
      this.logger.error({ event: 'outbound.external_id_conflict', ...base, externalMessageId: result.externalMessageId });
    }
    this.logger.log({ event: 'outbound.sent', ...base, externalMessageId: result.externalMessageId });
    return 'sent';
  }

  private async finishFailure(
    message: ClaimedMessage,
    failure: { kind: OutboundFailureKind; code: string },
    base: Record<string, unknown>,
  ): Promise<'retried' | 'failed' | 'leaseLost'> {
    const retry = failure.kind === 'temporary' && hasAttemptsLeft(message.attempt);
    if (retry) {
      const delayMs = backoffDelayMs(message.attempt, this.random);
      const outcome = await this.repository.markRetry(message.tenantId, message.id, message.leaseToken, failure.code, delayMs);
      if (outcome === 'lease_lost') return this.leaseLost(base, failure.code);
      this.logger.warn({ event: 'outbound.retry', ...base, code: failure.code, retryInMs: delayMs });
      return 'retried';
    }

    const outcome = await this.repository.markFailed(message.tenantId, message.id, message.leaseToken, failure.code);
    if (outcome === 'lease_lost') return this.leaseLost(base, failure.code);
    this.logger.error({
      event: 'outbound.failed',
      ...base,
      code: failure.code,
      reason: failure.kind === 'permanent' ? 'permanent' : 'attempts_exhausted',
    });
    return 'failed';
  }

  private leaseLost(base: Record<string, unknown>, code: string): 'leaseLost' {
    this.logger.warn({ event: 'outbound.lease_lost', ...base, code, accepted: false });
    return 'leaseLost';
  }

  /**
   * adapter.send() bounded by a timeout. The abort signal asks the adapter to
   * stop; the timeout itself does not wait for it. A timeout is a TEMPORARY
   * failure, but the provider may still have accepted the message.
   */
  private async sendWithTimeout(adapter: OutboundChannelAdapter, message: ClaimedMessage, timeoutMs: number): Promise<OutboundSendResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(OutboundDeliveryError.temporary('TIMEOUT'));
      }, timeoutMs);
    });

    // Also covers an adapter that throws synchronously.
    const sending = Promise.resolve().then(() =>
      adapter.send({
        idempotencyKey: message.id,
        tenantId: message.tenantId,
        conversationId: message.conversationId,
        channel: message.channel,
        recipient: {
          externalContactId: message.recipientExternalId as string,
          externalConversationId: message.externalConversationId,
        },
        body: message.body as string,
        signal: controller.signal,
      }),
    );
    // If the timeout wins, the late outcome of the adapter must not become an unhandled rejection.
    sending.catch(() => undefined);

    try {
      return await Promise.race([sending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Due messages that this process cannot deliver (no adapter for their channel)
   * are left PENDING, untouched. Say so, at most every few minutes per
   * tenant+channel, instead of hiding it or spinning on them.
   */
  private async reportMessagesWithoutAdapter(tenantId: string): Promise<void> {
    const groups = await this.repository.countWithoutAdapter(tenantId, this.adapters.channels());
    const now = this.clock();
    for (const group of groups) {
      const key = `${tenantId}:${group.channel}`;
      const last = this.noAdapterReportedAt.get(key);
      if (last !== undefined && now - last < NO_ADAPTER_REPORT_EVERY_MS) continue;
      this.noAdapterReportedAt.set(key, now);
      this.logger.warn({
        event: 'outbound.no_adapter',
        tenantId,
        channel: group.channel,
        pending: group.count,
      });
    }
  }
}

function isValidResult(result: unknown): result is OutboundSendResult {
  const id = (result as { externalMessageId?: unknown } | null)?.externalMessageId;
  return typeof id === 'string' && id.trim().length > 0 && id.length <= MAX_EXTERNAL_ID_LENGTH;
}

/**
 * Turns whatever an adapter threw into a stored code. Only a well-formed
 * OutboundDeliveryError keeps its own code/kind; anything else (a bare Error,
 * a network library failure) is a temporary ADAPTER_ERROR whose text is never
 * kept: it could quote a payload.
 */
function classify(error: unknown): { kind: OutboundFailureKind; code: string } {
  if (error instanceof OutboundDeliveryError) {
    const code = OUTBOUND_ERROR_CODE_PATTERN.test(error.code) ? error.code : 'ADAPTER_ERROR';
    return { kind: error.kind, code };
  }
  return { kind: 'temporary', code: 'ADAPTER_ERROR' };
}

/** Error NAME/code only: a Prisma or driver message can quote the data involved. */
function describeError(error: unknown): { errorName: string; code?: string } {
  const failure = error as { name?: unknown; code?: unknown } | null;
  return {
    errorName: typeof failure?.name === 'string' ? failure.name : 'UnknownError',
    code: typeof failure?.code === 'string' ? failure.code : undefined,
  };
}

function add(total: DispatchSummary, part: DispatchSummary): void {
  for (const key of Object.keys(total) as (keyof DispatchSummary)[]) total[key] += part[key];
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(runners);
}
