import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import type { OutboundChannelAdapter } from './outbound-channel-adapter';

/** DI token: the list of adapters this process can deliver through. Absent or empty = nothing is delivered. */
export const OUTBOUND_CHANNEL_ADAPTERS = Symbol('OUTBOUND_CHANNEL_ADAPTERS');

/**
 * Which channels can be delivered from this process.
 *
 * NOTHING is registered by default: a channel without an adapter is not
 * delivered, its messages stay PENDING untouched (never SENT, never deleted),
 * and the dispatcher reports them (outbound.no_adapter). A fake adapter that
 * marked messages SENT for a channel nobody actually serves would be a lie, so
 * tests register their own.
 *
 * MANUAL can never be registered: it has no external provider, and a MANUAL
 * outbound message is never queued in the first place.
 */
@Injectable()
export class OutboundAdapterRegistry {
  private readonly byChannel = new Map<ConversationChannel, OutboundChannelAdapter>();

  constructor(@Optional() @Inject(OUTBOUND_CHANNEL_ADAPTERS) adapters: OutboundChannelAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: OutboundChannelAdapter): void {
    if (adapter.channel === ConversationChannel.MANUAL) {
      throw new Error('MANUAL conversations have no external provider: no adapter can be registered for MANUAL');
    }
    if (this.byChannel.has(adapter.channel)) {
      throw new Error(`An outbound adapter is already registered for ${adapter.channel}`);
    }
    this.byChannel.set(adapter.channel, adapter);
  }

  get(channel: ConversationChannel): OutboundChannelAdapter | undefined {
    return this.byChannel.get(channel);
  }

  /** Channels that can be delivered: what the claim is restricted to. */
  channels(): ConversationChannel[] {
    return [...this.byChannel.keys()];
  }
}
