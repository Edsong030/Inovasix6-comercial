import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationChannel, PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent } from 'node:http';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/common/http/global-validation.pipe';
import { FakeOutboundChannelAdapter } from '../src/modules/delivery/fake-outbound-channel.adapter';
import { OUTBOUND_CHANNEL_ADAPTERS } from '../src/modules/delivery/outbound-adapter.registry';
import { OutboundWorker } from '../src/modules/delivery/outbound-worker.service';
import { makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * The polling worker inside the real application: enabled by configuration, it
 * starts when the app boots, delivers the automatic reply by itself, and stops
 * cleanly with the app. The worker is switched on through the environment
 * BEFORE the application module is imported (configuration is validated once,
 * at import), which is why this lives in its own file.
 */
const tenantA = randomUUID();
const credWa = { keyId: 'ow-a-whatsapp', tenantId: tenantA, channel: 'WHATSAPP', secret: randomBytes(32).toString('hex') };
const basic = (c: { keyId: string; secret: string }) => `Basic ${Buffer.from(`${c.keyId}:${c.secret}`).toString('base64')}`;

let AppModule: typeof import('../src/app.module').AppModule;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.INBOUND_SERVICE_CREDENTIALS = JSON.stringify([credWa]);
  process.env.OUTBOUND_WORKER_ENABLED = 'true';
  process.env.OUTBOUND_POLL_INTERVAL_MS = '200';
  ({ AppModule } = await import('../src/app.module'));
});

afterAll(() => {
  delete process.env.OUTBOUND_WORKER_ENABLED;
  delete process.env.OUTBOUND_POLL_INTERVAL_MS;
});

describe('outbound worker inside the application (HTTP, real Postgres, fake adapter)', () => {
  let app: INestApplication;
  let owner: PrismaClient;
  let url: string;
  const whatsapp = new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP);
  const keepAlive = new Agent({ keepAlive: true, maxSockets: 4 });
  const run = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(owner, tenantId, work);

  beforeAll(async () => {
    owner = makeOwnerClient();
    await run(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantA}::uuid,'outbound-worker-e2e',${`outbound-worker-e2e-${tenantA.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
    });
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OUTBOUND_CHANNEL_ADAPTERS)
      .useValue([whatsapp])
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init(); // onApplicationBootstrap: the worker starts here
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    keepAlive.destroy();
    await run(tenantA, async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantA}::uuid`;
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantA}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantA}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantA}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantA}::uuid`;
      await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantA}::uuid`;
    });
    await owner.$disconnect();
    jest.restoreAllMocks();
  });

  it('starts with the application when enabled, delivers the first-contact reply on its own, and stops cleanly with the app', async () => {
    const worker = app.get(OutboundWorker);
    expect(worker.isRunning).toBe(true);

    const res = await request(url)
      .post('/api/conversations/inbound')
      .agent(keepAlive)
      .set('Authorization', basic(credWa))
      .send({ externalContactId: 'wa-worker', externalMessageId: `m-${randomUUID()}`, content: 'Oi' })
      .expect(201);

    // nobody calls the dispatcher: the worker finds the reply by itself (definer discovery -> claim -> adapter -> SENT)
    const deadline = Date.now() + 10_000;
    let reply: any;
    while (Date.now() < deadline) {
      reply = await run(tenantA, (tx) => tx.message.findFirst({ where: { tenantId: tenantA, conversationId: res.body.conversationId, senderType: 'SYSTEM' } }));
      if (reply?.status === 'SENT') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(reply).toMatchObject({ status: 'SENT', deliveryAttempts: 1, nextAttemptAt: null, leaseToken: null, externalId: whatsapp.accepted[0]?.externalMessageId });
    expect(whatsapp.accepted).toHaveLength(1);

    await app.close(); // shutdown hooks: worker stops before the database goes away
    expect(worker.isRunning).toBe(false);
    const callsAtClose = whatsapp.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(whatsapp.calls).toHaveLength(callsAtClose);
  });
});
