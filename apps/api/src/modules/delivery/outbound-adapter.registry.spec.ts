import { ConversationChannel } from '@prisma/client';
import { FakeOutboundChannelAdapter } from './fake-outbound-channel.adapter';
import { OutboundAdapterRegistry } from './outbound-adapter.registry';

describe('OutboundAdapterRegistry', () => {
  it('has NO adapter by default: nothing is deliverable until a provider integration registers one', () => {
    const registry = new OutboundAdapterRegistry();

    expect(registry.channels()).toEqual([]);
    expect(registry.get(ConversationChannel.WHATSAPP)).toBeUndefined();
  });

  it('resolves the adapter of the message channel, and only that one', () => {
    const whatsapp = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP);
    const webchat = new FakeOutboundChannelAdapter(ConversationChannel.WEBCHAT);
    const registry = new OutboundAdapterRegistry([whatsapp, webchat]);

    expect(registry.get(ConversationChannel.WHATSAPP)).toBe(whatsapp);
    expect(registry.get(ConversationChannel.WEBCHAT)).toBe(webchat);
    expect(registry.get(ConversationChannel.INSTAGRAM)).toBeUndefined();
    expect(registry.channels().sort()).toEqual([ConversationChannel.WEBCHAT, ConversationChannel.WHATSAPP]);
  });

  it('refuses an adapter for MANUAL: there is no external provider to deliver to', () => {
    expect(() => new OutboundAdapterRegistry([new FakeOutboundChannelAdapter(ConversationChannel.MANUAL)])).toThrow(/MANUAL/);
  });

  it('refuses two adapters for the same channel instead of silently picking one', () => {
    const registry = new OutboundAdapterRegistry([new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP)]);

    expect(() => registry.register(new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP))).toThrow(/already registered/);
  });
});
