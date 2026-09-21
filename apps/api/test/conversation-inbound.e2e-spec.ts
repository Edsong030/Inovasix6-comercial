import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { Agent } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/common/http/global-validation.pipe';
import { makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * HTTP tests for POST /api/conversations/inbound: the real AppModule (guards,
 * throttler, ValidationPipe, filters) over supertest, against REAL Postgres.
 *
 * Every credential below is generated at run time from random bytes; nothing
 * here is a real secret, and none is written to disk.
 */

const secret = () => randomBytes(32).toString('hex');
const tenantA = randomUUID();
const tenantB = randomUUID();

const credA = { keyId: 'test-a-whatsapp', tenantId: tenantA, channel: 'WHATSAPP', secret: secret() };
const credAWeb = { keyId: 'test-a-webchat', tenantId: tenantA, channel: 'WEBCHAT', secret: secret() };
const credB = { keyId: 'test-b-instagram', tenantId: tenantB, channel: 'INSTAGRAM', secret: secret() };
const credBWa = { keyId: 'test-b-whatsapp', tenantId: tenantB, channel: 'WHATSAPP', secret: secret() };
const ALL = [credA, credAWeb, credB, credBWa];

const basic = (cred: { keyId: string; secret: string }) =>
  `Basic ${Buffer.from(`${cred.keyId}:${cred.secret}`).toString('base64')}`;

const event = (over: Record<string, unknown> = {}) => ({
  externalContactId: 'wa-1',
  externalMessageId: `m-${randomUUID()}`,
  content: 'Olá, preciso de um orçamento',
  occurredAt: '2024-01-01T10:00:00Z',
  ...over,
});

let AppModule: typeof import('../src/app.module').AppModule;

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  await app.init();
  return app;
}

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent'; // pino-http would otherwise print every request
  process.env.INBOUND_SERVICE_CREDENTIALS = JSON.stringify(ALL);
  ({ AppModule } = await import('../src/app.module'));
});

