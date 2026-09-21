import { Logger } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import type { AppConfigService } from '../../config/app-config.service';
import { OUTBOUND_BACKOFF_MS } from './delivery-policy';
import { FakeOutboundChannelAdapter } from './fake-outbound-channel.adapter';
import { OutboundAdapterRegistry } from './outbound-adapter.registry';
import { OutboundDeliveryError } from './outbound-channel-adapter';
import { ClaimedMessage, OutboundDeliveryRepository } from './outbound-delivery.repository';
import { OutboundDispatcherService, TENANTS_PER_POLL, TENANT_CONCURRENCY } from './outbound-dispatcher.service';

/**
 * Orchestration of the dispatcher against a stubbed repository (the SQL and the
 * lease protocol are proven on a real PostgreSQL in outbound-delivery.integration-spec).
 */

const BODY = 'Texto sigiloso da mensagem';
const RECIPIENT = '5511988887777';

const claimed = (overrides: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  id: 'msg-1',
  tenantId: 'tenant-1',
  conversationId: 'conv-1',
  channel: ConversationChannel.WHATSAPP,
  body: BODY,
  attempt: 1,
  leaseToken: 'lease-1',
  externalConversationId: null,
  recipientExternalId: RECIPIENT,
  ...overrides,
});

type Repo = jest.Mocked<OutboundDeliveryRepository>;

function makeRepo(): Repo {
  return {
    discoverTenants: jest.fn().mockResolvedValue([]),
    claim: jest.fn().mockResolvedValue({ claimed: [], exhausted: [] }),
    markSent: jest.fn().mockResolvedValue('sent'),
    markRetry: jest.fn().mockResolvedValue('done'),
    markFailed: jest.fn().mockResolvedValue('done'),
    countWithoutAdapter: jest.fn().mockResolvedValue([]),
  } as unknown as Repo;
}

