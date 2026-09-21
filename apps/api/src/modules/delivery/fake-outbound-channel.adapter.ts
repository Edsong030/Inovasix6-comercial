import type { ConversationChannel } from '@prisma/client';
import {
  OutboundChannelAdapter,
  OutboundDeliveryError,
  OutboundSendInput,
  OutboundSendResult,
} from './outbound-channel-adapter';

/**
 * What the fake does on one send():
 *  - ok:        the provider accepts and returns an id (given, or derived from the idempotency key)
 *  - temporary: OutboundDeliveryError('temporary', code)
 *  - permanent: OutboundDeliveryError('permanent', code)
 *  - hang:      never answers on its own; rejects only if the engine aborts the signal (a timeout)
 *  - throw:     a bare Error, the way an unclassified provider/client failure looks
 *  - invalid:   resolves without an id (a contract violation)
 */
export type FakeSendBehavior =
  | { kind: 'ok'; externalMessageId?: string }
  | { kind: 'temporary'; code?: string }
  | { kind: 'permanent'; code?: string }
  | { kind: 'hang' }
  | { kind: 'throw'; message?: string }
  | { kind: 'invalid' };

/**
 * In-process stand-in for a provider, for tests and local development. It
 * never touches the network. NOT registered anywhere by default: a channel is
 * only "deliverable" if something registers an adapter for it, and a fake that
 * marks messages SENT must be a deliberate choice of the test that wants it.
 */
export class FakeOutboundChannelAdapter implements OutboundChannelAdapter {
  /** Every send() call, in order (the abort signal is not kept). */
  readonly calls: Omit<OutboundSendInput, 'signal'>[] = [];
  /** Sends the fake "provider" accepted: what a real customer would have received. */
  readonly accepted: { idempotencyKey: string; externalMessageId: string; body: string }[] = [];

  private readonly script: FakeSendBehavior[] = [];
  private inFlight = 0;
  private peakInFlight = 0;
  private sequence = 0;

  constructor(
    readonly channel: ConversationChannel,
    private readonly options: {
      /** Used when the script is empty. Defaults to a plain success. */
      defaultBehavior?: FakeSendBehavior;
      /** Simulated provider latency before answering, in ms. */
      latencyMs?: number;
      /** Awaited at the start of every send(): lets a test hold sends and observe concurrency. */
      gate?: (input: Omit<OutboundSendInput, 'signal'>) => Promise<void>;
    } = {},
  ) {}

  /** Queue behaviors for the next sends, consumed in order. */
  enqueue(...behaviors: FakeSendBehavior[]): this {
    this.script.push(...behaviors);
    return this;
  }

  /** Highest number of send() calls that were in progress at the same time. */
  get maxConcurrentSends(): number {
    return this.peakInFlight;
  }

  async send(input: OutboundSendInput): Promise<OutboundSendResult> {
    const { signal, ...recorded } = input;
    this.calls.push(recorded);
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      await this.options.gate?.(recorded);
      if (this.options.latencyMs) await sleep(this.options.latencyMs, signal);

      const behavior = this.script.shift() ?? this.options.defaultBehavior ?? { kind: 'ok' };
      switch (behavior.kind) {
        case 'ok': {
          this.sequence += 1;
          const externalMessageId =
            behavior.externalMessageId ?? `fake-${this.channel.toLowerCase()}-${input.idempotencyKey}-${this.sequence}`;
          this.accepted.push({ idempotencyKey: input.idempotencyKey, externalMessageId, body: input.body });
          return { externalMessageId };
        }
        case 'temporary':
          throw OutboundDeliveryError.temporary(behavior.code ?? 'FAKE_TEMPORARY');
        case 'permanent':
          throw OutboundDeliveryError.permanent(behavior.code ?? 'FAKE_PERMANENT');
        case 'hang':
          return await new Promise<OutboundSendResult>((_resolve, reject) => {
            if (signal.aborted) return reject(new Error('aborted'));
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        case 'throw':
          throw new Error(behavior.message ?? 'fake provider blew up');
        case 'invalid':
          return {} as OutboundSendResult;
      }
    } finally {
      this.inFlight -= 1;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
