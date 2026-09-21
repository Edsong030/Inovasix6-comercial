import { Logger } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import type { AppConfigService } from '../../config/app-config.service';
import { FakeOutboundChannelAdapter } from '../delivery/fake-outbound-channel.adapter';
import { OutboundAdapterRegistry } from '../delivery/outbound-adapter.registry';
import type { WhatsAppCloudAdapter } from './outbound/whatsapp-cloud.adapter';
import { WhatsappModule } from './whatsapp.module';

describe('WhatsappModule: the real adapter is registered only when the integration is enabled', () => {
  const realAdapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP) as unknown as WhatsAppCloudAdapter;
  const boot = (enabled: boolean, registry = new OutboundAdapterRegistry()) => {
    const config = { whatsappCloud: { enabled, graphApiVersion: 'v25.0', graphApiBaseUrl: 'https://graph.facebook.com', accounts: [] } } as unknown as AppConfigService;
    new WhatsappModule(config, registry, realAdapter).onModuleInit();
    return registry;
  };

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('WHATSAPP_CLOUD_ENABLED=false (the default): nothing is registered, so WHATSAPP messages stay PENDING and Meta is never called', () => {
    const registry = boot(false);

    expect(registry.get(ConversationChannel.WHATSAPP)).toBeUndefined();
    expect(registry.channels()).toEqual([]);
  });

  it('WHATSAPP_CLOUD_ENABLED=true: WhatsAppCloudAdapter serves the WHATSAPP channel, and only that one', () => {
    const registry = boot(true);

    expect(registry.get(ConversationChannel.WHATSAPP)).toBe(realAdapter);
    expect(registry.channels()).toEqual([ConversationChannel.WHATSAPP]);
    for (const channel of [ConversationChannel.INSTAGRAM, ConversationChannel.FACEBOOK, ConversationChannel.WEBCHAT, ConversationChannel.MANUAL]) {
      expect(registry.get(channel)).toBeUndefined();
    }
  });

  it('does not disturb adapters other channels already have (a fake for WEBCHAT keeps working)', () => {
    const webchat = new FakeOutboundChannelAdapter(ConversationChannel.WEBCHAT);

    const registry = boot(true, new OutboundAdapterRegistry([webchat]));

    expect(registry.get(ConversationChannel.WEBCHAT)).toBe(webchat);
    expect(registry.get(ConversationChannel.WHATSAPP)).toBe(realAdapter);
  });

  it('refuses to silently replace another WHATSAPP adapter (a test fake and the real one cannot both serve the channel)', () => {
    const registry = new OutboundAdapterRegistry([new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP)]);

    expect(() => boot(true, registry)).toThrow(/already registered/);
  });

  it('logs the version, host and the NUMBER of accounts when enabled: no token, no tenant', () => {
    const logs: unknown[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => void logs.push(args[0]));

    boot(true);

    expect(logs).toEqual([{ event: 'whatsapp.enabled', graphApiVersion: 'v25.0', graphApiBaseUrl: 'https://graph.facebook.com', accounts: 0 }]);
  });
});