describe('OutboundDispatcherService', () => {
  const logs: { level: string; payload: any }[] = [];
  let repo: Repo;
  let whatsapp: FakeOutboundChannelAdapter;
  let registry: OutboundAdapterRegistry;
  let settings: { workerEnabled: boolean; pollIntervalMs: number; batchSize: number; leaseMs: number; sendTimeoutMs: number };
  let dispatcher: OutboundDispatcherService;

  const build = (adapters = [whatsapp]) => {
    registry = new OutboundAdapterRegistry(adapters);
    dispatcher = new OutboundDispatcherService(repo, registry, { get outboundDelivery() { return settings; } } as unknown as AppConfigService);
    dispatcher.random = () => 0.5;
  };
  const events = (name: string) => logs.filter((l) => l.payload?.event === name).map((l) => l.payload);

  beforeEach(() => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => void logs.push({ level, payload: args[0] }));
    }
    repo = makeRepo();
    whatsapp = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP);
    settings = { workerEnabled: true, pollIntervalMs: 1000, batchSize: 10, leaseMs: 60_000, sendTimeoutMs: 40 };
    build();
  });

  afterEach(() => jest.restoreAllMocks());

  const claimOne = (message = claimed()) => repo.claim.mockResolvedValueOnce({ claimed: [message], exhausted: [] });

  describe('selection', () => {
    it('claims only channels that have an adapter, with the configured batch size and lease', async () => {
      settings.batchSize = 7;
      settings.leaseMs = 90_000;
      build([whatsapp, new FakeOutboundChannelAdapter(ConversationChannel.WEBCHAT)]);

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.claim).toHaveBeenCalledWith('tenant-1', { channels: expect.arrayContaining(['WHATSAPP', 'WEBCHAT']), batchSize: 7, leaseMs: 90_000 });
      expect(repo.claim.mock.calls[0][1].channels).toHaveLength(2);
    });

    it('does nothing (and sends nothing) when nothing was claimed', async () => {
      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(summary).toMatchObject({ claimed: 0, sent: 0, retried: 0, failed: 0 });
      expect(whatsapp.calls).toHaveLength(0);
      expect(repo.markSent).not.toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    it('hands the adapter of the message channel a provider-neutral request', async () => {
      const webchat = new FakeOutboundChannelAdapter(ConversationChannel.WEBCHAT);
      build([whatsapp, webchat]);
      claimOne(claimed({ channel: ConversationChannel.WEBCHAT, externalConversationId: 'session-9', recipientExternalId: 'visitor-1' }));

      await dispatcher.dispatchTenant('tenant-1');

      expect(whatsapp.calls).toHaveLength(0);
      expect(webchat.calls).toEqual([
        {
          idempotencyKey: 'msg-1',
          tenantId: 'tenant-1',
          conversationId: 'conv-1',
          channel: 'WEBCHAT',
          recipient: { externalContactId: 'visitor-1', externalConversationId: 'session-9' },
          body: BODY,
        },
      ]);
    });

    it('success: SENT with the provider id, using the lease token, and counts as sent', async () => {
      whatsapp.enqueue({ kind: 'ok', externalMessageId: 'wamid.123' });
      claimOne();

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markSent).toHaveBeenCalledWith('tenant-1', 'msg-1', 'lease-1', 'wamid.123');
      expect(repo.markRetry).not.toHaveBeenCalled();
      expect(repo.markFailed).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    });

    it('never asks for DELIVERED: a provider that merely accepted the message means SENT', async () => {
      claimOne();

      await dispatcher.dispatchTenant('tenant-1');

      // the repository has no "delivered" operation at all; the only success write is markSent
      expect(Object.keys(repo).filter((key) => /deliver/i.test(key))).toEqual([]);
      expect(repo.markSent).toHaveBeenCalledTimes(1);
    });

    it('sends the whole claimed batch at the same time, so the slowest send (not the sum) bounds the lease', async () => {
      const release: Array<() => void> = [];
      const gated = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP, { gate: () => new Promise<void>((resolve) => release.push(resolve)) });
      build([gated]);
      settings.sendTimeoutMs = 5_000;
      repo.claim.mockResolvedValueOnce({ claimed: [claimed({ id: 'a' }), claimed({ id: 'b' }), claimed({ id: 'c' })], exhausted: [] });

      const running = dispatcher.dispatchTenant('tenant-1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(gated.maxConcurrentSends).toBe(3);
      release.forEach((go) => go());

      await expect(running).resolves.toMatchObject({ claimed: 3, sent: 3 });
    });
  });

  describe('failures and retry', () => {
    it.each([1, 2, 3, 4])('temporary failure of attempt %i goes back to the queue after the approved backoff', async (attempt) => {
      whatsapp.enqueue({ kind: 'temporary', code: 'RATE_LIMITED' });
      claimOne(claimed({ attempt }));

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markRetry).toHaveBeenCalledWith('tenant-1', 'msg-1', 'lease-1', 'RATE_LIMITED', OUTBOUND_BACKOFF_MS[attempt - 1]);
      expect(repo.markFailed).not.toHaveBeenCalled();
      expect(repo.markSent).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ retried: 1, failed: 0 });
    });

    it('applies jitter to the persisted delay (+/-20%)', async () => {
      dispatcher.random = () => 0; // lowest
      whatsapp.enqueue({ kind: 'temporary' });
      claimOne(claimed({ attempt: 2 }));

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markRetry.mock.calls[0][4]).toBe(240_000); // 300 000 * 0.8
    });

    it('a temporary failure of the LAST (5th) attempt ends in FAILED, never in another retry', async () => {
      whatsapp.enqueue({ kind: 'temporary', code: 'UPSTREAM_5XX' });
      claimOne(claimed({ attempt: 5 }));

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markFailed).toHaveBeenCalledWith('tenant-1', 'msg-1', 'lease-1', 'UPSTREAM_5XX');
      expect(repo.markRetry).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ failed: 1, retried: 0 });
      expect(events('outbound.failed')[0]).toMatchObject({ reason: 'attempts_exhausted', attempt: 5 });
    });

    it('a permanent failure is FAILED immediately, even on the first attempt', async () => {
      whatsapp.enqueue({ kind: 'permanent', code: 'RECIPIENT_BLOCKED' });
      claimOne(claimed({ attempt: 1 }));

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markFailed).toHaveBeenCalledWith('tenant-1', 'msg-1', 'lease-1', 'RECIPIENT_BLOCKED');
      expect(repo.markRetry).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ failed: 1 });
      expect(events('outbound.failed')[0]).toMatchObject({ reason: 'permanent' });
    });

    it('an unclassified error is temporary ADAPTER_ERROR and its text is never stored or logged', async () => {
      whatsapp.enqueue({ kind: 'throw', message: `ECONNRESET talking to ${RECIPIENT} with token sk_live_SEGREDO` });
      claimOne();

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markRetry.mock.calls[0][3]).toBe('ADAPTER_ERROR');
      expect(JSON.stringify([repo.markRetry.mock.calls, logs])).not.toMatch(/SEGREDO|ECONNRESET/);
    });

    it('an adapter that throws synchronously is handled like any other failure', async () => {
      const broken = { channel: ConversationChannel.WHATSAPP, send: () => { throw new Error('boom'); } };
      build([broken as never]);
      claimOne();

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markRetry.mock.calls[0][3]).toBe('ADAPTER_ERROR');
    });

    it('a malformed error code from an adapter is replaced (it is persisted and logged, so it cannot carry free text)', async () => {
      const leaky = { channel: ConversationChannel.WHATSAPP, send: async () => { throw new OutboundDeliveryError('permanent', 'blocked: 5511988887777 said no'); } };
      build([leaky as never]);
      claimOne();

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markFailed.mock.calls[0][3]).toBe('ADAPTER_ERROR');
    });

    it('timeout: aborts the send, is a TEMPORARY failure (TIMEOUT), and the late outcome does not blow up', async () => {
      whatsapp.enqueue({ kind: 'hang' });
      claimOne();

      const started = Date.now();
      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(Date.now() - started).toBeLessThan(1000);
      expect(repo.markRetry.mock.calls[0][3]).toBe('TIMEOUT');
      expect(summary).toMatchObject({ retried: 1 });
      // let the aborted fake settle: no unhandled rejection may surface
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it.each([
      ['no id', {}],
      ['an empty id', { externalMessageId: '' }],
      ['a blank id', { externalMessageId: '   ' }],
      ['a non-string id', { externalMessageId: 42 }],
      ['an oversized id', { externalMessageId: 'x'.repeat(513) }],
    ])('a provider "success" with %s violates the contract: permanent INVALID_ADAPTER_RESULT, never SENT', async (_name, result) => {
      const bad = { channel: ConversationChannel.WHATSAPP, send: async () => result };
      build([bad as never]);
      claimOne();

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markSent).not.toHaveBeenCalled();
      expect(repo.markFailed.mock.calls[0][3]).toBe('INVALID_ADAPTER_RESULT');
    });

    it.each([[null], [''], ['   ']])('a message with body %p has nothing to send: permanent EMPTY_BODY, no provider call', async (body) => {
      claimOne(claimed({ body }));

      await dispatcher.dispatchTenant('tenant-1');

      expect(whatsapp.calls).toHaveLength(0);
      expect(repo.markFailed.mock.calls[0][3]).toBe('EMPTY_BODY');
    });

    it('a contact with no identity on the channel cannot be reached: permanent NO_RECIPIENT, no provider call', async () => {
      claimOne(claimed({ recipientExternalId: null }));

      await dispatcher.dispatchTenant('tenant-1');

      expect(whatsapp.calls).toHaveLength(0);
      expect(repo.markFailed.mock.calls[0][3]).toBe('NO_RECIPIENT');
    });
  });

  describe('missing adapter', () => {
    it('is defensive: a claimed message whose adapter vanished is retried later (NO_ADAPTER), never sent or SENT', async () => {
      claimOne(claimed({ channel: ConversationChannel.INSTAGRAM }));

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.markSent).not.toHaveBeenCalled();
      expect(repo.markRetry.mock.calls[0][3]).toBe('NO_ADAPTER');
    });

    it('claims nothing for a channel with no adapter and reports it explicitly, without touching the messages', async () => {
      repo.countWithoutAdapter.mockResolvedValue([{ channel: ConversationChannel.INSTAGRAM, count: 3 }]);

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.claim.mock.calls[0][1].channels).toEqual(['WHATSAPP']);
      expect(events('outbound.no_adapter')).toEqual([{ event: 'outbound.no_adapter', tenantId: 'tenant-1', channel: 'INSTAGRAM', pending: 3 }]);
      expect(repo.markSent).not.toHaveBeenCalled();
      expect(repo.markRetry).not.toHaveBeenCalled();
      expect(repo.markFailed).not.toHaveBeenCalled();
    });

    it('with no adapter at all it claims nothing (channels: []) and still reports', async () => {
      build([]);
      repo.countWithoutAdapter.mockResolvedValue([{ channel: ConversationChannel.WHATSAPP, count: 1 }]);

      await dispatcher.dispatchTenant('tenant-1');

      expect(repo.claim.mock.calls[0][1].channels).toEqual([]);
      expect(events('outbound.no_adapter')).toHaveLength(1);
    });

    it('does not flood the log: the same tenant+channel is reported once per 5 minutes', async () => {
      let now = 1_000_000;
      dispatcher.clock = () => now;
      repo.countWithoutAdapter.mockResolvedValue([{ channel: ConversationChannel.INSTAGRAM, count: 3 }]);

      await dispatcher.dispatchTenant('tenant-1');
      await dispatcher.dispatchTenant('tenant-1');
      expect(events('outbound.no_adapter')).toHaveLength(1);

      now += 4 * 60_000;
      await dispatcher.dispatchTenant('tenant-1');
      expect(events('outbound.no_adapter')).toHaveLength(1);

      now += 2 * 60_000;
      await dispatcher.dispatchTenant('tenant-1');
      expect(events('outbound.no_adapter')).toHaveLength(2);

      await dispatcher.dispatchTenant('tenant-2');
      expect(events('outbound.no_adapter')).toHaveLength(3);
    });
  });

  describe('attempts that ran out', () => {
    it('reports messages the claim moved to FAILED (LEASE_EXPIRED) and sends nothing for them', async () => {
      repo.claim.mockResolvedValueOnce({ claimed: [], exhausted: [{ id: 'msg-9', conversationId: 'conv-9', attempt: 5, code: 'LEASE_EXPIRED' }] });

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(summary).toMatchObject({ exhausted: 1, claimed: 0 });
      expect(whatsapp.calls).toHaveLength(0);
      expect(events('outbound.failed')[0]).toMatchObject({ messageId: 'msg-9', code: 'LEASE_EXPIRED', reason: 'attempts_exhausted', attempt: 5 });
    });
  });

  describe('finalization', () => {
    it('losing the lease after a send is reported (the provider accepted it; someone else owns the row now)', async () => {
      repo.markSent.mockResolvedValueOnce('lease_lost');
      claimOne();

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(summary).toMatchObject({ leaseLost: 1, sent: 0 });
      expect(events('outbound.lease_lost')[0]).toMatchObject({ messageId: 'msg-1', accepted: true });
      expect(events('outbound.sent')).toHaveLength(0);
    });

    it('losing the lease on a retry/failure write is reported too', async () => {
      whatsapp.enqueue({ kind: 'temporary' }, { kind: 'permanent' });
      repo.markRetry.mockResolvedValueOnce('lease_lost');
      repo.markFailed.mockResolvedValueOnce('lease_lost');
      repo.claim.mockResolvedValueOnce({ claimed: [claimed({ id: 'a' }), claimed({ id: 'b' })], exhausted: [] });

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(summary.leaseLost).toBe(2);
      expect(events('outbound.lease_lost')).toHaveLength(2);
    });

    it('an externalId conflict is still SENT (the provider accepted it) but is logged as an error', async () => {
      repo.markSent.mockResolvedValueOnce('sent_external_id_conflict');
      claimOne();

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(summary.sent).toBe(1);
      expect(events('outbound.external_id_conflict')).toHaveLength(1);
      expect(logs.find((l) => l.payload?.event === 'outbound.external_id_conflict')?.level).toBe('error');
    });

    it('a database error while writing the outcome does not throw and does not stop the rest of the batch', async () => {
      repo.markSent.mockRejectedValueOnce(Object.assign(new Error(`connection lost near ${BODY}`), { name: 'PrismaClientKnownRequestError', code: 'P1001' }));
      repo.claim.mockResolvedValueOnce({ claimed: [claimed({ id: 'a' }), claimed({ id: 'b' })], exhausted: [] });

      const summary = await dispatcher.dispatchTenant('tenant-1');

      expect(summary).toMatchObject({ claimed: 2, sent: 1, finalizeErrors: 1 });
      expect(events('outbound.finalize_error')[0]).toMatchObject({ errorName: 'PrismaClientKnownRequestError', code: 'P1001' });
      expect(JSON.stringify(logs)).not.toContain(BODY);
    });
  });

  describe('cycle across tenants', () => {
    it('serves every discovered tenant and sums the results', async () => {
      repo.discoverTenants.mockResolvedValueOnce(['t1', 't2', 't3']);
      repo.claim.mockImplementation(async (tenantId) => ({ claimed: [claimed({ id: `m-${tenantId}`, tenantId })], exhausted: [] }));

      const result = await dispatcher.dispatchCycle(null);

      expect(repo.discoverTenants).toHaveBeenCalledWith(TENANTS_PER_POLL, null);
      expect(result).toMatchObject({ tenants: 3, claimed: 3, sent: 3, nextCursor: null });
    });

    it('a failing tenant is logged (name only) and does not stop the others', async () => {
      repo.discoverTenants.mockResolvedValueOnce(['t1', 't2', 't3']);
      repo.claim.mockImplementation(async (tenantId) => {
        if (tenantId === 't2') throw Object.assign(new Error(`db said: ${BODY}`), { name: 'PrismaClientInitializationError' });
        return { claimed: [claimed({ id: `m-${tenantId}`, tenantId })], exhausted: [] };
      });

      const result = await dispatcher.dispatchCycle(null);

      expect(result).toMatchObject({ tenants: 3, sent: 2 });
      expect(events('outbound.tenant_error')).toEqual([{ event: 'outbound.tenant_error', tenantId: 't2', errorName: 'PrismaClientInitializationError', code: undefined }]);
      expect(JSON.stringify(logs)).not.toContain(BODY);
    });

    it('pages through tenants with a cursor: a full page continues after its last tenant, a short page starts over', async () => {
      const full = Array.from({ length: TENANTS_PER_POLL }, (_, i) => `t${String(i).padStart(3, '0')}`);
      repo.discoverTenants.mockResolvedValueOnce(full).mockResolvedValueOnce(['t900']);

      const first = await dispatcher.dispatchCycle(null);
      expect(first.nextCursor).toBe(full[full.length - 1]);

      const second = await dispatcher.dispatchCycle(first.nextCursor);
      expect(repo.discoverTenants).toHaveBeenLastCalledWith(TENANTS_PER_POLL, full[full.length - 1]);
      expect(second.nextCursor).toBeNull();
    });

    it(`serves at most ${TENANT_CONCURRENCY} tenants at the same time`, async () => {
      let active = 0;
      let peak = 0;
      repo.discoverTenants.mockResolvedValueOnce(Array.from({ length: 12 }, (_, i) => `t${i}`));
      repo.claim.mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { claimed: [], exhausted: [] };
      });

      await dispatcher.dispatchCycle(null);

      expect(peak).toBe(TENANT_CONCURRENCY);
    });
  });

  describe('observability', () => {
    it('emits claimed, sent, retry and failed events with ids, channel and attempt', async () => {
      whatsapp.enqueue({ kind: 'ok', externalMessageId: 'wamid.OK' }, { kind: 'temporary', code: 'TIMEOUT' }, { kind: 'permanent', code: 'BLOCKED' });
      repo.claim.mockResolvedValueOnce({
        claimed: [claimed({ id: 'a', attempt: 1 }), claimed({ id: 'b', attempt: 2 }), claimed({ id: 'c', attempt: 3 })],
        exhausted: [],
      });

      await dispatcher.dispatchTenant('tenant-1');

      const base = { tenantId: 'tenant-1', conversationId: 'conv-1', channel: 'WHATSAPP' };
      expect(events('outbound.claimed').map((e) => e.messageId).sort()).toEqual(['a', 'b', 'c']);
      expect(events('outbound.sent')).toEqual([{ event: 'outbound.sent', ...base, messageId: 'a', attempt: 1, externalMessageId: 'wamid.OK' }]);
      expect(events('outbound.retry')).toEqual([{ event: 'outbound.retry', ...base, messageId: 'b', attempt: 2, code: 'TIMEOUT', retryInMs: 300_000 }]);
      expect(events('outbound.failed')).toEqual([{ event: 'outbound.failed', ...base, messageId: 'c', attempt: 3, code: 'BLOCKED', reason: 'permanent' }]);
    });

    it('never logs the message body, the recipient or the provider payload, on any path', async () => {
      whatsapp.enqueue({ kind: 'ok' }, { kind: 'temporary' }, { kind: 'permanent' }, { kind: 'throw', message: `${BODY} ${RECIPIENT}` });
      repo.claim.mockResolvedValueOnce({
        claimed: [claimed({ id: 'a' }), claimed({ id: 'b' }), claimed({ id: 'c' }), claimed({ id: 'd', attempt: 5 })],
        exhausted: [],
      });

      await dispatcher.dispatchTenant('tenant-1');

      expect(logs.length).toBeGreaterThan(4);
      const everything = JSON.stringify(logs.map((l) => l.payload));
      expect(everything).not.toContain(BODY);
      expect(everything).not.toContain(RECIPIENT);
    });
  });
});
