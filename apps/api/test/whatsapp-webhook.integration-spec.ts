import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import type { AppConfigService } from '../src/config/app-config.service';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../src/config/first-contact';
import { WhatsAppCloudAccount } from '../src/config/whatsapp-cloud';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { ConversationIngressService } from '../src/modules/conversations/conversation-ingress.service';
import { ConversationIntakeService } from '../src/modules/conversations/conversation-intake.service';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
import { FirstContactService } from '../src/modules/conversations/first-contact/first-contact.service';
import { OUTBOUND_MAX_ATTEMPTS } from '../src/modules/delivery/delivery-policy';
import { OutboundAdapterRegistry } from '../src/modules/delivery/outbound-adapter.registry';
import { OutboundDeliveryRepository } from '../src/modules/delivery/outbound-delivery.repository';
import { OutboundDispatcherService } from '../src/modules/delivery/outbound-dispatcher.service';
import { MessagesService } from '../src/modules/messages/messages.service';
import { WhatsAppCloudAdapter } from '../src/modules/whatsapp/outbound/whatsapp-cloud.adapter';
import { WhatsAppAccountResolver } from '../src/modules/whatsapp/whatsapp-account.resolver';
import { WhatsAppStatusService } from '../src/modules/whatsapp/webhook/whatsapp-status.service';
import { WhatsAppWebhookService } from '../src/modules/whatsapp/webhook/whatsapp-webhook.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeAppClient, makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * The WhatsApp Cloud API integration against REAL PostgreSQL (application role,
 * RLS enforced) and a REAL HTTP boundary: the outbound adapter uses the real
 * fetch against a local stand-in for the Graph API, so the requests it makes are
 * observed exactly as Meta would receive them. No internet.
 *
 * Webhook side: WhatsAppWebhookService -> ConversationIntakeService ->
 * Contact / Conversation / INBOUND / FirstContactService (all real).
 * Outbound side: OutboundDispatcherService -> WhatsAppCloudAdapter -> "Meta".
 */
