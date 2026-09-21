import { ConversationChannel } from '@prisma/client';
import { FakeOutboundChannelAdapter } from './fake-outbound-channel.adapter';
import { OutboundDeliveryError, OutboundSendInput } from './outbound-channel-adapter';

const input = (overrides: Partial<OutboundSendInput> = {}): OutboundSendInput => ({
  idempotencyKey: 'msg-1',
  tenantId: 'tenant-1',
  conversationId: 'conv-1',
  channel: ConversationChannel.WHATSAPP,
  recipient: { externalContactId: '5511999990000', externalConversationId: null },
  body: 'Olá',
  signal: new AbortController().signal,
  ...overrides,
});

describe('FakeOutboundChannelAdapter', () => {
  it('accepts by default and returns a provider id, recording what the "customer" got', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP);

    const result = await adapter.send(input());

    expect(result.externalMessageId).toEqual(expect.stringContaining('msg-1'));
    expect(adapter.accepted).toEqual([{ idempotencyKey: 'msg-1', externalMessageId: result.externalMessageId, body: 'Olá' }]);
    expect(adapter.calls).toHaveLength(1);
  });

  it('returns the scripted id when one is given', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP).enqueue({ kind: 'ok', externalMessageId: 'wamid.ABC' });

    await expect(adapter.send(input())).resolves.toEqual({ externalMessageId: 'wamid.ABC' });
  });

  it('plays the script in order, then falls back to the default behaviour', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP).enqueue({ kind: 'temporary', code: 'RATE_LIMITED' }, { kind: 'permanent', code: 'BLOCKED' });

    await expect(adapter.send(input())).rejects.toMatchObject({ kind: 'temporary', code: 'RATE_LIMITED' });
    await expect(adapter.send(input())).rejects.toMatchObject({ kind: 'permanent', code: 'BLOCKED' });
    await expect(adapter.send(input())).resolves.toEqual({ externalMessageId: expect.any(String) });
    expect(adapter.accepted).toHaveLength(1);
  });

  it('classifies temporary and permanent failures with OutboundDeliveryError', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP).enqueue({ kind: 'temporary' }, { kind: 'permanent' });

    await expect(adapter.send(input())).rejects.toBeInstanceOf(OutboundDeliveryError);
    await expect(adapter.send(input())).rejects.toMatchObject({ kind: 'permanent', code: 'FAKE_PERMANENT' });
  });

  it('can throw a bare, unclassified error and return an invalid (id-less) result', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP).enqueue({ kind: 'throw', message: 'socket hang up' }, { kind: 'invalid' });

    await expect(adapter.send(input())).rejects.not.toBeInstanceOf(OutboundDeliveryError);
    await expect(adapter.send(input())).resolves.toEqual({});
  });

  it('"hang" never answers on its own and rejects when the engine aborts (a timeout)', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP).enqueue({ kind: 'hang' });
    const controller = new AbortController();

    const pending = adapter.send(input({ signal: controller.signal }));
    let settled = false;
    void pending.catch(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
  });

  it('tracks the peak number of concurrent sends and never touches the network', async () => {
    const adapter = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP, { latencyMs: 20 });

    await Promise.all([adapter.send(input({ idempotencyKey: 'a' })), adapter.send(input({ idempotencyKey: 'b' })), adapter.send(input({ idempotencyKey: 'c' }))]);

    expect(adapter.maxConcurrentSends).toBe(3);
    expect(adapter.accepted).toHaveLength(3);
  });
});
