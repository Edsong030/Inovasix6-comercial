import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent } from 'node:http';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/common/http/global-validation.pipe';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../src/config/first-contact';
import { makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * First contact -> automatic reply -> human handoff over REAL HTTP: the inbound
 * endpoint (service credential), then the existing Inbox endpoints (user JWT),
 * against real Postgres. Every credential/token is generated at run time.
 */
const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const cred = (tenantId: string, keyId: string, channel: string) => ({ keyId, tenantId, channel, secret: randomBytes(32).toString('hex') });
const credWa = cred(tenantA, 'fc-a-whatsapp', 'WHATSAPP');
const credWeb = cred(tenantA, 'fc-a-webchat', 'WEBCHAT');
const credB = cred(tenantB, 'fc-b-whatsapp', 'WHATSAPP');

const basic = (c: { keyId: string; secret: string }) => `Basic ${Buffer.from(`${c.keyId}:${c.secret}`).toString('base64')}`;

let AppModule: typeof import('../src/app.module').AppModule;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INBOUND_SERVICE_CREDENTIALS = JSON.stringify([credWa, credWeb, credB]);
  delete process.env.FIRST_CONTACT_MESSAGE; // the built-in default
  ({ AppModule } = await import('../src/app.module'));
});

describe('first contact automatic reply and handoff (HTTP, real Postgres)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let url: string;
  let userToken: string;

  // Reused sockets: see the note in conversation-inbound.e2e-spec.ts about the Jest/Node/Windows crash.
  const keepAlive = new Agent({ keepAlive: true, maxSockets: 16 });
  const inbound = (c: { keyId: string; secret: string }, body: Record<string, unknown>) =>
    request(url).post('/api/conversations/inbound').agent(keepAlive).set('Authorization', basic(c)).send(body);
  const asUser = (method: 'get' | 'post' | 'patch', path: string) =>
    request(url)[method](path).agent(keepAlive).set('Authorization', `Bearer ${userToken}`);

  const event = (over: Record<string, unknown> = {}) => ({
    externalContactId: 'wa-1',
    externalMessageId: `m-${randomUUID()}`,
    content: 'Oi',
    ...over,
  });
  const run = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(owner, tenantId, work);
  const messagesOf = (tenantId: string, conversationId: string) =>
    run<any[]>(tenantId, (tx) => tx.message.findMany({ where: { tenantId, conversationId }, orderBy: { createdAt: 'asc' } }));
  const isAutoReply = (m: any) => m.direction === 'OUTBOUND' && m.senderType === 'SYSTEM' && m.senderUserId === null;

  async function wipe(tenantId: string) {
    await run(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  beforeAll(async () => {
    owner = makeOwnerClient();
    for (const [id, slug] of [
      [tenantA, 'first-contact-e2e-a'],
      [tenantB, 'first-contact-e2e-b'],
    ]) {
      await run(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    await run(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'agent@first-contact-e2e.test','Ana Atendente','x','ACTIVE',now(),now())`;
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    await app.listen(0);
    url = await app.getUrl();

    // A signed access token for an internal user (the JWT guard only verifies the signature).
    const { TokenService } = await import('../src/modules/auth/token.service');
    userToken = await app.get(TokenService).signAccessToken({ sub: userA, tenantId: tenantA, roleCodes: ['ADMIN'], sessionId: randomUUID() });
  });

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await wipe(tenantA);
    await wipe(tenantB);
  });

  afterAll(async () => {
    keepAlive.destroy();
    await app.close();
    for (const tenantId of [tenantA, tenantB]) {
      await wipe(tenantId);
      await run(tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await owner.$disconnect();
  });

  it('the complete story: first contact, a second message, a redelivery, a person takes over, another message', async () => {
    // 1. first event -> 201, inbound stored, ONE automatic reply, conversation waiting for a human
    const first = await inbound(credWa, event({ externalMessageId: 'wamid-1', content: 'Oi' })).expect(201);
    const conversationId = first.body.conversationId;
    expect(first.body).toMatchObject({ duplicate: false, conversationCreated: true, messageCreated: true });
    let thread = await messagesOf(tenantA, conversationId);
    expect(thread.map((m) => [m.direction, m.senderType, m.status])).toEqual([
      ['INBOUND', 'CUSTOMER', 'DELIVERED'],
      ['OUTBOUND', 'SYSTEM', 'PENDING'],
    ]);
    expect(thread[1].body).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
    let row: any = await run(tenantA, (tx) => tx.conversation.findUnique({ where: { id: conversationId } }));
    expect(row).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null });

    // 2. a different second event in the same conversation -> 201, new inbound, NO new automatic reply
    const second = await inbound(credWa, event({ externalMessageId: 'wamid-2', content: 'Quero um orçamento' })).expect(201);
    expect(second.body).toMatchObject({ conversationId, conversationCreated: false, messageCreated: true });
    thread = await messagesOf(tenantA, conversationId);
    expect(thread.filter(isAutoReply)).toHaveLength(1);
    expect(thread.filter((m) => m.direction === 'INBOUND')).toHaveLength(2);

    // 3. a redelivery -> 200 duplicate, nothing new
    const again = await inbound(credWa, event({ externalMessageId: 'wamid-2', content: 'Quero um orçamento' })).expect(200);
    expect(again.body).toMatchObject({ duplicate: true, messageId: second.body.messageId });
    expect((await messagesOf(tenantA, conversationId)).length).toBe(3);

    // 4. an internal user takes the conversation through the EXISTING endpoint
    const assigned = await asUser('patch', `/api/conversations/${conversationId}/assign`).send({ userId: userA }).expect(200);
    expect(assigned.body).toMatchObject({ id: conversationId, state: 'HUMANO_ATENDENDO', assignedUserId: userA });

    // 5. another inbound message -> stored, and the automation stays out
    const third = await inbound(credWa, event({ externalMessageId: 'wamid-3', content: 'É para amanhã' })).expect(201);
    expect(third.body).toMatchObject({ conversationId, messageCreated: true });
    thread = await messagesOf(tenantA, conversationId);
    expect(thread.filter(isAutoReply)).toHaveLength(1); // still the original one
    expect(thread.filter((m) => m.direction === 'INBOUND')).toHaveLength(3);
    row = await run(tenantA, (tx) => tx.conversation.findUnique({ where: { id: conversationId } }));
    expect(row).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
  });

  it('the Inbox shows the new conversation, and its history has the customer message and the automatic reply in order', async () => {
    const first = await inbound(credWa, event({ content: 'Preciso falar com alguém', contact: { name: 'Ana Cliente', phone: '+5541999999999' } })).expect(201);

    const list = await asUser('get', '/api/conversations').expect(200);
    const item = list.body.items.find((c: any) => c.id === first.body.conversationId);
    expect(item).toMatchObject({ contactName: 'Ana Cliente', channel: 'WHATSAPP', state: 'AGUARDANDO_HUMANO', assignedUserId: null });

    const history = await asUser('get', `/api/conversations/${first.body.conversationId}/messages`).expect(200);
    expect(history.body.items.map((m: any) => [m.direction, m.senderType, m.status, m.body])).toEqual([
      ['INBOUND', 'CUSTOMER', 'DELIVERED', 'Preciso falar com alguém'],
      ['OUTBOUND', 'SYSTEM', 'PENDING', DEFAULT_FIRST_CONTACT_MESSAGE],
    ]);
    const [customer, reply] = history.body.items;
    expect(new Date(reply.createdAt).getTime()).toBeGreaterThan(new Date(customer.createdAt).getTime());
  });

  it('a human reply through POST /conversations/:id/messages keeps its contract and is not confused with the automatic one', async () => {
    const first = await inbound(credWa, event()).expect(201);
    await asUser('patch', `/api/conversations/${first.body.conversationId}/assign`).send({ userId: userA }).expect(200);

    const sent = await asUser('post', `/api/conversations/${first.body.conversationId}/messages`).send({ body: 'Olá, sou a Ana da equipe.' }).expect(201);

    expect(sent.body).toMatchObject({ direction: 'OUTBOUND', senderType: 'AGENT', senderUserId: userA, status: 'SENT', body: 'Olá, sou a Ana da equipe.' });
    const history = await asUser('get', `/api/conversations/${first.body.conversationId}/messages`).expect(200);
    expect(history.body.items.filter((m: any) => m.senderType === 'SYSTEM')).toHaveLength(1);
    expect(history.body.items.filter((m: any) => m.senderType === 'AGENT')).toHaveLength(1);
  });

  it('channel-agnostic: a webchat credential gets the same first-contact reply, on its own conversation', async () => {
    const wa = await inbound(credWa, event({ externalContactId: 'same-person', contact: { phone: '+5541988887777' } })).expect(201);

    const web = await inbound(credWeb, event({ externalContactId: 'visitor-1', externalConversationId: 'session-1', contact: { phone: '+5541988887777' } })).expect(201);

    expect(web.body.conversationId).not.toBe(wa.body.conversationId);
    expect((await messagesOf(tenantA, web.body.conversationId)).filter(isAutoReply)).toHaveLength(1);
    expect((await messagesOf(tenantA, wa.body.conversationId)).filter(isAutoReply)).toHaveLength(1);
  });

  it('other tenants are independent, and only ever get their own reply', async () => {
    const a = await inbound(credWa, event({ externalMessageId: 'shared-wamid' })).expect(201);
    const b = await inbound(credB, event({ externalMessageId: 'shared-wamid' })).expect(201);

    expect((await messagesOf(tenantA, a.body.conversationId)).filter(isAutoReply)).toHaveLength(1);
    expect((await messagesOf(tenantB, b.body.conversationId)).filter(isAutoReply)).toHaveLength(1);
    expect(await run(tenantA, (tx) => tx.message.count({ where: { tenantId: tenantA } }))).toBe(2);
    expect(await run(tenantB, (tx) => tx.message.count({ where: { tenantId: tenantB } }))).toBe(2);
  });

  it('8 simultaneous deliveries of the first message over HTTP: one 201, seven 200, exactly one automatic reply', async () => {
    const body = event({ externalMessageId: 'wamid-parallel' });

    const responses = await Promise.all(Array.from({ length: 8 }, () => inbound(credWa, body)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(7);
    const conversationId = responses[0].body.conversationId;
    const thread = await messagesOf(tenantA, conversationId);
    expect(thread.filter((m) => m.direction === 'INBOUND')).toHaveLength(1);
    expect(thread.filter(isAutoReply)).toHaveLength(1);
  });

  it('the public response and the security rules of the inbound endpoint are unchanged', async () => {
    const res = await inbound(credWa, event()).expect(201);

    expect(Object.keys(res.body).sort()).toEqual(
      ['contactCreated', 'contactId', 'conversationCreated', 'conversationId', 'duplicate', 'identityCreated', 'messageCreated', 'messageId'],
    );
    expect(JSON.stringify(res.body)).not.toContain(DEFAULT_FIRST_CONTACT_MESSAGE);
    await request(url).post('/api/conversations/inbound').agent(keepAlive).send(event()).expect(401);
    await inbound(credWa, { ...event(), tenantId: tenantB }).expect(400);
    await inbound(credWa, { ...event(), channel: 'INSTAGRAM' }).expect(400);
  });
});
