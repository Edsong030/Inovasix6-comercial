import { Logger } from '@nestjs/common';
import { ConversationChannel, MessageDirection, MessageSenderType, MessageStatus, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import type { AppConfigService } from '../src/config/app-config.service';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../src/config/first-contact';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { ConversationIngressService } from '../src/modules/conversations/conversation-ingress.service';
import { ConversationIntakeService } from '../src/modules/conversations/conversation-intake.service';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
import { FirstContactService } from '../src/modules/conversations/first-contact/first-contact.service';
import { OUTBOUND_BACKOFF_MS, OUTBOUND_MAX_ATTEMPTS } from '../src/modules/delivery/delivery-policy';
import { FakeOutboundChannelAdapter } from '../src/modules/delivery/fake-outbound-channel.adapter';
import { OutboundAdapterRegistry } from '../src/modules/delivery/outbound-adapter.registry';
import { ClaimOptions, OutboundDeliveryRepository } from '../src/modules/delivery/outbound-delivery.repository';
import { OutboundDispatcherService } from '../src/modules/delivery/outbound-dispatcher.service';
import { OutboundWorker } from '../src/modules/delivery/outbound-worker.service';
import { MessagesService } from '../src/modules/messages/messages.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeAppClient, makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * Outbound delivery engine against REAL PostgreSQL (application role, RLS
 * enforced; the owner role only seeds and inspects). What is proven here is the
 * database side: the claim (FOR UPDATE SKIP LOCKED), the lease, the
 * compare-and-set finalization, the constraints, the SECURITY DEFINER tenant
 * discovery, and that none of it lets two workers send the same message at once.
 *
 * Nothing here calls a network: every "provider" is a FakeOutboundChannelAdapter.
 */