describe('POST /api/conversations/inbound (HTTP, real Postgres)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let logged: string[];
  let url: string;

  // supertest opens a fresh connection per call by default; reusing sockets
  // avoids a native crash of the Jest worker on Node 24 / Windows that grows with
  // the number of connections (see the rate limiting block below).
  const keepAlive = new Agent({ keepAlive: true, maxSockets: 16 });
  const client = () => ({
    post: (path: string) => request(url).post(path).agent(keepAlive),
    get: (path: string) => request(url).get(path).agent(keepAlive),
  });

  const post = (cred: { keyId: string; secret: string } | null, body: unknown) => {
    const req = client().post('/api/conversations/inbound');
    if (cred) req.set('Authorization', basic(cred));
    return req.send(body as object);
  };
  const run = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(owner, tenantId, work);
  const counts = (tenantId: string) =>
    run(tenantId, async (tx) => ({
      contacts: await tx.contact.count({ where: { tenantId } }),
      conversations: await tx.conversation.count({ where: { tenantId } }),
      messages: await tx.message.count({ where: { tenantId } }),
    }));
  const NOTHING = { contacts: 0, conversations: 0, messages: 0 };

  async function wipe(tenantId: string) {
    await run(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  beforeAll(async () => {
    owner = makeOwnerClient();
    for (const [id, slug] of [
      [tenantA, 'inbound-e2e-a'],
      [tenantB, 'inbound-e2e-b'],
    ]) {
      await run(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    app = await createApp();
    await app.listen(0);
    url = await app.getUrl();
  });

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
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
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await owner.$disconnect();
  });

  describe('success and idempotency', () => {
    it('A) a valid event with credential A creates the data in tenant A, channel WHATSAPP -> 201', async () => {
      const res = await post(credA, event({ contact: { name: 'Ana', phone: '(41) 99999-9999', defaultCountry: 'BR' } })).expect(201);

      expect(res.body).toEqual({
        duplicate: false,
        contactId: expect.any(String),
        conversationId: expect.any(String),
        messageId: expect.any(String),
        contactCreated: true,
        identityCreated: true,
        conversationCreated: true,
        messageCreated: true,
      });
      expect(await counts(tenantA)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
      expect(await counts(tenantB)).toEqual(NOTHING);

      const conversation: any = await run(tenantA, (tx) => tx.conversation.findUnique({ where: { id: res.body.conversationId } }));
      expect(conversation).toMatchObject({ tenantId: tenantA, channel: 'WHATSAPP', state: 'AI_ATENDENDO', leadId: null });
      const message: any = await run(tenantA, (tx) => tx.message.findUnique({ where: { id: res.body.messageId } }));
      expect(message).toMatchObject({ tenantId: tenantA, direction: 'INBOUND', status: 'DELIVERED', body: 'Olá, preciso de um orçamento' });
      expect(message.createdAt.toISOString()).toBe('2024-01-01T10:00:00.000Z');
      const contact: any = await run(tenantA, (tx) => tx.contact.findUnique({ where: { id: res.body.contactId } }));
      expect(contact).toMatchObject({ name: 'Ana', phoneE164: '+5541999999999' });
    });

    it('the response exposes ids and flags only', async () => {
      const res = await post(credA, event({ content: 'CONTEUDO-PRIVADO', contact: { phone: '+5541999999999', email: 'privado@example.com' } })).expect(201);

      expect(Object.keys(res.body).sort()).toEqual(
        ['contactCreated', 'contactId', 'conversationCreated', 'conversationId', 'duplicate', 'identityCreated', 'messageCreated', 'messageId'],
      );
      const text = JSON.stringify(res.body);
      for (const internal of ['CONTEUDO-PRIVADO', '5541999999999', 'privado@example.com', tenantA, credA.secret]) expect(text).not.toContain(internal);
    });

    it('B) repeating the same event -> 200, same messageId, nothing duplicated', async () => {
      const body = event({ externalMessageId: 'wamid-repeat' });
      const first = await post(credA, body).expect(201);

      const again = await post(credA, { ...body, content: 'EDITADO' }).expect(200);

      expect(again.body).toMatchObject({
        duplicate: true,
        messageId: first.body.messageId,
        conversationId: first.body.conversationId,
        contactId: first.body.contactId,
        messageCreated: false,
        conversationCreated: false,
        contactCreated: false,
        identityCreated: false,
      });
      expect(await counts(tenantA)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
      const message: any = await run(tenantA, (tx) => tx.message.findUnique({ where: { id: first.body.messageId } }));
      expect(message.body).toBe('Olá, preciso de um orçamento'); // first event wins
    });

    it('B2) 8 simultaneous deliveries of the same event -> exactly one 201, the rest 200, one message', async () => {
      const body = event({ externalMessageId: 'wamid-parallel' });

      const responses = await Promise.all(Array.from({ length: 8 }, () => post(credA, body)));

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(7);
      expect(new Set(responses.map((r) => r.body.messageId)).size).toBe(1);
      expect(await counts(tenantA)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
    });

    it('C) the same externalMessageId in tenant B is independent -> 201', async () => {
      const body = event({ externalMessageId: 'wamid-shared' });
      const a = await post(credA, body).expect(201);

      const b = await post(credBWa, body).expect(201);

      expect(b.body.duplicate).toBe(false);
      expect(b.body.messageId).not.toBe(a.body.messageId);
      expect(b.body.conversationId).not.toBe(a.body.conversationId);
      expect(await counts(tenantA)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
      expect(await counts(tenantB)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
    });

    it('the created conversation is what the existing Inbox service lists for that tenant', async () => {
      const { ConversationsService } = await import('../src/modules/conversations/conversations.service');
      const res = await post(credA, event({ contact: { name: 'Ana' } })).expect(201);

      const list = await app.get(ConversationsService).list({ tenantId: tenantA, userId: randomUUID(), roleCodes: ['ADMIN'] }, {} as any);
      const other = await app.get(ConversationsService).list({ tenantId: tenantB, userId: randomUUID(), roleCodes: ['ADMIN'] }, {} as any);

      expect(list.items.find((c) => c.id === res.body.conversationId)).toMatchObject({ contactName: 'Ana', channel: 'WHATSAPP', state: 'AI_ATENDENDO' });
      expect(other.items).toHaveLength(0);
    });
  });

  describe('authentication (401)', () => {
    it('F) no credential -> 401, with a challenge, and nothing written', async () => {
      const res = await post(null, event()).expect(401);

      expect(res.headers['www-authenticate']).toMatch(/^Basic realm=/);
      expect(res.body.message).toBe('Credencial de serviço inválida.');
      expect(await counts(tenantA)).toEqual(NOTHING);
    });

    it('G) unknown keyId -> 401 and H) wrong secret -> 401, indistinguishable', async () => {
      const unknown = await post({ keyId: 'no-such-key', secret: credA.secret }, event()).expect(401);
      const wrong = await post({ keyId: credA.keyId, secret: secret() }, event()).expect(401);
      const crossed = await post({ keyId: credA.keyId, secret: credB.secret }, event()).expect(401);

      expect(unknown.body).toEqual(wrong.body);
      expect(unknown.body).toEqual(crossed.body);
      expect(unknown.body.message).toBe('Credencial de serviço inválida.');
      expect(await counts(tenantA)).toEqual(NOTHING);
    });

    it.each([
      ['Bearer scheme', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc'],
      ['not base64', 'Basic ***'],
      ['no separator', `Basic ${Buffer.from('onlykey').toString('base64')}`],
      ['empty secret', `Basic ${Buffer.from(`${credA.keyId}:`).toString('base64')}`],
      ['raw secret, no scheme', credA.secret],
    ])('a malformed credential (%s) -> 401', async (_name, authorization) => {
      await client().post('/api/conversations/inbound').set('Authorization', authorization).send(event()).expect(401);
    });

    it('authentication happens BEFORE validation: an invalid body without credentials is 401, not 400', async () => {
      await post(null, { tenantId: 'x', nonsense: true }).expect(401);
    });

    it('a query-string or header tenantId is not a credential either', async () => {
      await client().post(`/api/conversations/inbound?tenantId=${tenantA}`)
        .set('X-Tenant-Id', tenantA)
        .send(event())
        .expect(401);
    });
  });

  describe('validation (400)', () => {
    it('D) tenantId in the body -> 400, nothing created in either tenant', async () => {
      await post(credA, event({ tenantId: tenantB })).expect(400);
      await post(credA, event({ tenantId: tenantA })).expect(400); // even its own

      expect(await counts(tenantA)).toEqual(NOTHING);
      expect(await counts(tenantB)).toEqual(NOTHING);
    });

    it('E) channel in the body -> 400', async () => {
      await post(credA, event({ channel: 'INSTAGRAM' })).expect(400);
      await post(credA, event({ channel: 'WHATSAPP' })).expect(400); // even its own

      expect(await counts(tenantA)).toEqual(NOTHING);
    });

    it('I) invalid bodies -> 400', async () => {
      await post(credA, {}).expect(400);
      await post(credA, { content: 'só isso' }).expect(400);
      await post(credA, event({ externalContactId: 42 })).expect(400);
      await post(credA, []).expect(400);
      await client().post('/api/conversations/inbound')
        .set('Authorization', basic(credA))
        .set('Content-Type', 'application/json')
        .send('{"broken":')
        .expect(400);

      expect(await counts(tenantA)).toEqual(NOTHING);
    });

    it('K) an invalid phone -> 400 and nothing is written', async () => {
      const res = await post(credA, event({ contact: { phone: '12345' } })).expect(400);

      expect(res.body.message).toBe('Telefone inválido.');
      expect(await counts(tenantA)).toEqual(NOTHING);
    });

    it('L) empty content -> 400', async () => {
      await post(credA, event({ content: '' })).expect(400);
    });

    it('M) content over 4000 characters -> 400 (4000 is accepted)', async () => {
      await post(credA, event({ content: 'x'.repeat(4001) })).expect(400);
      await post(credA, event({ content: 'x'.repeat(4000) })).expect(201);
    });

    it('N) an invalid occurredAt -> 400', async () => {
      await post(credA, event({ occurredAt: 'ontem' })).expect(400);
      await post(credA, event({ occurredAt: '2024-01-01T10:00:00' })).expect(400); // no UTC offset
    });

    it('O) an unknown field -> 400', async () => {
      await post(credA, event({ surprise: true })).expect(400);
      await post(credA, event({ contact: { name: 'Ana', role: 'admin' } })).expect(400);
    });

    it('validation errors do not echo the submitted values', async () => {
      const res = await post(credA, event({ content: '', contact: { email: 'segredo-do-cliente' } })).expect(400);

      expect(JSON.stringify(res.body)).not.toContain('segredo-do-cliente');
    });
  });

  describe('spoofing', () => {
    it('SPOOFING) credential A never creates data in tenant B or on INSTAGRAM, whatever the body says', async () => {
      // credential A = tenant A + WHATSAPP; credential B = tenant B + INSTAGRAM
      const attacks = [
        event({ tenantId: tenantB }),
        event({ channel: 'INSTAGRAM' }),
        event({ tenantId: tenantB, channel: 'INSTAGRAM' }),
        event({ contact: { tenantId: tenantB } as any }),
        event({ contact: { channel: 'INSTAGRAM' } as any }),
      ];
      for (const attack of attacks) await post(credA, attack).expect(400);
      // ...and the same from the other credential
      await post(credB, event({ tenantId: tenantA })).expect(400);
      await post(credB, event({ channel: 'WHATSAPP' })).expect(400);
      // a tenant id in the query string / headers is inert too
      const viaQuery = await client().post(`/api/conversations/inbound?tenantId=${tenantB}&channel=INSTAGRAM`)
        .set('Authorization', basic(credA))
        .set('X-Tenant-Id', tenantB)
        .send(event())
        .expect(201);

      expect(await counts(tenantB)).toEqual(NOTHING); // nothing leaked into B by any attempt
      expect(await counts(tenantA)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
      const stored: any = await run(tenantA, (tx) => tx.conversation.findUnique({ where: { id: viaQuery.body.conversationId } }));
      expect(stored).toMatchObject({ tenantId: tenantA, channel: 'WHATSAPP' });

      // credential B creates in B / INSTAGRAM only
      const fromB = await post(credB, event({ externalContactId: 'ig-1' })).expect(201);
      const storedB: any = await run(tenantB, (tx) => tx.conversation.findUnique({ where: { id: fromB.body.conversationId } }));
      expect(storedB).toMatchObject({ tenantId: tenantB, channel: 'INSTAGRAM' });
      expect(await run(tenantA, (tx) => tx.conversation.count({ where: { channel: 'INSTAGRAM' } }))).toBe(0);
      expect(await counts(tenantA)).toEqual({ contacts: 1, conversations: 1, messages: 1 });
    });

    it('one tenant has separate credentials per channel, each pinned to its own channel', async () => {
      const wa = await post(credA, event({ externalContactId: 'same-id' })).expect(201);
      const web = await post(credAWeb, event({ externalContactId: 'same-id' })).expect(201);

      const rows: any[] = await run(tenantA, (tx) =>
        tx.conversation.findMany({ where: { id: { in: [wa.body.conversationId, web.body.conversationId] } } }),
      );
      expect(rows.map((r) => r.channel).sort()).toEqual(['WEBCHAT', 'WHATSAPP']);
    });
  });

  describe('errors from the ingress service keep their meaning', () => {
    it('J) a thread id held by an OPEN conversation of another Contact -> 409, nothing reassigned', async () => {
      const first = await post(credAWeb, event({ externalContactId: 'visitor-1', externalConversationId: 'thread-1' })).expect(201);

      const res = await post(credAWeb, event({ externalContactId: 'visitor-2', externalConversationId: 'thread-1' })).expect(409);

      expect(res.body.statusCode).toBe(409);
      const row: any = await run(tenantA, (tx) => tx.conversation.findUnique({ where: { id: first.body.conversationId } }));
      expect(row.contactId).toBe(first.body.contactId);
      expect((await counts(tenantA)).conversations).toBe(1);
    });

    it('the same message id used on another channel of the tenant -> 409 (not silently dropped)', async () => {
      await post(credA, event({ externalMessageId: 'clash' })).expect(201);

      await post(credAWeb, event({ externalMessageId: 'clash', externalContactId: 'v-1' })).expect(409);
    });

    it('an unexpected error -> generic 500 that does not leak the error or the customer data', async () => {
      const { ConversationIngressService } = await import('../src/modules/conversations/conversation-ingress.service');
      jest.spyOn(app.get(ConversationIngressService), 'ingest').mockRejectedValueOnce(
        new Error('Invalid `prisma.message.create()` invocation: body: "CONTEUDO-PRIVADO"'),
      );

      const res = await post(credA, event({ content: 'CONTEUDO-PRIVADO' })).expect(500);

      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(logged.join('\n')).toContain('inbound.error');
      expect(logged.join('\n')).not.toContain('CONTEUDO-PRIVADO');
    });
  });

  describe('logging', () => {
    it('no secret, keyId of a failed attempt, or customer data reaches the application logs', async () => {
      const wrong = secret();
      await post(credA, event({ content: 'CONTEUDO-PRIVADO', contact: { name: 'Nome Privado', phone: '+5541988887777' } })).expect(201);
      await post(credA, event({ content: 'CONTEUDO-PRIVADO', contact: { phone: '12345' } })).expect(400);
      await post({ keyId: 'attacker-key', secret: wrong }, event()).expect(401);
      await post({ keyId: credA.keyId, secret: wrong }, event()).expect(401);

      const all = logged.join('\n');
      expect(all).toContain('inbound.message');
      expect(all).toContain('inbound.auth_failed');
      for (const sensitive of [...ALL.map((c) => c.secret), wrong, 'attacker-key', 'CONTEUDO-PRIVADO', 'Nome Privado', '5541988887777']) {
        expect(all).not.toContain(sensitive);
      }
    });
  });

  describe('existing Inbox contract', () => {
    it('the user-facing conversation routes still require the user JWT (the service credential is not accepted there)', async () => {
      await client().get('/api/conversations').set('Authorization', basic(credA)).expect(401);
      await client().get('/api/conversations').expect(401);
      await client().get(`/api/conversations/${randomUUID()}/messages`).set('Authorization', basic(credA)).expect(401);
    });
  });
});

describe('rate limiting of POST /api/conversations/inbound (real ThrottlerGuard)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    app = await createApp(); // its own app: the in-memory counter must not leak into the other tests
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  // ~600 requests: they go over ONE keep-alive connection (fetch). supertest opens a fresh
  // ephemeral listener per call, and at this volume Node 24 on Windows crashes the Jest
  // worker natively (0xC0000409) - reproducible with plain GET /api/health, unrelated to this endpoint.
  const send = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${url}${path}`, init);
    await res.arrayBuffer();
    return res;
  };
  const inbound = () => send('/api/conversations/inbound', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  it('answers 429 once a client passes the limit, and only on this endpoint', async () => {
    const { INBOUND_RATE_LIMIT } = await import('../src/modules/conversations/inbound/conversation-inbound.controller');

    const statuses: number[] = [];
    for (let i = 0; i < INBOUND_RATE_LIMIT.limit + 5; i++) statuses.push((await inbound()).status);

    expect(statuses.slice(0, INBOUND_RATE_LIMIT.limit).every((s) => s === 401)).toBe(true); // throttling counts unauthenticated calls too
    expect(statuses.slice(INBOUND_RATE_LIMIT.limit)).toEqual([429, 429, 429, 429, 429]);
    const blocked = await inbound();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();

    // Not global: other routes are unaffected by this counter.
    expect((await send('/api/health')).status).toBe(200);
  }, 120_000);
});

describe('startup with an invalid INBOUND_SERVICE_CREDENTIALS', () => {
  const leaky = secret();

  // A real child process: ConfigModule validates while the module is being
  // loaded, and a throw there kills a Jest worker instead of being catchable.
  const boot = (value: string) =>
    spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', "require('./src/config/app-config.module')"], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, INBOUND_SERVICE_CREDENTIALS: value },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('exits non-zero with a clear message that does not contain the secret', () => {
    const bad = boot(JSON.stringify([{ keyId: 'k-1234', tenantId: 'not-a-uuid', channel: 'WHATSAPP', secret: leaky }]));

    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('INBOUND_SERVICE_CREDENTIALS is invalid');
    expect(bad.stderr).toContain('tenantId must be a UUID');
    expect(bad.stderr).not.toContain(leaky);
    expect(bad.stdout).not.toContain(leaky);
  }, 90_000);

  it('a value that is not even JSON does not get quoted back either', () => {
    const bad = boot(`oops ${leaky}`);

    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('value is not valid JSON');
    expect(bad.stderr).not.toContain(leaky);
  }, 90_000);

  it('a valid configuration boots the config module', () => {
    const ok = boot(JSON.stringify([{ keyId: 'k-1234', tenantId: randomUUID(), channel: 'WHATSAPP', secret: leaky }]));

    expect(ok.status).toBe(0);
  }, 90_000);
});
