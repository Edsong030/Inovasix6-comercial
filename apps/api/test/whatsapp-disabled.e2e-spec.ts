import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConversationChannel } from '@prisma/client';
import { Agent } from 'node:http';
import * as request from 'supertest';
import { createGlobalValidationPipe } from '../src/common/http/global-validation.pipe';

/**
 * The default configuration: WHATSAPP_CLOUD_ENABLED is unset, so the WhatsApp
 * integration must be completely inert. It proves that adding this code to an
 * environment changes nothing until someone switches it on: the webhook does
 * not exist, no adapter is registered (WHATSAPP messages stay PENDING exactly as
 * before) and Meta can never be called.
 */
let AppModule: typeof import('../src/app.module').AppModule;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  for (const name of ['WHATSAPP_CLOUD_ENABLED', 'WHATSAPP_META_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WHATSAPP_CLOUD_ACCOUNTS', 'WHATSAPP_GRAPH_API_BASE_URL']) delete process.env[name];
  ({ AppModule } = await import('../src/app.module'));
});

describe('WhatsApp integration disabled (the default)', () => {
  let app: INestApplication;
  let url: string;
  const keepAlive = new Agent({ keepAlive: true, maxSockets: 4 });

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    // main.ts registers the raw-body parser only when the integration is enabled
    const { configureWhatsAppWebhookBodyParser } = await import('../src/modules/whatsapp/webhook/whatsapp-webhook.http');
    configureWhatsAppWebhookBodyParser(app, false);
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  });

  afterAll(async () => {
    keepAlive.destroy();
    await app.close();
    jest.restoreAllMocks();
  });

  it('the webhook endpoints do not exist: GET and POST answer 404, like an unknown route', async () => {
    await request(url).get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=123').agent(keepAlive).expect(404);
    await request(url).post('/api/webhooks/whatsapp').agent(keepAlive).set('X-Hub-Signature-256', 'sha256=' + 'a'.repeat(64)).send({ object: 'whatsapp_business_account' }).expect(404);
  });

  it('the 404 leaks nothing about the integration and does not echo a challenge', async () => {
    const res = await request(url).get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=987654321').agent(keepAlive);

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('987654321');
  });

  it('no outbound adapter is registered for WHATSAPP (or any channel): Meta can never be called, messages stay PENDING', async () => {
    const { OutboundAdapterRegistry } = await import('../src/modules/delivery/outbound-adapter.registry');
    const registry = app.get(OutboundAdapterRegistry);

    expect(registry.channels()).toEqual([]);
    expect(registry.get(ConversationChannel.WHATSAPP)).toBeUndefined();
  });

  it('the polling worker is off too', async () => {
    const { OutboundWorker } = await import('../src/modules/delivery/outbound-worker.service');

    expect(app.get(OutboundWorker).isRunning).toBe(false);
  });
});