jest.setTimeout(120_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BODY = 'Corpo secreto da mensagem';

describe('outbound delivery engine (integration, real Postgres)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let repo: OutboundDeliveryRepository;
  let messagesService: MessagesService;
  let conversationsService: ConversationsService;
  let intake: ConversationIntakeService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantC = randomUUID();
  const mine = new Set<string>([tenantA, tenantB, tenantC]);
  const userA = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: userA, roleCodes: ['ADMIN'] };

  const settings = { workerEnabled: true, pollIntervalMs: 50, batchSize: 10, leaseMs: 60_000, sendTimeoutMs: 1_000 };
  const config = { get outboundDelivery() { return settings; }, firstContactMessage: DEFAULT_FIRST_CONTACT_MESSAGE } as unknown as AppConfigService;
  const ALL_CHANNELS = [ConversationChannel.WHATSAPP, ConversationChannel.INSTAGRAM, ConversationChannel.FACEBOOK, ConversationChannel.WEBCHAT];
  const opts = (over: Partial<ClaimOptions> = {}): ClaimOptions => ({ channels: ALL_CHANNELS, batchSize: 10, leaseMs: 60_000, ...over });

  const owner = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(ownerPrisma, tenantId, work);
  const row = (tenantId: string, id: string) => owner<any>(tenantId, (tx) => tx.message.findUniqueOrThrow({ where: { id } }));
  const messagesOf = (tenantId: string, where: object = {}) =>
    owner<any[]>(tenantId, (tx) => tx.message.findMany({ where: { tenantId, ...where }, orderBy: { createdAt: 'asc' } }));
  const secondsFromNow = (tenantId: string, id: string, column: 'next_attempt_at' | 'lease_expires_at') =>
    owner<number>(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT extract(epoch FROM (${column} - now()))::float AS secs FROM messages WHERE id = '${id}'::uuid`);
      return rows[0].secs as number;
    });

  const makeAdapter = (channel: ConversationChannel = ConversationChannel.WHATSAPP, options = {}) => new FakeOutboundChannelAdapter(channel, options);
  const makeDispatcher = (adapters: FakeOutboundChannelAdapter[], repository: OutboundDeliveryRepository = repo) => {
    const dispatcher = new OutboundDispatcherService(repository, new OutboundAdapterRegistry(adapters), config);
    dispatcher.random = () => 0.5;
    return dispatcher;
  };

  async function seedConversation(
    tenantId: string,
    over: { channel?: ConversationChannel; identity?: string | null; externalConversationId?: string | null } = {},
  ) {
    const channel = over.channel ?? ConversationChannel.WHATSAPP;
    const identity = over.identity === undefined ? `id-${randomUUID().slice(0, 8)}` : over.identity;
    return owner(tenantId, async (tx) => {
      const contact = await tx.contact.create({ data: { tenantId, name: 'Cliente Sigiloso' } });
      if (identity) await tx.contactChannelIdentity.create({ data: { tenantId, contactId: contact.id, channel, externalContactId: identity } });
      const conversation = await tx.conversation.create({
        data: { tenantId, contactId: contact.id, channel, state: 'AGUARDANDO_HUMANO', externalConversationId: over.externalConversationId ?? null },
      });
      return { conversationId: conversation.id as string, identity: identity as string | null };
    });
  }

  type SeedMessage = Partial<{
    direction: MessageDirection;
    status: MessageStatus;
    senderType: MessageSenderType;
    body: string | null;
    externalId: string | null;
    nextAttemptAt: Date | null;
    deliveryAttempts: number;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
    createdAt: Date;
  }>;
  async function seedMessage(tenantId: string, conversationId: string, over: SeedMessage = {}) {
    const senderType = over.senderType ?? MessageSenderType.SYSTEM;
    const created = await owner(tenantId, (tx) =>
      tx.message.create({
        data: {
          tenantId,
          conversationId,
          direction: over.direction ?? MessageDirection.OUTBOUND,
          status: over.status ?? MessageStatus.PENDING,
          senderType,
          senderUserId: senderType === MessageSenderType.AGENT ? userA : null,
          body: over.body === undefined ? BODY : over.body,
          externalId: over.externalId ?? null,
          nextAttemptAt: over.nextAttemptAt === undefined ? new Date(Date.now() - 1_000) : over.nextAttemptAt,
          deliveryAttempts: over.deliveryAttempts ?? 0,
          leaseToken: over.leaseToken ?? null,
          leaseExpiresAt: over.leaseExpiresAt ?? null,
          createdAt: over.createdAt ?? new Date(),
        },
      }),
    );
    return created.id as string;
  }
  /** A queued, due, deliverable outbound message on a fresh WHATSAPP conversation. */
  async function seedDeliverable(tenantId = tenantA, over: SeedMessage = {}, conv: Parameters<typeof seedConversation>[1] = {}) {
    const { conversationId, identity } = await seedConversation(tenantId, conv);
    const id = await seedMessage(tenantId, conversationId, over);
    return { id, conversationId, identity };
  }
  const expireLease = (tenantId: string, id: string) =>
    owner(tenantId, (tx) => tx.$executeRawUnsafe(`UPDATE messages SET lease_expires_at = now() - interval '1 second' WHERE id = '${id}'::uuid`));
  const makeDue = (tenantId: string, id: string) =>
    owner(tenantId, (tx) => tx.$executeRawUnsafe(`UPDATE messages SET next_attempt_at = now() - interval '1 second' WHERE id = '${id}'::uuid`));

  async function wipe(tenantId: string) {
    await owner(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  /** A repository whose claim() waits until `parties` callers arrived: they all contend at the same instant. */
  function contended(parties: number): OutboundDeliveryRepository {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return Object.assign(Object.create(repo) as OutboundDeliveryRepository, {
      claim: async (...args: Parameters<OutboundDeliveryRepository['claim']>) => {
        if (++arrived === parties) release();
        await gate;
        return repo.claim(...args);
      },
    });
  }

  const logs: { level: string; payload: any }[] = [];
  const captureLogs = () => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => void logs.push({ level, payload: args[0] }));
    }
  };
  const events = (name: string) => logs.filter((l) => l.payload?.event === name).map((l) => l.payload);

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    const prisma = appPrisma as unknown as PrismaService;
    repo = new OutboundDeliveryRepository(prisma);
    messagesService = new MessagesService(prisma);
    conversationsService = new ConversationsService(prisma);
    intake = new ConversationIntakeService(new ConversationIngressService(prisma, new ContactsService(prisma)), new FirstContactService(prisma, config));

    for (const [id, slug] of [
      [tenantA, 'outbound-int-a'],
      [tenantB, 'outbound-int-b'],
      [tenantC, 'outbound-int-c'],
    ]) {
      await owner(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    await owner(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'agent@outbound-int.test','Agente','x','ACTIVE',now(),now())`;
    });
  });

  beforeEach(() => captureLogs()); // keeps the run quiet; tests that assert on logs read 
  beforeEach(() => captureLogs()); // keeps the run quiet; tests that assert on logs read `logs`

  afterEach(async () => {
    jest.restoreAllMocks();
    Object.assign(settings, { workerEnabled: true, pollIntervalMs: 50, batchSize: 10, leaseMs: 60_000, sendTimeoutMs: 1_000 });
    for (const tenantId of mine) await wipe(tenantId);
  });

  afterAll(async () => {
    for (const tenantId of mine) {
      await wipe(tenantId);
      await owner(tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  describe('schema guarantees (constraints and index)', () => {
    const insert = (tenantId: string, conversationId: string, columns: string) =>
      owner(tenantId, (tx) =>
        tx.$executeRawUnsafe(`INSERT INTO messages (id, tenant_id, conversation_id, sender_type, created_at, ${columns.split('|')[0]}) VALUES (gen_random_uuid(), '${tenantId}'::uuid, '${conversationId}'::uuid, 'SYSTEM', now(), ${columns.split('|')[1]})`),
      );

    it('accepts the legal shapes: a queued PENDING outbound, a leased one, and a terminal one with no queue state', async () => {
      const { conversationId } = await seedConversation(tenantA);
      await expect(insert(tenantA, conversationId, "direction, status, next_attempt_at|'OUTBOUND', 'PENDING', now()")).resolves.toBeDefined();
      await expect(insert(tenantA, conversationId, "direction, status, next_attempt_at, lease_token, lease_expires_at, delivery_attempts|'OUTBOUND', 'PENDING', now(), gen_random_uuid(), now() + interval '1 minute', 2")).resolves.toBeDefined();
      await expect(insert(tenantA, conversationId, "direction, status, delivery_attempts|'OUTBOUND', 'SENT', 3")).resolves.toBeDefined();
    });

    it.each([
      ['a queued INBOUND message', "direction, status, next_attempt_at|'INBOUND', 'DELIVERED', now()", 'messages_delivery_state_only_outbound'],
      ['an INBOUND message with delivery attempts', "direction, status, delivery_attempts|'INBOUND', 'DELIVERED', 1", 'messages_delivery_state_only_outbound'],
      ['a lease token without expiry', "direction, status, lease_token|'OUTBOUND', 'PENDING', gen_random_uuid()", 'messages_lease_pair'],
      ['a lease expiry without token', "direction, status, lease_expires_at|'OUTBOUND', 'PENDING', now()", 'messages_lease_pair'],
      ['a SENT message still queued', "direction, status, next_attempt_at|'OUTBOUND', 'SENT', now()", 'messages_delivery_state_only_pending'],
      ['a FAILED message with a lease', "direction, status, lease_token, lease_expires_at|'OUTBOUND', 'FAILED', gen_random_uuid(), now()", 'messages_delivery_state_only_pending'],
      ['a DELIVERED message still queued', "direction, status, next_attempt_at|'OUTBOUND', 'DELIVERED', now()", 'messages_delivery_state_only_pending'],
      ['negative delivery attempts', "direction, status, delivery_attempts|'OUTBOUND', 'PENDING', -1", 'messages_delivery_attempts_nonneg'],
    ])('the database rejects %s', async (_name, columns, constraint) => {
      const { conversationId } = await seedConversation(tenantA);

      await expect(insert(tenantA, conversationId, columns)).rejects.toThrow(new RegExp(constraint));
    });

    it('FAILED cannot be put back in the queue by an UPDATE that leaves queue state on it', async () => {
      const { id } = await seedDeliverable();
      await owner(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE messages SET status = 'FAILED', next_attempt_at = NULL WHERE id = '${id}'::uuid`));

      await expect(owner(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE messages SET next_attempt_at = now() WHERE id = '${id}'::uuid`))).rejects.toThrow(/messages_delivery_state_only_pending/);
    });

    it('has the partial index over the live queue only', async () => {
      const [{ indexdef }] = await ownerPrisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_outbound_due_idx'`;

      expect(indexdef).toContain('(tenant_id, next_attempt_at)');
      expect(indexdef).toMatch(/WHERE .*direction = 'OUTBOUND'.*status = 'PENDING'.*next_attempt_at IS NOT NULL/);
    });

    it('does not backfill: a historical OUTBOUND/PENDING message (no next_attempt_at) is outside the queue and never claimed', async () => {
      const { id } = await seedDeliverable(tenantA, { nextAttemptAt: null });
      const adapter = makeAdapter();

      for (let i = 0; i < 3; i++) await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(adapter.calls).toHaveLength(0);
      expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', nextAttemptAt: null, deliveryAttempts: 0, leaseToken: null });
      expect(await repo.discoverTenants(500, null).then((ids) => ids.filter((t) => mine.has(t)))).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('SECURITY DEFINER tenant discovery', () => {
    it('is a hardened SECURITY DEFINER owned by the BYPASSRLS technical role, with a fixed search_path', async () => {
      const [fn] = await ownerPrisma.$queryRaw<any[]>`
        SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile, p.proretset,
               p.prorettype::regtype::text AS returns, pg_get_function_identity_arguments(p.oid) AS args,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
               has_function_privilege('inovasix_app', p.oid, 'EXECUTE') AS app_exec,
               has_function_privilege('inovasix_owner', p.oid, 'EXECUTE') AS owner_exec
        FROM pg_proc p WHERE p.proname = 'outbound_tenants_with_due_messages'`;

      expect(fn.owner).toBe('inovasix_auth_definer');
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toEqual(['search_path=pg_catalog, public']);
      expect(fn.provolatile).toBe('s'); // STABLE: read-only
      expect(fn.returns).toBe('uuid'); // tenant ids and nothing else
      expect(fn.proretset).toBe(true);
      expect(fn.args).toBe('p_limit integer, p_after uuid');
      expect(fn.public_exec).toBe(false);
      expect(fn.app_exec).toBe(true);
    });

    it('the definer role can read exactly five columns of messages: no body, external id, conversation or sender', async () => {
      const granted = await ownerPrisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'inovasix_auth_definer' AND table_name = 'messages' AND privilege_type = 'SELECT' ORDER BY 1`;
      expect(granted.map((c) => c.column_name)).toEqual(['direction', 'lease_expires_at', 'next_attempt_at', 'status', 'tenant_id']);

      const [privileges] = await ownerPrisma.$queryRaw<any[]>`
        SELECT has_table_privilege('inovasix_auth_definer', 'public.messages', 'SELECT') AS whole_table,
               has_table_privilege('inovasix_auth_definer', 'public.messages', 'INSERT') AS can_insert,
               has_table_privilege('inovasix_auth_definer', 'public.messages', 'UPDATE') AS can_update,
               has_table_privilege('inovasix_auth_definer', 'public.messages', 'DELETE') AS can_delete,
               has_column_privilege('inovasix_auth_definer', 'public.messages', 'body', 'SELECT') AS body,
               has_column_privilege('inovasix_auth_definer', 'public.messages', 'external_id', 'SELECT') AS external_id,
               has_column_privilege('inovasix_auth_definer', 'public.messages', 'conversation_id', 'SELECT') AS conversation_id,
               has_table_privilege('inovasix_auth_definer', 'public.contacts', 'SELECT') AS contacts,
               has_table_privilege('inovasix_auth_definer', 'public.conversations', 'SELECT') AS conversations`;
      expect(Object.values(privileges).every((v) => v === false)).toBe(true);
    });

    it('finds tenants across RLS with no tenant context, where a plain query sees nothing', async () => {
      await seedDeliverable(tenantA);
      await seedDeliverable(tenantB);

      // RLS fails closed with no tenant context: zero rows, or an error on a pooled connection whose
      // setting was left empty by an earlier transaction. Either way, no data.
      const visible = await appPrisma
        .$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM messages`
        .then((rows) => rows[0].n)
        .catch(() => 0);
      expect(visible).toBe(0);

      const found = (await repo.discoverTenants(500, null)).filter((t) => mine.has(t));
      expect(found.sort()).toEqual([tenantA, tenantB].sort());
    });

    it('returns only tenant ids (uuid strings), not message data', async () => {
      await seedDeliverable(tenantA, { body: BODY });

      const raw = await appPrisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM public.outbound_tenants_with_due_messages(500, NULL)`;

      expect(JSON.stringify(raw)).not.toContain(BODY);
      for (const record of raw) {
        expect(Object.keys(record)).toHaveLength(1);
        expect(Object.values(record)[0]).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('lists only tenants with something DUE: not future, not leased, not terminal, not inbound, not unqueued', async () => {
      const future = new Date(Date.now() + 3_600_000);
      const held = { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 3_600_000) };
      const notDue = [
        { nextAttemptAt: future },
        { ...held, deliveryAttempts: 1 },
        { nextAttemptAt: null },
        { status: MessageStatus.SENT, nextAttemptAt: null },
        { status: MessageStatus.DELIVERED, nextAttemptAt: null },
        { status: MessageStatus.READ, nextAttemptAt: null },
        { status: MessageStatus.FAILED, nextAttemptAt: null },
        { direction: MessageDirection.INBOUND, status: MessageStatus.DELIVERED, senderType: MessageSenderType.CUSTOMER, nextAttemptAt: null },
      ];
      for (const over of notDue) await seedDeliverable(tenantA, over);

      expect((await repo.discoverTenants(500, null)).filter((t) => mine.has(t))).toEqual([]);

      await seedDeliverable(tenantB);
      expect((await repo.discoverTenants(500, null)).filter((t) => mine.has(t))).toEqual([tenantB]);
    });

    it('includes a tenant whose lease EXPIRED: that is how a stuck message is found again', async () => {
      await seedDeliverable(tenantA, { deliveryAttempts: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) });

      expect((await repo.discoverTenants(500, null)).filter((t) => mine.has(t))).toEqual([tenantA]);
    });

    it('pages with a keyset cursor in tenant_id order, so no tenant is starved', async () => {
      for (const t of [tenantA, tenantB, tenantC]) await seedDeliverable(t);
      const expected = [tenantA, tenantB, tenantC].sort();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 1_000; guard++) {
        const page = await repo.discoverTenants(1, cursor);
        if (page.length === 0) break;
        expect(cursor === null || page[0] > cursor).toBe(true); // strictly ascending
        if (mine.has(page[0])) seen.push(page[0]);
        cursor = page[0];
      }

      expect(seen).toEqual(expected);
    });

    it('a bogus limit is clamped, never an error or an unbounded scan', async () => {
      await expect(repo.discoverTenants(0, null)).resolves.toBeInstanceOf(Array);
      await expect(repo.discoverTenants(-5, null)).resolves.toBeInstanceOf(Array);
      expect((await repo.discoverTenants(10_000_000, null)).length).toBeLessThanOrEqual(500);
    });
  });

  // ---------------------------------------------------------------------------
  describe('claim and lease', () => {
    it('claims a due message: lease token + expiry, attempt counted, everything the adapter needs, still PENDING', async () => {
      const { id, conversationId, identity } = await seedDeliverable(tenantA, {}, { externalConversationId: 'thread-7' });

      const { claimed, exhausted } = await repo.claim(tenantA, opts({ leaseMs: 90_000 }));

      expect(exhausted).toEqual([]);
      expect(claimed).toEqual([
        {
          id,
          tenantId: tenantA,
          conversationId,
          channel: 'WHATSAPP',
          body: BODY,
          attempt: 1,
          leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
          externalConversationId: 'thread-7',
          recipientExternalId: identity,
        },
      ]);
      const after = await row(tenantA, id);
      expect(after).toMatchObject({ status: 'PENDING', deliveryAttempts: 1, leaseToken: claimed[0].leaseToken });
      expect(after.lastAttemptAt).toBeInstanceOf(Date);
      expect(after.nextAttemptAt).not.toBeNull(); // still queued: the claim only leases
      const leaseSeconds = await secondsFromNow(tenantA, id, 'lease_expires_at');
      expect(leaseSeconds).toBeGreaterThan(85);
      expect(leaseSeconds).toBeLessThanOrEqual(90);
    });

    it('does not hand a leased message to a second claim while the lease is valid', async () => {
      const { id } = await seedDeliverable();

      const first = await repo.claim(tenantA, opts());
      const second = await repo.claim(tenantA, opts());

      expect(first.claimed).toHaveLength(1);
      expect(second.claimed).toHaveLength(0);
      expect((await row(tenantA, id)).deliveryAttempts).toBe(1);
    });

    it('picks the recipient identity of the conversation channel (most recent one), or null when the contact has none', async () => {
      const withTwo = await seedConversation(tenantA, { identity: 'old-id' });
      await owner(tenantA, async (tx) => {
        const { contactId } = await tx.conversation.findUniqueOrThrow({ where: { id: withTwo.conversationId } });
        await tx.contactChannelIdentity.create({ data: { tenantId: tenantA, contactId, channel: 'WHATSAPP', externalContactId: 'new-id', createdAt: new Date(Date.now() + 5_000) } });
        await tx.contactChannelIdentity.create({ data: { tenantId: tenantA, contactId, channel: 'WEBCHAT', externalContactId: 'other-channel-id', createdAt: new Date(Date.now() + 9_000) } });
      });
      await seedMessage(tenantA, withTwo.conversationId);
      const none = await seedConversation(tenantA, { identity: null });
      await seedMessage(tenantA, none.conversationId);

      const { claimed } = await repo.claim(tenantA, opts());

      const byConversation = new Map(claimed.map((c) => [c.conversationId, c.recipientExternalId]));
      expect(byConversation.get(withTwo.conversationId)).toBe('new-id');
      expect(byConversation.get(none.conversationId)).toBeNull();
    });

    it('respects the batch size and takes the oldest due messages first', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { id } = await seedDeliverable(tenantA, { nextAttemptAt: new Date(Date.now() - 60_000 + i * 1_000) });
        ids.push(id);
      }

      const { claimed } = await repo.claim(tenantA, opts({ batchSize: 3 }));

      expect(claimed.map((c) => c.id).sort()).toEqual(ids.slice(0, 3).sort());
      expect((await repo.claim(tenantA, opts({ batchSize: 3 }))).claimed.map((c) => c.id).sort()).toEqual(ids.slice(3).sort());
    });

    describe('what is never claimed', () => {
      const untouchedAfterClaim = async (id: string, tenantId = tenantA, channels: ClaimOptions['channels'] = ALL_CHANNELS) => {
        const before = await row(tenantId, id);
        const { claimed, exhausted } = await repo.claim(tenantId, opts({ channels }));
        expect(claimed).toEqual([]);
        expect(exhausted).toEqual([]);
        expect(await row(tenantId, id)).toEqual(before);
      };

      it('E) a SENT message', async () => untouchedAfterClaim((await seedDeliverable(tenantA, { status: MessageStatus.SENT, nextAttemptAt: null, externalId: 'x-1' })).id));
      it('F) a DELIVERED message', async () => untouchedAfterClaim((await seedDeliverable(tenantA, { status: MessageStatus.DELIVERED, nextAttemptAt: null, externalId: 'x-2' })).id));
      it('a READ message', async () => untouchedAfterClaim((await seedDeliverable(tenantA, { status: MessageStatus.READ, nextAttemptAt: null })).id));
      it('G) a FAILED message (a permanent failure stays failed)', async () => untouchedAfterClaim((await seedDeliverable(tenantA, { status: MessageStatus.FAILED, nextAttemptAt: null, deliveryAttempts: 5 })).id));
      it('an INBOUND message', async () =>
        untouchedAfterClaim((await seedDeliverable(tenantA, { direction: MessageDirection.INBOUND, status: MessageStatus.DELIVERED, senderType: MessageSenderType.CUSTOMER, nextAttemptAt: null })).id));
      it('a message not queued yet (next_attempt_at NULL)', async () => untouchedAfterClaim((await seedDeliverable(tenantA, { nextAttemptAt: null })).id));
      it('a message whose time has not come (backoff)', async () => untouchedAfterClaim((await seedDeliverable(tenantA, { nextAttemptAt: new Date(Date.now() + 300_000) })).id));
      it('a message on a channel without an adapter', async () => untouchedAfterClaim((await seedDeliverable(tenantA, {}, { channel: 'INSTAGRAM' })).id, tenantA, [ConversationChannel.WHATSAPP]));
      it('everything, when no adapter is registered at all', async () => untouchedAfterClaim((await seedDeliverable(tenantA)).id, tenantA, []));

      it('a MANUAL conversation message, even if something wrongly queued it', async () => {
        const { id } = await seedDeliverable(tenantA, {}, { channel: 'MANUAL' });
        // even a caller that (wrongly) asked for MANUAL cannot get it: the SQL excludes it on its own
        await untouchedAfterClaim(id, tenantA, [ConversationChannel.MANUAL, ...ALL_CHANNELS]);
      });
    });

    it('recovers a message whose lease EXPIRED: claimed again with a new token and the attempt counted', async () => {
      const { id } = await seedDeliverable();
      const first = (await repo.claim(tenantA, opts())).claimed[0];
      await expireLease(tenantA, id);

      const second = (await repo.claim(tenantA, opts())).claimed[0];

      expect(second.id).toBe(id);
      expect(second.attempt).toBe(2);
      expect(second.leaseToken).not.toBe(first.leaseToken);
      expect((await row(tenantA, id)).leaseToken).toBe(second.leaseToken);
    });

    describe('when the attempts ran out', () => {
      it('an expired lease on the LAST attempt: FAILED (LEASE_EXPIRED) by the claim, never sent again', async () => {
        const { id, conversationId } = await seedDeliverable(tenantA, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) });

        const result = await repo.claim(tenantA, opts());

        expect(result.claimed).toEqual([]);
        expect(result.exhausted).toEqual([{ id, conversationId, attempt: OUTBOUND_MAX_ATTEMPTS, code: 'LEASE_EXPIRED' }]);
        expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, lastErrorCode: 'LEASE_EXPIRED', deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });
      });

      it('no attempts left and no lease: FAILED (ATTEMPTS_EXHAUSTED)', async () => {
        const { id } = await seedDeliverable(tenantA, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });

        const result = await repo.claim(tenantA, opts());

        expect(result.claimed).toEqual([]);
        expect(result.exhausted.map((e) => [e.id, e.code])).toEqual([[id, 'ATTEMPTS_EXHAUSTED']]);
        expect((await row(tenantA, id)).status).toBe('FAILED');
      });

      it('the last attempt that is STILL in flight (lease valid) is left alone', async () => {
        const { id } = await seedDeliverable(tenantA, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
        const before = await row(tenantA, id);

        const result = await repo.claim(tenantA, opts());

        expect(result).toEqual({ claimed: [], exhausted: [] });
        expect(await row(tenantA, id)).toEqual(before);
      });

      it('makes no loop: FAILED stays FAILED across any number of further claims and worker cycles, and the adapter is never called', async () => {
        const { id } = await seedDeliverable(tenantA, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) });
        const adapter = makeAdapter();
        const dispatcher = makeDispatcher([adapter]);

        for (let i = 0; i < 5; i++) await dispatcher.dispatchTenant(tenantA);

        expect(adapter.calls).toHaveLength(0);
        expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'LEASE_EXPIRED', nextAttemptAt: null });
        expect((await repo.discoverTenants(500, null)).filter((t) => mine.has(t))).toEqual([]);
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('finalization (compare-and-set on the lease token)', () => {
    async function claimOne() {
      const seeded = await seedDeliverable();
      const claimed = (await repo.claim(tenantA, opts())).claimed[0];
      return { ...seeded, token: claimed.leaseToken };
    }

    it('markSent: SENT + externalId, and every queue field cleared', async () => {
      const { id, token } = await claimOne();

      await expect(repo.markSent(tenantA, id, token, 'wamid.OK')).resolves.toBe('sent');

      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', externalId: 'wamid.OK', nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, lastErrorCode: null, deliveryAttempts: 1 });
    });

    it('a wrong token changes nothing (lease_lost)', async () => {
      const { id } = await claimOne();
      const before = await row(tenantA, id);

      await expect(repo.markSent(tenantA, id, randomUUID(), 'wamid.X')).resolves.toBe('lease_lost');
      await expect(repo.markRetry(tenantA, id, randomUUID(), 'X', 1000)).resolves.toBe('lease_lost');
      await expect(repo.markFailed(tenantA, id, randomUUID(), 'X')).resolves.toBe('lease_lost');

      expect(await row(tenantA, id)).toEqual(before);
    });

    it('a message that is no longer PENDING cannot be finalized again (a second SENT, or a FAILED over a SENT)', async () => {
      const { id, token } = await claimOne();
      await repo.markSent(tenantA, id, token, 'wamid.1');

      await expect(repo.markSent(tenantA, id, token, 'wamid.2')).resolves.toBe('lease_lost');
      await expect(repo.markFailed(tenantA, id, token, 'LATE')).resolves.toBe('lease_lost');
      await expect(repo.markRetry(tenantA, id, token, 'LATE', 1000)).resolves.toBe('lease_lost');

      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', externalId: 'wamid.1' });
    });

    it('markRetry: back to the queue after the delay (DB clock), lease released, code kept, not claimable until then', async () => {
      const { id, token } = await claimOne();

      await expect(repo.markRetry(tenantA, id, token, 'RATE_LIMITED', 300_000)).resolves.toBe('done');

      expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', leaseToken: null, leaseExpiresAt: null, lastErrorCode: 'RATE_LIMITED', deliveryAttempts: 1 });
      const wait = await secondsFromNow(tenantA, id, 'next_attempt_at');
      expect(wait).toBeGreaterThan(295);
      expect(wait).toBeLessThanOrEqual(300);
      expect((await repo.claim(tenantA, opts())).claimed).toEqual([]);

      await makeDue(tenantA, id);
      const again = (await repo.claim(tenantA, opts())).claimed[0];
      expect(again).toMatchObject({ id, attempt: 2 });
    });

    it('markFailed: FAILED, out of the queue for good', async () => {
      const { id, token } = await claimOne();

      await expect(repo.markFailed(tenantA, id, token, 'RECIPIENT_BLOCKED')).resolves.toBe('done');

      expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', nextAttemptAt: null, leaseToken: null, lastErrorCode: 'RECIPIENT_BLOCKED' });
      await makeDue(tenantA, id).catch(() => undefined); // the CHECK forbids re-queueing a FAILED row
      expect((await repo.claim(tenantA, opts())).claimed).toEqual([]);
    });

    describe('externalId is never silently overwritten', () => {
      it('the same id that is already there is fine', async () => {
        const seeded = await seedDeliverable(tenantA, { externalId: 'wamid.SAME' });
        const claimed = (await repo.claim(tenantA, opts())).claimed[0];

        await expect(repo.markSent(tenantA, seeded.id, claimed.leaseToken, 'wamid.SAME')).resolves.toBe('sent');

        expect(await row(tenantA, seeded.id)).toMatchObject({ status: 'SENT', externalId: 'wamid.SAME', lastErrorCode: null });
      });

      it('a DIFFERENT pre-existing id is kept: the message is SENT (the provider accepted it) and the conflict is recorded', async () => {
        const seeded = await seedDeliverable(tenantA, { externalId: 'wamid.ORIGINAL' });
        const claimed = (await repo.claim(tenantA, opts())).claimed[0];

        await expect(repo.markSent(tenantA, seeded.id, claimed.leaseToken, 'wamid.NEW')).resolves.toBe('sent_external_id_conflict');

        expect(await row(tenantA, seeded.id)).toMatchObject({ status: 'SENT', externalId: 'wamid.ORIGINAL', lastErrorCode: 'EXTERNAL_ID_CONFLICT', nextAttemptAt: null, leaseToken: null });
      });

      it('an id already used by ANOTHER message of the tenant (unique index) does not fail the send nor touch the other message', async () => {
        const other = await seedDeliverable(tenantA, { status: MessageStatus.SENT, nextAttemptAt: null, externalId: 'wamid.TAKEN' });
        const seeded = await seedDeliverable(tenantA);
        const claimed = (await repo.claim(tenantA, opts())).claimed[0];

        await expect(repo.markSent(tenantA, seeded.id, claimed.leaseToken, 'wamid.TAKEN')).resolves.toBe('sent_external_id_conflict');

        expect(await row(tenantA, seeded.id)).toMatchObject({ status: 'SENT', externalId: null, lastErrorCode: 'EXTERNAL_ID_CONFLICT' });
        expect(await row(tenantA, other.id)).toMatchObject({ status: 'SENT', externalId: 'wamid.TAKEN', lastErrorCode: null });
      });

      it('the same provider id in ANOTHER tenant is not a conflict (uniqueness is per tenant)', async () => {
        await seedDeliverable(tenantB, { status: MessageStatus.SENT, nextAttemptAt: null, externalId: 'wamid.SHARED' });
        const seeded = await seedDeliverable(tenantA);
        const claimed = (await repo.claim(tenantA, opts())).claimed[0];

        await expect(repo.markSent(tenantA, seeded.id, claimed.leaseToken, 'wamid.SHARED')).resolves.toBe('sent');
      });

      it('through the dispatcher: the conflict is still SENT and is logged as an error', async () => {
        captureLogs();
        const seeded = await seedDeliverable(tenantA, { externalId: 'wamid.ORIGINAL' });
        const adapter = makeAdapter(ConversationChannel.WHATSAPP).enqueue({ kind: 'ok', externalMessageId: 'wamid.NEW' });

        const summary = await makeDispatcher([adapter]).dispatchTenant(tenantA);

        expect(summary.sent).toBe(1);
        expect(events('outbound.external_id_conflict')).toHaveLength(1);
        expect(await row(tenantA, seeded.id)).toMatchObject({ status: 'SENT', externalId: 'wamid.ORIGINAL' });
      });
    });

    it('a worker whose lease expired and was re-claimed can no longer finalize: the new holder wins (and the customer may have it twice)', async () => {
      const { id, token: staleToken } = await claimOne();
      await expireLease(tenantA, id);
      const fresh = (await repo.claim(tenantA, opts())).claimed[0];
      await repo.markSent(tenantA, id, fresh.leaseToken, 'wamid.FRESH');

      await expect(repo.markSent(tenantA, id, staleToken, 'wamid.STALE')).resolves.toBe('lease_lost');
      await expect(repo.markRetry(tenantA, id, staleToken, 'STALE', 1_000)).resolves.toBe('lease_lost');
      await expect(repo.markFailed(tenantA, id, staleToken, 'STALE')).resolves.toBe('lease_lost');

      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', externalId: 'wamid.FRESH', deliveryAttempts: 2, lastErrorCode: null });
    });
  });

  // ---------------------------------------------------------------------------
  describe('multi-tenant isolation (RLS)', () => {
    it('D) a claim for tenant A never touches tenant B, and each tenant gets only its own messages', async () => {
      const a = await seedDeliverable(tenantA);
      const b = await seedDeliverable(tenantB);
      const beforeB = await row(tenantB, b.id);

      const claimedA = await repo.claim(tenantA, opts());

      expect(claimedA.claimed.map((c) => c.id)).toEqual([a.id]);
      expect(await row(tenantB, b.id)).toEqual(beforeB);
      const claimedB = await repo.claim(tenantB, opts());
      expect(claimedB.claimed.map((c) => [c.id, c.tenantId])).toEqual([[b.id, tenantB]]);
    });

    it('finalizing with the other tenant as context changes nothing, even with the right message id and token', async () => {
      const b = await seedDeliverable(tenantB);
      const tokenB = (await repo.claim(tenantB, opts())).claimed[0].leaseToken;
      const before = await row(tenantB, b.id);

      await expect(repo.markSent(tenantA, b.id, tokenB, 'wamid.CROSS')).resolves.toBe('lease_lost');
      await expect(repo.markFailed(tenantA, b.id, tokenB, 'CROSS')).resolves.toBe('lease_lost');
      await expect(repo.markRetry(tenantA, b.id, tokenB, 'CROSS', 1)).resolves.toBe('lease_lost');

      expect(await row(tenantB, b.id)).toEqual(before);
    });

    it('RLS itself refuses it: with tenant A set, an UPDATE aimed at a tenant B row touches 0 rows', async () => {
      const b = await seedDeliverable(tenantB);

      const updated = await runWithTenant(appPrisma, tenantA, (tx) => tx.$executeRaw`UPDATE messages SET status = 'FAILED', next_attempt_at = NULL WHERE id = ${b.id}::uuid`);

      expect(updated).toBe(0);
      expect((await row(tenantB, b.id)).status).toBe('PENDING');
    });

    it('the exhausted-attempts sweep is per tenant too', async () => {
      const a = await seedDeliverable(tenantA, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });
      const b = await seedDeliverable(tenantB, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });

      await repo.claim(tenantA, opts());

      expect((await row(tenantA, a.id)).status).toBe('FAILED');
      expect((await row(tenantB, b.id)).status).toBe('PENDING');
    });

    it('through the dispatcher: the adapter only ever receives the tenant/conversation of the message being sent', async () => {
      const adapter = makeAdapter();
      const a = await seedDeliverable(tenantA);
      const b = await seedDeliverable(tenantB);

      await makeDispatcher([adapter]).dispatchTenant(tenantA);
      await makeDispatcher([adapter]).dispatchTenant(tenantB);

      expect(adapter.calls.map((c) => [c.idempotencyKey, c.tenantId, c.conversationId]).sort()).toEqual(
        [
          [a.id, tenantA, a.conversationId],
          [b.id, tenantB, b.conversationId],
        ].sort(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe('concurrency: the claim lets only one worker have a message', () => {
    it('SKIP LOCKED, deterministically: a claim never waits on a row another transaction holds, and takes it once it is free', async () => {
      const { id } = await seedDeliverable();
      let releaseLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
      let lockAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
      const holder = owner(tenantA, async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM messages WHERE id = '${id}'::uuid FOR UPDATE`);
        lockAcquired();
        await lockHeld;
      });
      await acquired;
      // Safety net only: if SKIP LOCKED were missing the claim would wait on this row, so the
      // lock is let go after a while and the elapsed-time assertion below fails instead of hanging.
      const safetyNet = setTimeout(releaseLock, 4_000);

      const started = Date.now();
      const whileLocked = await repo.claim(tenantA, opts());
      const elapsed = Date.now() - started;
      clearTimeout(safetyNet);
      releaseLock();
      await holder;

      expect(whileLocked.claimed).toEqual([]); // skipped, did not block
      expect(elapsed).toBeLessThan(3_000);
      expect((await repo.claim(tenantA, opts())).claimed.map((c) => c.id)).toEqual([id]);
    });

    it.each([2, 8])('%i dispatchers on ONE message: exactly one claims it and the adapter is called exactly once', async (workers) => {
      const { id } = await seedDeliverable();
      const adapter = makeAdapter();
      const shared = contended(workers);

      const summaries = await Promise.all(Array.from({ length: workers }, () => makeDispatcher([adapter], shared).dispatchTenant(tenantA)));

      expect(summaries.filter((s) => s.claimed === 1)).toHaveLength(1);
      expect(summaries.reduce((n, s) => n + s.claimed, 0)).toBe(1);
      expect(adapter.calls).toHaveLength(1);
      expect(adapter.accepted).toHaveLength(1);
      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', deliveryAttempts: 1, externalId: adapter.accepted[0].externalMessageId });
    });

    it.each([2, 8])('%i raw claims on ONE message: exactly one gets a lease (no dispatcher involved)', async (workers) => {
      const { id } = await seedDeliverable();
      const shared = contended(workers);

      const results = await Promise.all(Array.from({ length: workers }, () => shared.claim(tenantA, opts())));

      const winners = results.flatMap((r) => r.claimed);
      expect(winners.map((w) => w.id)).toEqual([id]);
      expect((await row(tenantA, id)).deliveryAttempts).toBe(1);
    });

    it('8 dispatchers race for a message whose lease EXPIRED: exactly one recovers it and the adapter is called once', async () => {
      const { id } = await seedDeliverable(tenantA, { deliveryAttempts: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1_000) });
      const adapter = makeAdapter();
      const shared = contended(8);

      await Promise.all(Array.from({ length: 8 }, () => makeDispatcher([adapter], shared).dispatchTenant(tenantA)));

      expect(adapter.calls).toHaveLength(1);
      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', deliveryAttempts: 2 });
    });

    it('C) 100 messages, 6 workers: every message is sent exactly once, and never by two workers at the same time', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add((await seedDeliverable()).id);

      const inFlight = new Map<string, number>();
      let overlaps = 0;
      const adapter = makeAdapter(ConversationChannel.WHATSAPP, {
        gate: async (input: { idempotencyKey: string }) => {
          const n = (inFlight.get(input.idempotencyKey) ?? 0) + 1;
          inFlight.set(input.idempotencyKey, n);
          if (n > 1) overlaps++;
          await sleep(4);
          inFlight.set(input.idempotencyKey, (inFlight.get(input.idempotencyKey) ?? 1) - 1);
        },
      });
      settings.batchSize = 7;
      const remaining = () => owner<number>(tenantA, async (tx) => (await tx.message.count({ where: { tenantId: tenantA, status: 'PENDING' } })) as number);
      const worker = async () => {
        const dispatcher = makeDispatcher([adapter]);
        for (let guard = 0; guard < 2_000 && (await remaining()) > 0; guard++) {
          const summary = await dispatcher.dispatchTenant(tenantA);
          if (summary.claimed === 0) await sleep(5);
        }
      };

      await Promise.all(Array.from({ length: 6 }, worker));

      expect(overlaps).toBe(0);
      expect(adapter.calls).toHaveLength(100);
      expect(new Set(adapter.calls.map((c) => c.idempotencyKey))).toEqual(ids);
      expect(adapter.accepted).toHaveLength(100);
      const rows = await messagesOf(tenantA);
      expect(rows.every((m) => m.status === 'SENT' && m.deliveryAttempts === 1 && m.externalId && m.leaseToken === null && m.nextAttemptAt === null)).toBe(true);
      expect(new Set(rows.map((m) => m.externalId)).size).toBe(100);
    });

    it('D) two tenants processed by concurrent workers at once stay isolated', async () => {
      const own = new Map<string, string>();
      for (let i = 0; i < 20; i++) {
        own.set((await seedDeliverable(tenantA)).id, tenantA);
        own.set((await seedDeliverable(tenantB)).id, tenantB);
      }
      const adapter = makeAdapter();
      const run = async (tenantId: string) => {
        const dispatcher = makeDispatcher([adapter]);
        for (let guard = 0; guard < 200; guard++) if ((await dispatcher.dispatchTenant(tenantId)).claimed === 0) break;
      };

      await Promise.all([run(tenantA), run(tenantB), run(tenantA), run(tenantB)]);

      expect(adapter.calls).toHaveLength(40);
      for (const call of adapter.calls) expect(call.tenantId).toBe(own.get(call.idempotencyKey));
      expect((await messagesOf(tenantA)).every((m) => m.status === 'SENT')).toBe(true);
      expect((await messagesOf(tenantB)).every((m) => m.status === 'SENT')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('delivery through the dispatcher', () => {
    it('sends: PENDING -> SENT with the provider id; the adapter got a provider-neutral request with the message id as idempotency key', async () => {
      const { id, conversationId, identity } = await seedDeliverable(tenantA, {}, { externalConversationId: 'thread-1' });
      const adapter = makeAdapter();

      const summary = await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
      expect(adapter.calls).toEqual([
        { idempotencyKey: id, tenantId: tenantA, conversationId, channel: 'WHATSAPP', recipient: { externalContactId: identity, externalConversationId: 'thread-1' }, body: BODY },
      ]);
      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', externalId: adapter.accepted[0].externalMessageId, deliveryAttempts: 1, nextAttemptAt: null, leaseToken: null });
    });

    it('never marks DELIVERED: an accepted message is SENT and stays SENT', async () => {
      const { id } = await seedDeliverable();

      await makeDispatcher([makeAdapter()]).dispatchTenant(tenantA);
      await makeDispatcher([makeAdapter()]).dispatchTenant(tenantA);

      expect((await row(tenantA, id)).status).toBe('SENT');
    });

    it.each([ConversationChannel.WHATSAPP, ConversationChannel.INSTAGRAM, ConversationChannel.FACEBOOK, ConversationChannel.WEBCHAT])('routes a %s message to the %s adapter only', async (channel) => {
      const adapters = ALL_CHANNELS.map((c) => makeAdapter(c));
      const { id } = await seedDeliverable(tenantA, {}, { channel });

      await makeDispatcher(adapters).dispatchTenant(tenantA);

      for (const adapter of adapters) expect(adapter.calls.map((c) => c.idempotencyKey)).toEqual(adapter.channel === channel ? [id] : []);
    });

    it('does not care who wrote it: an AGENT message and a SYSTEM message take exactly the same path', async () => {
      const system = await seedDeliverable(tenantA, { senderType: MessageSenderType.SYSTEM });
      const agent = await seedDeliverable(tenantA, { senderType: MessageSenderType.AGENT });
      const adapter = makeAdapter();

      await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(adapter.calls.map((c) => c.idempotencyKey).sort()).toEqual([system.id, agent.id].sort());
      for (const id of [system.id, agent.id]) expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', deliveryAttempts: 1 });
      expect((await row(tenantA, system.id)).senderType).toBe('SYSTEM');
      expect((await row(tenantA, agent.id)).senderType).toBe('AGENT');
    });

    describe('retry and backoff (persisted, not in memory)', () => {
      it('walks the whole policy: 4 temporary failures back off 1 min / 5 min / 15 min / 1 h (+/-20%), the 5th ends in FAILED', async () => {
        const { id } = await seedDeliverable();
        const adapter = makeAdapter(ConversationChannel.WHATSAPP, { defaultBehavior: { kind: 'temporary', code: 'UPSTREAM_5XX' } });
        const dispatcher = makeDispatcher([adapter]);
        dispatcher.random = Math.random; // real jitter

        for (let attempt = 1; attempt <= 4; attempt++) {
          const summary = await dispatcher.dispatchTenant(tenantA);
          expect(summary).toMatchObject({ claimed: 1, retried: 1, failed: 0 });

          const state = await row(tenantA, id);
          expect(state).toMatchObject({ status: 'PENDING', deliveryAttempts: attempt, leaseToken: null, lastErrorCode: 'UPSTREAM_5XX' });
          const wait = await secondsFromNow(tenantA, id, 'next_attempt_at');
          const base = OUTBOUND_BACKOFF_MS[attempt - 1] / 1000;
          expect(wait).toBeGreaterThan(base * 0.8 - 5);
          expect(wait).toBeLessThanOrEqual(base * 1.2);

          // not due yet: nothing happens, however many times we poll
          expect((await dispatcher.dispatchTenant(tenantA)).claimed).toBe(0);
          await makeDue(tenantA, id);
        }

        const last = await dispatcher.dispatchTenant(tenantA);
        expect(last).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
        expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', deliveryAttempts: 5, nextAttemptAt: null, leaseToken: null, lastErrorCode: 'UPSTREAM_5XX' });
        expect(adapter.calls).toHaveLength(OUTBOUND_MAX_ATTEMPTS);
        // and nothing brings it back
        for (let i = 0; i < 3; i++) await dispatcher.dispatchTenant(tenantA);
        expect(adapter.calls).toHaveLength(OUTBOUND_MAX_ATTEMPTS);
      });

      it('a retry can still succeed: temporary, temporary, then SENT with the id', async () => {
        const { id } = await seedDeliverable();
        const adapter = makeAdapter().enqueue({ kind: 'temporary' }, { kind: 'temporary' }, { kind: 'ok', externalMessageId: 'wamid.LATE' });
        const dispatcher = makeDispatcher([adapter]);

        await dispatcher.dispatchTenant(tenantA);
        await makeDue(tenantA, id);
        await dispatcher.dispatchTenant(tenantA);
        await makeDue(tenantA, id);
        await dispatcher.dispatchTenant(tenantA);

        expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', externalId: 'wamid.LATE', deliveryAttempts: 3, lastErrorCode: null, nextAttemptAt: null });
      });

      it('a permanent failure is FAILED on the first attempt and never retried', async () => {
        const { id } = await seedDeliverable();
        const adapter = makeAdapter().enqueue({ kind: 'permanent', code: 'RECIPIENT_BLOCKED' });
        const dispatcher = makeDispatcher([adapter]);

        await dispatcher.dispatchTenant(tenantA);
        for (let i = 0; i < 3; i++) await dispatcher.dispatchTenant(tenantA);

        expect(adapter.calls).toHaveLength(1);
        expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', deliveryAttempts: 1, lastErrorCode: 'RECIPIENT_BLOCKED', nextAttemptAt: null });
      });

      it('a hung provider is a TIMEOUT (temporary): the message goes back to the queue', async () => {
        settings.sendTimeoutMs = 60;
        const { id } = await seedDeliverable();
        const adapter = makeAdapter().enqueue({ kind: 'hang' });

        const summary = await makeDispatcher([adapter]).dispatchTenant(tenantA);

        expect(summary.retried).toBe(1);
        expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', lastErrorCode: 'TIMEOUT', leaseToken: null, deliveryAttempts: 1 });
      });

      it('an unclassified provider error is ADAPTER_ERROR (temporary) and its text is not stored', async () => {
        const { id } = await seedDeliverable();
        const adapter = makeAdapter().enqueue({ kind: 'throw', message: 'secret token=abc123 for 5511999990000' });

        await makeDispatcher([adapter]).dispatchTenant(tenantA);

        const state = await row(tenantA, id);
        expect(state.lastErrorCode).toBe('ADAPTER_ERROR');
        expect(JSON.stringify(state)).not.toMatch(/abc123|5511999990000/);
      });

      it('a contact with no identity on the channel is FAILED (NO_RECIPIENT) without calling the provider', async () => {
        const { id } = await seedDeliverable(tenantA, {}, { identity: null });
        const adapter = makeAdapter();

        await makeDispatcher([adapter]).dispatchTenant(tenantA);

        expect(adapter.calls).toHaveLength(0);
        expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'NO_RECIPIENT' });
      });

      it('a message with no body is FAILED (EMPTY_BODY) without calling the provider', async () => {
        const { id } = await seedDeliverable(tenantA, { body: null });
        const adapter = makeAdapter();

        await makeDispatcher([adapter]).dispatchTenant(tenantA);

        expect(adapter.calls).toHaveLength(0);
        expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'EMPTY_BODY' });
      });
    });

    describe('MANUAL and a missing adapter', () => {
      it('MANUAL is never sent: a human message in a MANUAL conversation is SENT at once, not queued, and no adapter is ever called', async () => {
        const manual = await seedConversation(tenantA, { channel: 'MANUAL', identity: null });
        const adapters = [...ALL_CHANNELS.map((c) => makeAdapter(c))];

        const message = await messagesService.send(ctxA, manual.conversationId, { body: 'Nota interna' });
        await makeDispatcher(adapters).dispatchTenant(tenantA);

        expect(message.status).toBe('SENT');
        expect(await row(tenantA, message.id)).toMatchObject({ status: 'SENT', nextAttemptAt: null, deliveryAttempts: 0, leaseToken: null });
        for (const adapter of adapters) expect(adapter.calls).toHaveLength(0);
      });

      it('a MANUAL message someone queued by mistake is still never delivered, and no adapter can be registered for MANUAL', async () => {
        const { id } = await seedDeliverable(tenantA, {}, { channel: 'MANUAL' });
        const adapter = makeAdapter();

        for (let i = 0; i < 3; i++) await makeDispatcher([adapter]).dispatchTenant(tenantA);

        expect(adapter.calls).toHaveLength(0);
        expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', deliveryAttempts: 0, leaseToken: null });
        expect(() => new OutboundAdapterRegistry([makeAdapter(ConversationChannel.MANUAL)])).toThrow(/MANUAL/);
      });

      it('no adapter for the channel: the message is left PENDING and untouched (not SENT, not deleted, no attempt burnt), reported explicitly, no loop', async () => {
        captureLogs();
        const { id } = await seedDeliverable(tenantA, {}, { channel: 'INSTAGRAM' });
        const before = await row(tenantA, id);
        const whatsapp = makeAdapter(ConversationChannel.WHATSAPP);
        const dispatcher = makeDispatcher([whatsapp]);

        for (let i = 0; i < 25; i++) expect((await dispatcher.dispatchTenant(tenantA)).claimed).toBe(0);

        expect(whatsapp.calls).toHaveLength(0);
        expect(await row(tenantA, id)).toEqual(before);
        expect(events('outbound.no_adapter')).toEqual([{ event: 'outbound.no_adapter', tenantId: tenantA, channel: 'INSTAGRAM', pending: 1 }]); // once, not 25 times
      });

      it('with no adapter at all nothing is claimed for any channel', async () => {
        const ids = [(await seedDeliverable(tenantA)).id, (await seedDeliverable(tenantA, {}, { channel: 'WEBCHAT' })).id];

        await makeDispatcher([]).dispatchTenant(tenantA);

        for (const id of ids) expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', deliveryAttempts: 0, leaseToken: null });
      });

      it('when the adapter shows up later the waiting message is delivered', async () => {
        const { id } = await seedDeliverable(tenantA, {}, { channel: 'INSTAGRAM' });
        await makeDispatcher([]).dispatchTenant(tenantA);
        const instagram = makeAdapter(ConversationChannel.INSTAGRAM);

        await makeDispatcher([instagram]).dispatchTenant(tenantA);

        expect(instagram.calls.map((c) => c.idempotencyKey)).toEqual([id]);
        expect((await row(tenantA, id)).status).toBe('SENT');
      });
    });

    it('a cycle finds the tenants with due messages through the definer function and serves them', async () => {
      const a = await seedDeliverable(tenantA);
      const b = await seedDeliverable(tenantB);
      const adapter = makeAdapter();
      // restrict the cycle to this test's tenants: the database is shared with other data
      const scoped = Object.assign(Object.create(repo) as OutboundDeliveryRepository, {
        discoverTenants: async (limit: number, after: string | null) => (await repo.discoverTenants(limit, after)).filter((t) => mine.has(t)),
      });

      const result = await makeDispatcher([adapter], scoped).dispatchCycle(null);

      expect(result).toMatchObject({ tenants: 2, claimed: 2, sent: 2, nextCursor: null });
      expect((await row(tenantA, a.id)).status).toBe('SENT');
      expect((await row(tenantB, b.id)).status).toBe('SENT');
    });

    it('logs ids, channel, attempt and provider id, and never the body, the recipient or the contact name', async () => {
      captureLogs();
      const ok = await seedDeliverable(tenantA);
      await seedDeliverable(tenantA, {}, { identity: '5511977776666' });
      const adapter = makeAdapter().enqueue({ kind: 'ok', externalMessageId: 'wamid.LOGGED' }, { kind: 'throw', message: `${BODY} 5511977776666` });

      await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(events('outbound.claimed')).toHaveLength(2);
      expect(events('outbound.sent')).toEqual([expect.objectContaining({ tenantId: tenantA, channel: 'WHATSAPP', attempt: 1, externalMessageId: 'wamid.LOGGED' })]);
      expect(events('outbound.retry')).toHaveLength(1);
      expect(events('outbound.sent')[0].messageId).toBe(ok.id);
      const everything = JSON.stringify(logs.map((l) => l.payload));
      for (const secret of [BODY, '5511977776666', 'Cliente Sigiloso']) expect(everything).not.toContain(secret);
    });
  });

  // ---------------------------------------------------------------------------
  describe('crash window: the provider accepted, the process died before SENT was saved', () => {
    it('the lease expires and the message is sent AGAIN: delivery is AT-LEAST-ONCE, not exactly-once', async () => {
      const { id } = await seedDeliverable();
      const adapter = makeAdapter();

      // worker 1: claims (attempt 1) and the provider accepts: the customer HAS the message...
      const claim = (await repo.claim(tenantA, opts())).claimed[0];
      const accepted = await adapter.send({ idempotencyKey: claim.id, tenantId: claim.tenantId, conversationId: claim.conversationId, channel: claim.channel, recipient: { externalContactId: claim.recipientExternalId as string, externalConversationId: null }, body: claim.body as string, signal: new AbortController().signal });
      expect(adapter.accepted).toHaveLength(1);
      // ...and the process dies here, before markSent ever runs: nothing was recorded.
      expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', deliveryAttempts: 1, externalId: null, leaseToken: claim.leaseToken });

      // while the lease is valid nobody touches it (no duplicate yet)
      expect((await makeDispatcher([adapter]).dispatchTenant(tenantA)).claimed).toBe(0);
      expect(adapter.accepted).toHaveLength(1);

      // the lease expires: the message is eligible again, as it must be
      await expireLease(tenantA, id);
      expect((await repo.discoverTenants(500, null)).filter((t) => mine.has(t))).toEqual([tenantA]);
      const summary = await makeDispatcher([adapter]).dispatchTenant(tenantA);

      // the SAME message went out twice: the customer may receive it twice.
      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
      expect(adapter.accepted).toHaveLength(2);
      expect(adapter.accepted.map((a) => a.idempotencyKey)).toEqual([id, id]); // same idempotency key: a provider that honours it can drop the duplicate
      expect(accepted.externalMessageId).not.toBe(adapter.accepted[1].externalMessageId); // the fake does not dedupe; a real provider might
      expect(await row(tenantA, id)).toMatchObject({ status: 'SENT', deliveryAttempts: 2, externalId: adapter.accepted[1].externalMessageId });
    });

    it('a crash on the LAST attempt is bounded: the message ends FAILED (LEASE_EXPIRED) instead of being re-sent forever', async () => {
      const { id } = await seedDeliverable(tenantA, { deliveryAttempts: OUTBOUND_MAX_ATTEMPTS - 1 });
      const adapter = makeAdapter();
      const claim = (await repo.claim(tenantA, opts())).claimed[0];
      expect(claim.attempt).toBe(OUTBOUND_MAX_ATTEMPTS);
      // provider accepted, process died: no finalize
      await expireLease(tenantA, id);

      await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(adapter.calls).toHaveLength(0);
      expect(await row(tenantA, id)).toMatchObject({ status: 'FAILED', lastErrorCode: 'LEASE_EXPIRED', deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });
    });

    it('the same happens when the database refuses the SENT write: no throw, the lease is left to expire, then it is recovered', async () => {
      captureLogs();
      const { id } = await seedDeliverable();
      const adapter = makeAdapter();
      const flaky = Object.assign(Object.create(repo) as OutboundDeliveryRepository, {
        markSent: async () => {
          throw Object.assign(new Error(`connection terminated while writing ${BODY}`), { name: 'PrismaClientKnownRequestError', code: 'P1017' });
        },
      });

      const first = await makeDispatcher([adapter], flaky).dispatchTenant(tenantA);

      expect(first).toMatchObject({ claimed: 1, finalizeErrors: 1, sent: 0 });
      expect(adapter.accepted).toHaveLength(1);
      expect(await row(tenantA, id)).toMatchObject({ status: 'PENDING', deliveryAttempts: 1 });
      expect(events('outbound.finalize_error')).toEqual([expect.objectContaining({ messageId: id, errorName: 'PrismaClientKnownRequestError', code: 'P1017' })]);
      expect(JSON.stringify(logs)).not.toContain(BODY);

      await expireLease(tenantA, id);
      await makeDispatcher([adapter]).dispatchTenant(tenantA);
      expect(adapter.accepted).toHaveLength(2); // at-least-once, again
      expect((await row(tenantA, id)).status).toBe('SENT');
    });
  });

  // ---------------------------------------------------------------------------
  describe('first contact (Stage E) end to end through the engine', () => {
    const inbound = (over: object = {}) => ({ tenantId: tenantA, channel: 'WHATSAPP' as const, externalContactId: 'wa-oi-1', externalMessageId: `m-${randomUUID()}`, content: 'Oi', occurredAt: new Date(), ...over });

    it('"Oi" -> inbound -> automatic reply OUTBOUND/PENDING (queued) -> dispatcher -> fake adapter -> SENT + externalId; conversation stays AGUARDANDO_HUMANO', async () => {
      const result = await intake.receive(inbound());
      expect(result.autoReply.reason).toBe('replied');
      const [inboundMessage, reply] = await messagesOf(tenantA);
      expect(reply).toMatchObject({ direction: 'OUTBOUND', senderType: 'SYSTEM', senderUserId: null, status: 'PENDING', externalId: null, deliveryAttempts: 0 });
      expect(reply.nextAttemptAt).toBeInstanceOf(Date); // the writer queued it
      expect(inboundMessage).toMatchObject({ direction: 'INBOUND', status: 'DELIVERED', nextAttemptAt: null, deliveryAttempts: 0 });

      const adapter = makeAdapter();
      const summary = await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
      expect(adapter.calls).toEqual([expect.objectContaining({ idempotencyKey: reply.id, body: DEFAULT_FIRST_CONTACT_MESSAGE, recipient: { externalContactId: 'wa-oi-1', externalConversationId: null } })]);
      const [inboundAfter, replyAfter] = await messagesOf(tenantA);
      expect(replyAfter).toMatchObject({ status: 'SENT', externalId: adapter.accepted[0].externalMessageId, deliveryAttempts: 1, nextAttemptAt: null, leaseToken: null });
      expect(inboundAfter).toEqual(inboundMessage); // the customer's own message is untouched by delivery
      const conversation = await owner<any>(tenantA, (tx) => tx.conversation.findUniqueOrThrow({ where: { id: result.conversation.id } }));
      expect(conversation).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null });
    });

    it('delivery does not create a second automatic reply, and later inbound messages still get none', async () => {
      await intake.receive(inbound());
      await makeDispatcher([makeAdapter()]).dispatchTenant(tenantA);

      await intake.receive(inbound({ content: 'Alguém aí?' }));
      await makeDispatcher([makeAdapter()]).dispatchTenant(tenantA);

      const replies = await messagesOf(tenantA, { direction: 'OUTBOUND', senderType: 'SYSTEM', senderUserId: null });
      expect(replies).toHaveLength(1);
      expect(replies[0].status).toBe('SENT');
    });

    it('a delivery that keeps failing never re-opens the first-contact claim: still exactly one automatic reply', async () => {
      const first = await intake.receive(inbound());
      const adapter = makeAdapter(ConversationChannel.WHATSAPP, { defaultBehavior: { kind: 'temporary' } });
      const dispatcher = makeDispatcher([adapter]);
      for (let i = 0; i < OUTBOUND_MAX_ATTEMPTS; i++) {
        await dispatcher.dispatchTenant(tenantA);
        const [reply] = await messagesOf(tenantA, { senderType: 'SYSTEM' });
        await makeDue(tenantA, reply.id).catch(() => undefined);
      }

      await intake.receive(inbound({ content: 'Oi de novo' }));

      const replies = await messagesOf(tenantA, { direction: 'OUTBOUND', senderType: 'SYSTEM' });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ status: 'FAILED', deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });
      const conversation = await owner<any>(tenantA, (tx) => tx.conversation.findUniqueOrThrow({ where: { id: first.conversation.id } }));
      expect(conversation.state).toBe('AGUARDANDO_HUMANO');
    });

    it('an automatic reply created BEFORE the engine existed (PENDING, not queued) stays out of the queue: history is not sent', async () => {
      const { conversationId } = await seedConversation(tenantA);
      const historic = await seedMessage(tenantA, conversationId, { senderType: MessageSenderType.SYSTEM, nextAttemptAt: null, body: DEFAULT_FIRST_CONTACT_MESSAGE });
      const adapter = makeAdapter();

      for (let i = 0; i < 3; i++) await makeDispatcher([adapter]).dispatchTenant(tenantA);

      expect(adapter.calls).toHaveLength(0);
      expect((await row(tenantA, historic)).status).toBe('PENDING');
    });
  });

  // ---------------------------------------------------------------------------
  describe('human message through the same engine', () => {
    it('human takes over -> POST message is OUTBOUND/AGENT/PENDING (queued) -> dispatcher -> fake adapter -> SENT', async () => {
      const result = await intake.receive({ tenantId: tenantA, channel: 'WHATSAPP', externalContactId: 'wa-human-1', externalMessageId: `m-${randomUUID()}`, content: 'Oi', occurredAt: new Date() });
      const adapter = makeAdapter();
      const dispatcher = makeDispatcher([adapter]);
      await dispatcher.dispatchTenant(tenantA); // the automatic reply goes first
      await conversationsService.assign(ctxA, result.conversation.id, userA);

      const sent = await messagesService.send(ctxA, result.conversation.id, { body: 'Olá, aqui é a Ana.' });

      expect(sent).toMatchObject({ direction: 'OUTBOUND', senderType: 'AGENT', senderUserId: userA, status: 'PENDING', externalId: null });
      expect(await row(tenantA, sent.id)).toMatchObject({ status: 'PENDING', deliveryAttempts: 0 });
      expect((await row(tenantA, sent.id)).nextAttemptAt).toBeInstanceOf(Date);

      const summary = await dispatcher.dispatchTenant(tenantA);

      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
      expect(adapter.accepted.map((a) => a.body)).toEqual([DEFAULT_FIRST_CONTACT_MESSAGE, 'Olá, aqui é a Ana.']);
      expect(await row(tenantA, sent.id)).toMatchObject({ status: 'SENT', externalId: adapter.accepted[1].externalMessageId, senderType: 'AGENT', deliveryAttempts: 1 });
      const conversation = await owner<any>(tenantA, (tx) => tx.conversation.findUniqueOrThrow({ where: { id: result.conversation.id } }));
      expect(conversation.state).toBe('HUMANO_ATENDENDO');
    });

    it('the Inbox contract holds: the messages list shows both outbound messages with their delivery status, in order', async () => {
      const result = await intake.receive({ tenantId: tenantA, channel: 'WHATSAPP', externalContactId: 'wa-human-2', externalMessageId: `m-${randomUUID()}`, content: 'Oi', occurredAt: new Date() });
      await conversationsService.assign(ctxA, result.conversation.id, userA);
      await messagesService.send(ctxA, result.conversation.id, { body: 'Já te ajudo' });

      const before = await messagesService.list(ctxA, result.conversation.id, {});
      expect(before.items.map((m) => [m.direction, m.senderType, m.status])).toEqual([
        ['INBOUND', 'CUSTOMER', 'DELIVERED'],
        ['OUTBOUND', 'SYSTEM', 'PENDING'],
        ['OUTBOUND', 'AGENT', 'PENDING'],
      ]);

      await makeDispatcher([makeAdapter()]).dispatchTenant(tenantA);

      const after = await messagesService.list(ctxA, result.conversation.id, {});
      expect(after.items.map((m) => m.status)).toEqual(['DELIVERED', 'SENT', 'SENT']);
      expect(after.items[1].externalId).not.toBeNull();
      expect(after.items[2].externalId).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('the worker (real timers, real database)', () => {
    /** A dispatcher restricted to this test's tenants: the database is shared with other data. */
    const scopedDispatcher = (adapters: FakeOutboundChannelAdapter[]) => {
      const scoped = Object.assign(Object.create(repo) as OutboundDeliveryRepository, {
        discoverTenants: async (limit: number, after: string | null) => (await repo.discoverTenants(limit, after)).filter((t) => mine.has(t)),
      });
      return makeDispatcher(adapters, scoped);
    };
    const until = async (predicate: () => Promise<boolean>, ms = 8_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(25);
      }
      return false;
    };

    it('delivers messages that were waiting and messages that arrive while it runs, then stops cleanly and stays stopped', async () => {
      const waiting = await seedDeliverable(tenantA);
      const adapter = makeAdapter();
      const worker = new OutboundWorker(scopedDispatcher([adapter]), new OutboundAdapterRegistry([adapter]), config);
      worker.onApplicationBootstrap();

      expect(await until(async () => (await row(tenantA, waiting.id)).status === 'SENT')).toBe(true);
      const arriving = await seedDeliverable(tenantB);
      expect(await until(async () => (await row(tenantB, arriving.id)).status === 'SENT')).toBe(true);

      await worker.onModuleDestroy();
      const callsAtStop = adapter.calls.length;
      const late = await seedDeliverable(tenantA);
      await sleep(300);

      expect(worker.isRunning).toBe(false);
      expect(adapter.calls).toHaveLength(callsAtStop);
      expect((await row(tenantA, late.id)).status).toBe('PENDING');
      expect(callsAtStop).toBe(2);
    });

    it('two workers running at once still send each message once', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) ids.push((await seedDeliverable()).id);
      const adapter = makeAdapter(ConversationChannel.WHATSAPP, { latencyMs: 3 });
      const workers = [0, 1].map(() => new OutboundWorker(scopedDispatcher([adapter]), new OutboundAdapterRegistry([adapter]), config));
      workers.forEach((w) => w.start());

      const done = await until(async () => (await messagesOf(tenantA)).every((m) => m.status === 'SENT'));
      await Promise.all(workers.map((w) => w.stop()));

      expect(done).toBe(true);
      expect(adapter.calls).toHaveLength(30);
      expect(new Set(adapter.calls.map((c) => c.idempotencyKey))).toEqual(new Set(ids));
    });

    it('a worker cycle that fails does not stop it: it recovers on the next poll', async () => {
      captureLogs();
      const { id } = await seedDeliverable();
      const adapter = makeAdapter();
      const dispatcher = scopedDispatcher([adapter]);
      const real = dispatcher.dispatchCycle.bind(dispatcher);
      let failures = 0;
      jest.spyOn(dispatcher, 'dispatchCycle').mockImplementation(async (cursor) => {
        if (failures++ < 2) throw Object.assign(new Error('db down'), { name: 'PrismaClientInitializationError' });
        return real(cursor);
      });
      const worker = new OutboundWorker(dispatcher, new OutboundAdapterRegistry([adapter]), config);
      worker.start();

      expect(await until(async () => (await row(tenantA, id)).status === 'SENT')).toBe(true);
      await worker.stop();

      expect(events('outbound.worker.cycle_error')).toHaveLength(2);
    });
  });
});