jest.setTimeout(120_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WA_ID = '5541999990000';
const BSUID = 'US.13491208655302741918';
const BUSINESS_NUMBER = '15550001111';

interface RecordedRequest {
  url: string;
  authorization: string | undefined;
  body: any;
}

describe('WhatsApp Cloud API integration (real Postgres, real HTTP to a fake Meta)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let webhook: WhatsAppWebhookService;
  let statuses: WhatsAppStatusService;
  let dispatcher: OutboundDispatcherService;
  let conversations: ConversationsService;
  let messages: MessagesService;
  let repo: OutboundDeliveryRepository;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: userA, roleCodes: ['ADMIN'] };
  const PHONE_ID_A = '100000000000001';
  const PHONE_ID_B = '200000000000002';
  const TOKEN_A = `EAAG${randomBytes(30).toString('hex')}`;
  const TOKEN_B = `EAAG${randomBytes(30).toString('hex')}`;

  // ---- fake Meta (Graph API) ------------------------------------------------
  let meta: Server;
  let received: RecordedRequest[];
  let respond: (request: RecordedRequest) => { status: number; body: unknown };
  let sequence = 0;
  const acceptAll = () => {
    respond = (request) => ({ status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: request.body.to ?? request.body.recipient, wa_id: request.body.to }], messages: [{ id: `wamid.OUT${++sequence}` }] } });
  };
  const metaError = (status: number, code: number) => () => ({ status, body: { error: { message: `secret provider text ${WA_ID}`, type: 'OAuthException', code, fbtrace_id: 'x' } } });

  const settings = { workerEnabled: false, pollIntervalMs: 50, batchSize: 10, leaseMs: 60_000, sendTimeoutMs: 8_000 };
  let whatsappCloud: { enabled: boolean; appSecret: string; verifyToken: string; graphApiVersion: string; graphApiBaseUrl: string; httpTimeoutMs: number; accounts: WhatsAppCloudAccount[] };
  const config = { get outboundDelivery() { return settings; }, get whatsappCloud() { return whatsappCloud; }, firstContactMessage: DEFAULT_FIRST_CONTACT_MESSAGE } as unknown as AppConfigService;

  // ---- payloads --------------------------------------------------------------
  const change = (phoneNumberId: string, value: Record<string, unknown>, field = 'messages') => ({
    field,
    value: { messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS_NUMBER, phone_number_id: phoneNumberId }, ...value },
  });
  const notification = (...changes: unknown[]) => Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes }] }));
  const incoming = (over: Record<string, unknown> = {}, phoneNumberId = PHONE_ID_A, contact: Record<string, unknown> = { wa_id: WA_ID, profile: { name: 'Ana Cliente' } }) =>
    notification(change(phoneNumberId, { contacts: [contact], messages: [{ id: `wamid.IN.${randomUUID()}`, from: WA_ID, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Oi' }, ...over }] }));
  const statusOf = (id: string, status: string, over: Record<string, unknown> = {}, phoneNumberId = PHONE_ID_A) =>
    notification(change(phoneNumberId, { statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: WA_ID, ...over }] }));

  // ---- database helpers ------------------------------------------------------
  const owner = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(ownerPrisma, tenantId, work);
  const messagesOf = (tenantId: string, where: object = {}) => owner<any[]>(tenantId, (tx) => tx.message.findMany({ where: { tenantId, ...where }, orderBy: { createdAt: 'asc' } }));
  const autoReplies = (tenantId: string) => messagesOf(tenantId, { direction: 'OUTBOUND', senderType: 'SYSTEM', senderUserId: null });
  const inbounds = (tenantId: string) => messagesOf(tenantId, { direction: 'INBOUND' });
  const conversationsOf = (tenantId: string) => owner<any[]>(tenantId, (tx) => tx.conversation.findMany({ where: { tenantId } }));
  const contactsOf = (tenantId: string) => owner<any[]>(tenantId, (tx) => tx.contact.findMany({ where: { tenantId }, include: { channelIdentities: true } }));
  const makeDue = (tenantId: string, id: string) => owner(tenantId, (tx) => tx.$executeRawUnsafe(`UPDATE messages SET next_attempt_at = now() - interval '1 second' WHERE id = '${id}'::uuid`));

  async function wipe(tenantId: string) {
    await owner(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  const logs: { level: string; payload: any }[] = [];
  const captureLogs = () => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => void logs.push({ level, payload: args[0] }));
  };

  /** Customer says "Oi": returns the first outbound (auto reply) after the engine sent it through "Meta". */
  async function firstContactAndSend(tenantId = tenantA, phoneNumberId = PHONE_ID_A) {
    await webhook.process(incoming({}, phoneNumberId));
    await dispatcher.dispatchTenant(tenantId);
    const [reply] = await autoReplies(tenantId);
    return reply;
  }

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    const prisma = appPrisma as unknown as PrismaService;

    meta = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const recorded: RecordedRequest = { url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
        received.push(recorded);
        const { status, body } = respond(recorded);
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => meta.listen(0, '127.0.0.1', resolve));
    const { port } = meta.address() as AddressInfo;

    whatsappCloud = {
      enabled: true,
      appSecret: randomBytes(16).toString('hex'),
      verifyToken: randomBytes(16).toString('hex'),
      graphApiVersion: 'v25.0',
      graphApiBaseUrl: `http://127.0.0.1:${port}`,
      httpTimeoutMs: 5_000,
      accounts: [new WhatsAppCloudAccount(tenantA, PHONE_ID_A, TOKEN_A), new WhatsAppCloudAccount(tenantB, PHONE_ID_B, TOKEN_B)],
    };

    const intake = new ConversationIntakeService(new ConversationIngressService(prisma, new ContactsService(prisma)), new FirstContactService(prisma, config));
    statuses = new WhatsAppStatusService(prisma);
    const accounts = new WhatsAppAccountResolver(config);
    webhook = new WhatsAppWebhookService(config, accounts, intake, statuses);
    repo = new OutboundDeliveryRepository(prisma);
    dispatcher = new OutboundDispatcherService(repo, new OutboundAdapterRegistry([new WhatsAppCloudAdapter(config, accounts)]), config);
    dispatcher.random = () => 0.5;
    conversations = new ConversationsService(prisma);
    messages = new MessagesService(prisma);

    for (const [id, slug] of [
      [tenantA, 'wa-int-a'],
      [tenantB, 'wa-int-b'],
    ]) {
      await owner(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    await owner(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'agent@wa-int.test','Agente','x','ACTIVE',now(),now())`;
    });
  });

  beforeEach(() => {
    received = [];
    sequence = 0;
    acceptAll();
    captureLogs();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await wipe(tenantA);
    await wipe(tenantB);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => meta.close(() => resolve()));
    for (const tenantId of [tenantA, tenantB]) {
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
  describe('first contact, end to end', () => {
    it('webhook "Oi" -> Contact + Conversation + INBOUND + automatic reply -> engine -> "Meta" -> SENT with the id Meta returned; AGUARDANDO_HUMANO', async () => {
      await webhook.process(incoming({ id: 'wamid.IN.first', text: { body: 'Oi' } }));

      // what the webhook stored
      const [contact] = await contactsOf(tenantA);
      expect(contact).toMatchObject({ name: 'Ana Cliente', phoneE164: '+5541999990000' });
      expect(contact.channelIdentities.map((i: any) => [i.channel, i.externalContactId])).toEqual([['WHATSAPP', WA_ID]]);
      const [conversation] = await conversationsOf(tenantA);
      expect(conversation).toMatchObject({ channel: 'WHATSAPP', state: 'AGUARDANDO_HUMANO', assignedUserId: null, externalConversationId: null });
      const [inbound] = await inbounds(tenantA);
      expect(inbound).toMatchObject({ direction: 'INBOUND', senderType: 'CUSTOMER', status: 'DELIVERED', externalId: 'wamid.IN.first', body: 'Oi' });
      const [reply] = await autoReplies(tenantA);
      expect(reply).toMatchObject({ direction: 'OUTBOUND', senderType: 'SYSTEM', status: 'PENDING', body: DEFAULT_FIRST_CONTACT_MESSAGE, externalId: null });
      expect(received).toHaveLength(0); // nothing went to Meta from the webhook request

      // the engine delivers it
      const summary = await dispatcher.dispatchTenant(tenantA);

      expect(summary).toMatchObject({ claimed: 1, sent: 1 });
      expect(received).toEqual([
        {
          url: `/v25.0/${PHONE_ID_A}/messages`,
          authorization: `Bearer ${TOKEN_A}`,
          body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: WA_ID, type: 'text', text: { body: DEFAULT_FIRST_CONTACT_MESSAGE } },
        },
      ]);
      const [sent] = await autoReplies(tenantA);
      expect(sent).toMatchObject({ status: 'SENT', externalId: 'wamid.OUT1', deliveryAttempts: 1, nextAttemptAt: null, leaseToken: null });
      expect(await conversationsOf(tenantA)).toMatchObject([{ state: 'AGUARDANDO_HUMANO', assignedUserId: null }]);
    });

    it.each(['Oi', 'Bom dia', 'Quero informações', 'Quanto custa?', 'Preciso de orçamento', '?', '👍'])('the text %p gets the same single reply (nothing about the content is evaluated)', async (text) => {
      await webhook.process(incoming({ text: { body: text } }));

      const replies = await autoReplies(tenantA);
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
      await wipe(tenantA);
    });

    it('a second message from the same customer is stored and does not get a second automatic reply', async () => {
      await firstContactAndSend();
      received.length = 0;

      await webhook.process(incoming({ text: { body: 'Alguém aí?' } }));
      await dispatcher.dispatchTenant(tenantA);

      expect(await inbounds(tenantA)).toHaveLength(2);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(received).toHaveLength(0);
    });

    it('a user with a username (no phone, only a BSUID) is answered too, through `recipient`', async () => {
      const payload = notification(change(PHONE_ID_A, { contacts: [{ user_id: BSUID, profile: { name: 'Jane', username: 'janedoe' } }], messages: [{ id: 'wamid.IN.bsuid', from_user_id: BSUID, timestamp: '1758000000', type: 'text', text: { body: 'Oi' } }] }));

      await webhook.process(payload);
      await dispatcher.dispatchTenant(tenantA);

      const [contact] = await contactsOf(tenantA);
      expect(contact.phoneE164).toBeNull();
      expect(contact.channelIdentities.map((i: any) => i.externalContactId)).toEqual([BSUID]);
      expect(received[0].body).toEqual({ messaging_product: 'whatsapp', recipient: BSUID, type: 'text', text: { body: DEFAULT_FIRST_CONTACT_MESSAGE } });
      expect((await autoReplies(tenantA))[0].status).toBe('SENT');
    });

    it('a wa_id the phone library does not recognise is still stored and answered (identity by wa_id, no normalized phone)', async () => {
      await webhook.process(incoming({ from: '5541000' }, PHONE_ID_A, { wa_id: '5541000', profile: { name: 'Numero Novo' } }));
      await dispatcher.dispatchTenant(tenantA);

      const [contact] = await contactsOf(tenantA);
      expect(contact.phoneE164).toBeNull();
      expect(contact.channelIdentities[0].externalContactId).toBe('5541000');
      expect(received[0].body.to).toBe('5541000');
      expect((await autoReplies(tenantA))[0].status).toBe('SENT');
    });

    it('reuses the contact of an earlier conversation (Stage B identity) instead of duplicating it', async () => {
      await webhook.process(incoming());
      await webhook.process(incoming({ text: { body: 'de novo' } }));

      expect(await contactsOf(tenantA)).toHaveLength(1);
      expect(await conversationsOf(tenantA)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('Meta redelivers the same webhook', () => {
    it('10 deliveries of the same event: exactly 1 INBOUND, 1 automatic reply, and 1 send to Meta', async () => {
      const payload = incoming({ id: 'wamid.IN.dup' });

      for (let i = 0; i < 10; i++) await webhook.process(payload);
      await dispatcher.dispatchTenant(tenantA);
      await dispatcher.dispatchTenant(tenantA);

      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(await contactsOf(tenantA)).toHaveLength(1);
      expect(await conversationsOf(tenantA)).toHaveLength(1);
      expect(received).toHaveLength(1);
    });

    it('a duplicate delivered AFTER the reply was sent does not create or send anything', async () => {
      const payload = incoming({ id: 'wamid.IN.late' });
      await webhook.process(payload);
      await dispatcher.dispatchTenant(tenantA);
      received.length = 0;

      for (let i = 0; i < 5; i++) await webhook.process(payload);
      await dispatcher.dispatchTenant(tenantA);

      expect(received).toHaveLength(0);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect((await autoReplies(tenantA))[0].status).toBe('SENT');
    });

    it('a redelivery with different content or timestamp returns the original: the first persisted event wins', async () => {
      await webhook.process(incoming({ id: 'wamid.IN.same', text: { body: 'primeira versão' } }));
      await webhook.process(incoming({ id: 'wamid.IN.same', text: { body: 'outra versão' }, timestamp: '1600000000' }));

      const [only] = await inbounds(tenantA);
      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(only.body).toBe('primeira versão');
    });

    it('the same event arriving in 8 simultaneous requests: 1 INBOUND, 1 conversation, 1 automatic reply, 1 send', async () => {
      const payload = incoming({ id: 'wamid.IN.race' });

      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => webhook.process(payload)));
      await Promise.all([dispatcher.dispatchTenant(tenantA), dispatcher.dispatchTenant(tenantA)]);

      expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await conversationsOf(tenantA)).toHaveLength(1);
      expect(await contactsOf(tenantA)).toHaveLength(1);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(received).toHaveLength(1);
    });

    it('two DIFFERENT first messages of the same new customer arriving together: 2 INBOUND, 1 conversation, still ONE automatic reply', async () => {
      const outcomes = await Promise.allSettled([webhook.process(incoming({ id: 'wamid.IN.x1' })), webhook.process(incoming({ id: 'wamid.IN.x2', text: { body: 'e mais uma' } }))]);
      await dispatcher.dispatchTenant(tenantA);

      expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
      expect(await inbounds(tenantA)).toHaveLength(2);
      expect(await conversationsOf(tenantA)).toHaveLength(1);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(received).toHaveLength(1);
    });

    it('8 different first messages at once: still one conversation and ONE automatic reply, sent once', async () => {
      await Promise.all(Array.from({ length: 8 }, (_, i) => webhook.process(incoming({ id: `wamid.IN.burst${i}`, text: { body: `msg ${i}` } }))));
      await Promise.all([dispatcher.dispatchTenant(tenantA), dispatcher.dispatchTenant(tenantA), dispatcher.dispatchTenant(tenantA)]);

      expect(await inbounds(tenantA)).toHaveLength(8);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(received).toHaveLength(1);
    });

    it('a notification that repeats the same wamid inside ONE payload is also stored once', async () => {
      const message = { id: 'wamid.IN.twice', from: WA_ID, timestamp: '1758000000', type: 'text', text: { body: 'Oi' } };

      await webhook.process(notification(change(PHONE_ID_A, { contacts: [{ wa_id: WA_ID }], messages: [message, message] })));

      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await autoReplies(tenantA)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('two tenants, one customer number: separate contacts and conversations, each answered from its OWN number with its OWN token', async () => {
      await webhook.process(incoming({ id: 'wamid.IN.a' }, PHONE_ID_A));
      await webhook.process(incoming({ id: 'wamid.IN.b' }, PHONE_ID_B));
      await dispatcher.dispatchTenant(tenantA);
      await dispatcher.dispatchTenant(tenantB);

      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await inbounds(tenantB)).toHaveLength(1);
      expect((await contactsOf(tenantA))[0].id).not.toBe((await contactsOf(tenantB))[0].id);
      expect(received.map((r) => [r.url, r.authorization]).sort()).toEqual(
        [
          [`/v25.0/${PHONE_ID_A}/messages`, `Bearer ${TOKEN_A}`],
          [`/v25.0/${PHONE_ID_B}/messages`, `Bearer ${TOKEN_B}`],
        ].sort(),
      );
      expect(JSON.stringify(received.filter((r) => r.url.includes(PHONE_ID_A)))).not.toContain(TOKEN_B);
    });

    it('the SAME wamid in two tenants does not collide: each keeps its own message', async () => {
      await webhook.process(incoming({ id: 'wamid.IN.shared' }, PHONE_ID_A));
      await webhook.process(incoming({ id: 'wamid.IN.shared' }, PHONE_ID_B));

      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await inbounds(tenantB)).toHaveLength(1);
    });

    it('an unknown phone_number_id creates nothing in ANY tenant and sends nothing', async () => {
      const summary = await webhook.process(incoming({}, '999999999999999'));

      expect(summary.unknownPhoneNumber).toBe(1);
      for (const tenantId of [tenantA, tenantB]) {
        expect(await messagesOf(tenantId)).toHaveLength(0);
        expect(await contactsOf(tenantId)).toHaveLength(0);
      }
      expect(received).toHaveLength(0);
    });

    it('a tenantId planted in the payload cannot move data into another tenant', async () => {
      const raw = JSON.parse(incoming({ tenantId: tenantB }).toString());
      raw.tenantId = tenantB;
      raw.entry[0].changes[0].value.metadata.tenant_id = tenantB;

      await webhook.process(Buffer.from(JSON.stringify(raw)));

      expect(await inbounds(tenantA)).toHaveLength(1);
      expect(await messagesOf(tenantB)).toHaveLength(0);
    });

    it('tenant A can never send to an identity of tenant B: the recipient comes from A\'s own conversation', async () => {
      const otherWaId = '5511977770000';
      await webhook.process(incoming({ id: 'wamid.IN.b', from: otherWaId }, PHONE_ID_B, { wa_id: otherWaId, profile: { name: 'Cliente do B' } }));
      await webhook.process(incoming({ id: 'wamid.IN.a' }, PHONE_ID_A));

      await dispatcher.dispatchTenant(tenantA);

      expect(received).toHaveLength(1);
      expect(received[0].body.to).toBe(WA_ID);
      expect(JSON.stringify(received)).not.toContain(otherWaId);
      expect((await autoReplies(tenantB))[0].status).toBe('PENDING'); // B's reply untouched by A's dispatch
    });
  });

  // ---------------------------------------------------------------------------
  describe('status callbacks', () => {
    it('sent -> delivered -> read moves the outbound message forward, only ever forward', async () => {
      const reply = await firstContactAndSend();
      expect(reply.status).toBe('SENT');
      const wamid = reply.externalId;

      await webhook.process(statusOf(wamid, 'sent'));
      expect((await autoReplies(tenantA))[0].status).toBe('SENT');
      await webhook.process(statusOf(wamid, 'delivered'));
      expect((await autoReplies(tenantA))[0].status).toBe('DELIVERED');
      await webhook.process(statusOf(wamid, 'read'));
      expect((await autoReplies(tenantA))[0].status).toBe('READ');
    });

    it('out of order: READ, then DELIVERED, then SENT stays READ', async () => {
      const wamid = (await firstContactAndSend()).externalId;

      await webhook.process(statusOf(wamid, 'read'));
      await webhook.process(statusOf(wamid, 'delivered'));
      await webhook.process(statusOf(wamid, 'sent'));

      expect((await autoReplies(tenantA))[0].status).toBe('READ');
    });

    it('DELIVERED then SENT stays DELIVERED', async () => {
      const wamid = (await firstContactAndSend()).externalId;

      await webhook.process(statusOf(wamid, 'delivered'));
      await webhook.process(statusOf(wamid, 'sent'));

      expect((await autoReplies(tenantA))[0].status).toBe('DELIVERED');
    });

    it('a repeated callback is idempotent: the second one changes nothing and is reported as a no-op', async () => {
      const wamid = (await firstContactAndSend()).externalId;
      const first = await webhook.process(statusOf(wamid, 'delivered'));
      const before = (await autoReplies(tenantA))[0];

      const summaries = [await webhook.process(statusOf(wamid, 'delivered')), await webhook.process(statusOf(wamid, 'delivered'))];

      expect(first.statusesApplied).toBe(1);
      for (const s of summaries) expect(s).toMatchObject({ statusesApplied: 0, statusesNoop: 1 });
      expect(await autoReplies(tenantA)).toEqual([before]);
    });

    it('failed: SENT -> FAILED with only the numeric Meta code stored (never its text)', async () => {
      const wamid = (await firstContactAndSend()).externalId;

      await webhook.process(statusOf(wamid, 'failed', { errors: [{ code: 131047, title: 'Re-engagement message', message: `to ${WA_ID}: secret text`, error_data: { details: 'x' } }] }));

      const [reply] = await autoReplies(tenantA);
      expect(reply).toMatchObject({ status: 'FAILED', lastErrorCode: 'WA_131047' });
      expect(JSON.stringify(reply)).not.toMatch(/secret text|Re-engagement/);
    });

    it('a late FAILED never overwrites DELIVERED/READ, and a late DELIVERED never resurrects FAILED', async () => {
      const wamid = (await firstContactAndSend()).externalId;
      await webhook.process(statusOf(wamid, 'delivered'));
      await webhook.process(statusOf(wamid, 'failed', { errors: [{ code: 131026 }] }));
      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'DELIVERED', lastErrorCode: null });

      await wipe(tenantA);
      const second = (await firstContactAndSend()).externalId;
      await webhook.process(statusOf(second, 'failed', { errors: [{ code: 131026 }] }));
      await webhook.process(statusOf(second, 'delivered'));
      await webhook.process(statusOf(second, 'read'));
      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'WA_131026' });
    });

    it('8 concurrent callbacks in any order end at READ', async () => {
      const wamid = (await firstContactAndSend()).externalId;

      await Promise.all(['delivered', 'read', 'sent', 'delivered', 'read', 'delivered', 'sent', 'read'].map((s) => webhook.process(statusOf(wamid, s))));

      expect((await autoReplies(tenantA))[0].status).toBe('READ');
    });

    it('a callback for a wamid nobody has is acknowledged and changes nothing', async () => {
      await firstContactAndSend();
      const before = await messagesOf(tenantA);

      const summary = await webhook.process(statusOf('wamid.UNKNOWN', 'delivered'));

      expect(summary).toMatchObject({ statusesUnmatched: 1, statusesApplied: 0 });
      expect(await messagesOf(tenantA)).toEqual(before);
    });

    it('a callback can only touch a message of the tenant that owns its phone_number_id, even for the same wamid string', async () => {
      const wamidA = (await firstContactAndSend(tenantA, PHONE_ID_A)).externalId;
      // give tenant B an outbound message with the SAME provider id
      await webhook.process(incoming({ id: 'wamid.IN.b' }, PHONE_ID_B));
      const [replyB] = await autoReplies(tenantB);
      await owner(tenantB, (tx) => tx.message.update({ where: { id: replyB.id }, data: { status: 'SENT', externalId: wamidA, nextAttemptAt: null } }));

      await webhook.process(statusOf(wamidA, 'read', {}, PHONE_ID_A));

      expect((await autoReplies(tenantA))[0].status).toBe('READ');
      expect((await autoReplies(tenantB))[0].status).toBe('SENT'); // tenant B's message with the same id: untouched
    });

    it('a status callback for a phone_number_id of tenant B cannot move tenant A\'s message', async () => {
      const wamidA = (await firstContactAndSend()).externalId;

      const summary = await webhook.process(statusOf(wamidA, 'read', {}, PHONE_ID_B));

      expect(summary.statusesUnmatched).toBe(1);
      expect((await autoReplies(tenantA))[0].status).toBe('SENT');
    });

    it('an INBOUND message id can never be moved by a status callback', async () => {
      await webhook.process(incoming({ id: 'wamid.IN.customer' }));

      const summary = await webhook.process(statusOf('wamid.IN.customer', 'read'));

      expect(summary.statusesUnmatched).toBe(1);
      expect((await inbounds(tenantA))[0].status).toBe('DELIVERED');
    });

    it('a callback for a message still PENDING (not yet sent, no provider id) finds nothing to move', async () => {
      await webhook.process(incoming());
      const [pending] = await autoReplies(tenantA);

      const summary = await webhook.process(statusOf('wamid.OUT1', 'delivered'));

      expect(summary.statusesUnmatched).toBe(1);
      expect((await autoReplies(tenantA))[0]).toMatchObject({ id: pending.id, status: 'PENDING' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('a person takes over', () => {
    it('AGUARDANDO_HUMANO -> assigned -> HUMANO_ATENDENDO -> the agent\'s message goes through the SAME engine -> SENT; the automation does not answer again', async () => {
      await firstContactAndSend();
      const [conversation] = await conversationsOf(tenantA);
      received.length = 0;

      const assigned = await conversations.assign(ctxA, conversation.id, userA);
      expect(assigned).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });

      const sent = await messages.send(ctxA, conversation.id, { body: 'Oi! Aqui é a Ana, como posso ajudar?' });
      expect(sent).toMatchObject({ direction: 'OUTBOUND', senderType: 'AGENT', status: 'PENDING' });
      await dispatcher.dispatchTenant(tenantA);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ url: `/v25.0/${PHONE_ID_A}/messages`, authorization: `Bearer ${TOKEN_A}` });
      expect(received[0].body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: WA_ID, type: 'text', text: { body: 'Oi! Aqui é a Ana, como posso ajudar?' } });
      expect((await messagesOf(tenantA, { id: sent.id }))[0]).toMatchObject({ status: 'SENT', externalId: 'wamid.OUT2' });

      // the customer answers: stored, no new automatic reply, conversation stays with the person
      await webhook.process(incoming({ text: { body: 'Quero um orçamento' } }));
      await dispatcher.dispatchTenant(tenantA);
      expect(await inbounds(tenantA)).toHaveLength(2);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(await conversationsOf(tenantA)).toMatchObject([{ state: 'HUMANO_ATENDENDO', assignedUserId: userA }]);
    });

    it('a customer message that arrives while a person has the conversation is stored and never triggers the automation', async () => {
      await webhook.process(incoming());
      const [conversation] = await conversationsOf(tenantA);
      await conversations.assign(ctxA, conversation.id, userA);
      await owner(tenantA, (tx) => tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantA}::uuid AND sender_type = 'SYSTEM'`);

      await webhook.process(incoming({ text: { body: 'Estou aqui' } }));

      expect(await autoReplies(tenantA)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('events that must not become conversation messages', () => {
    const assertNothingCreated = async () => {
      expect(await messagesOf(tenantA)).toHaveLength(0);
      expect(await contactsOf(tenantA)).toHaveLength(0);
      expect(received).toHaveLength(0);
    };

    it.each(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'reaction', 'interactive'])('a %s message is acknowledged, creates nothing and is not answered', async (type) => {
      const summary = await webhook.process(incoming({ type, text: undefined, [type]: { id: 'x' } }));

      expect(summary).toMatchObject({ messages: 0, ignored: 1 });
      await assertNothingCreated();
    });

    it('smb_message_echoes (the business\'s own messages) create nothing: no message, no automatic reply, no loop', async () => {
      await webhook.process(notification(change(PHONE_ID_A, { messages: [{ id: 'wamid.ECHO', from: '5511955550000', to: WA_ID, type: 'text', text: { body: 'enviado pelo app' } }] }, 'smb_message_echoes'))); // a customer-like sender: only the FIELD rule can stop it

      await assertNothingCreated();
    });

    it.each(['image', 'audio', 'video', 'document', 'sticker', 'location', 'reaction'])('a %s message is ignored even if it carries a text body (the TYPE decides, not the presence of text)', async (type) => {
      const summary = await webhook.process(incoming({ type, text: { body: 'legenda' } }));

      expect(summary).toMatchObject({ messages: 0, ignored: 1 });
      await assertNothingCreated();
    });

    it('a message "from" the business own number is dropped', async () => {
      await webhook.process(incoming({ from: BUSINESS_NUMBER }, PHONE_ID_A, { wa_id: BUSINESS_NUMBER }));

      await assertNothingCreated();
    });

    it('the wamid of an outbound message coming back as an inbound cannot start a loop: it is recognised as already known', async () => {
      const reply = await firstContactAndSend();
      const before = await messagesOf(tenantA);
      received.length = 0;

      await webhook.process(incoming({ id: reply.externalId, from: WA_ID }));
      await dispatcher.dispatchTenant(tenantA);

      expect(await messagesOf(tenantA)).toEqual(before);
      expect(received).toHaveLength(0);
    });

    it('other webhook fields (template/account updates) are ignored', async () => {
      await webhook.process(notification(change(PHONE_ID_A, { event: 'APPROVED' }, 'message_template_status_update')));

      await assertNothingCreated();
    });
  });

  // ---------------------------------------------------------------------------
  describe('Meta unavailable or refusing', () => {
    it('Meta down (503): the customer\'s message is not lost, the reply stays PENDING and is retried with backoff, then delivered when Meta is back', async () => {
      respond = metaError(503, 2);
      await webhook.process(incoming({ id: 'wamid.IN.down' }));

      const first = await dispatcher.dispatchTenant(tenantA);

      expect(first).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
      expect(await inbounds(tenantA)).toHaveLength(1);
      const [waiting] = await autoReplies(tenantA);
      expect(waiting).toMatchObject({ status: 'PENDING', deliveryAttempts: 1, lastErrorCode: 'WA_2', leaseToken: null, externalId: null });
      expect(waiting.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000); // backed off, in the database
      expect((await dispatcher.dispatchTenant(tenantA)).claimed).toBe(0);

      acceptAll();
      await makeDue(tenantA, waiting.id);
      const second = await dispatcher.dispatchTenant(tenantA);

      expect(second).toMatchObject({ claimed: 1, sent: 1 });
      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'SENT', deliveryAttempts: 2, lastErrorCode: null });
    });

    it('a rate limit (429 / 130429) is retried, never FAILED on the first attempt', async () => {
      respond = metaError(429, 130429);
      await webhook.process(incoming());

      await dispatcher.dispatchTenant(tenantA);

      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'PENDING', lastErrorCode: 'WA_130429' });
    });

    it('the whole retry budget: temporary failures end FAILED after the last attempt', async () => {
      respond = metaError(500, 131000);
      await webhook.process(incoming());
      const [reply] = await autoReplies(tenantA);

      for (let i = 0; i < OUTBOUND_MAX_ATTEMPTS; i++) {
        await dispatcher.dispatchTenant(tenantA);
        await makeDue(tenantA, reply.id).catch(() => undefined);
      }

      expect(received).toHaveLength(OUTBOUND_MAX_ATTEMPTS);
      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'WA_131000', deliveryAttempts: OUTBOUND_MAX_ATTEMPTS });
      expect(await inbounds(tenantA)).toHaveLength(1);
    });

    it.each([
      [400, 100],
      [401, 190],
      [403, 131047],
      [400, 131026],
    ])('a permanent refusal (HTTP %i, Meta code %i) is FAILED at once and never retried', async (status, code) => {
      respond = metaError(status, code);
      await webhook.process(incoming());

      await dispatcher.dispatchTenant(tenantA);
      await dispatcher.dispatchTenant(tenantA);

      expect(received).toHaveLength(1);
      const [reply] = await autoReplies(tenantA);
      expect(reply).toMatchObject({ status: 'FAILED', lastErrorCode: `WA_${code}`, deliveryAttempts: 1 });
      expect(JSON.stringify(reply)).not.toContain('secret provider text');
    });

    it('a KNOWN Meta code decides over the HTTP status: 131047 (outside the 24 h window) is permanent even on a 500', async () => {
      respond = metaError(500, 131047);
      await webhook.process(incoming());

      await dispatcher.dispatchTenant(tenantA);
      await dispatcher.dispatchTenant(tenantA);

      expect(received).toHaveLength(1);
      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'WA_131047', deliveryAttempts: 1 });
    });

    it('a 200 from Meta without a message id is not retried (it could send twice) and is not marked SENT', async () => {
      respond = () => ({ status: 200, body: { messaging_product: 'whatsapp' } });
      await webhook.process(incoming());

      await dispatcher.dispatchTenant(tenantA);

      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'WA_INVALID_RESPONSE', externalId: null });
    });

    it('a Meta that hangs is cut by the timeout (WA_TIMEOUT) and retried', async () => {
      whatsappCloud.httpTimeoutMs = 150;
      const realRespond = respond;
      respond = () => {
        throw new Error('unused'); // replaced below: the server never answers in time
      };
      const originalMeta = meta.listeners('request')[0] as (req: IncomingMessage, res: any) => void;
      meta.removeAllListeners('request');
      meta.on('request', (req: IncomingMessage) => void req.resume()); // accept the connection, never answer
      await webhook.process(incoming());

      const summary = await dispatcher.dispatchTenant(tenantA);

      meta.removeAllListeners('request');
      meta.on('request', originalMeta);
      respond = realRespond;
      whatsappCloud.httpTimeoutMs = 5_000;
      expect(summary).toMatchObject({ claimed: 1, retried: 1 });
      expect((await autoReplies(tenantA))[0]).toMatchObject({ status: 'PENDING', lastErrorCode: 'WA_TIMEOUT' });
    });

    it('nothing sensitive is ever sent to Meta beyond the message: no tenant id, no internal ids, no customer name', async () => {
      await webhook.process(incoming());

      await dispatcher.dispatchTenant(tenantA);

      const sentToMeta = JSON.stringify(received.map((r) => r.body));
      for (const internal of [tenantA, 'Ana Cliente', 'idempotency']) expect(sentToMeta).not.toContain(internal);
    });
  });

  // ---------------------------------------------------------------------------
  describe('durability', () => {
    it('a restarted API loses nothing: everything the worker needs is in the database', async () => {
      await webhook.process(incoming());
      // "restart": brand new service instances, nothing carried over in memory
      const prisma = appPrisma as unknown as PrismaService;
      const accounts = new WhatsAppAccountResolver(config);
      const fresh = new OutboundDispatcherService(new OutboundDeliveryRepository(prisma), new OutboundAdapterRegistry([new WhatsAppCloudAdapter(config, accounts)]), config);

      const summary = await fresh.dispatchTenant(tenantA);

      expect(summary.sent).toBe(1);
      expect((await autoReplies(tenantA))[0].status).toBe('SENT');
    });

    it('logs of the whole flow carry ids and outcomes, never the customer text, name, phone, BSUID or any token', async () => {
      captureLogs();
      const reply = await firstContactAndSend();
      await webhook.process(statusOf(reply.externalId, 'delivered'));
      await webhook.process(incoming({ from: '5541000', text: { body: 'Meu cartão é 4111 1111 1111 1111' } }, PHONE_ID_A, { wa_id: '5541000', profile: { name: 'Fulano Sigiloso' } }));
      await webhook.process(incoming({ type: 'image' }));

      const everything = JSON.stringify(logs.map((l) => l.payload));
      expect(logs.length).toBeGreaterThan(5);
      for (const secret of ['4111', 'Fulano', 'Ana Cliente', WA_ID, '5541000', BSUID, TOKEN_A, TOKEN_B, whatsappCloud.appSecret, whatsappCloud.verifyToken, DEFAULT_FIRST_CONTACT_MESSAGE, 'Oi']) {
        expect(everything).not.toContain(secret);
      }
      await sleep(0);
    });
  });
});
