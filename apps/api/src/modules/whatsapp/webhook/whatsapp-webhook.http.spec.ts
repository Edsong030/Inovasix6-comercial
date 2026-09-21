import type { INestApplication } from '@nestjs/common';
import * as express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import pinoHttp from 'pino-http';
import * as request from 'supertest';
import { pinoHttpOptions } from '../../../common/http/pino-http.options';
import { WHATSAPP_WEBHOOK_MAX_BYTES, WHATSAPP_WEBHOOK_ROUTE, configureWhatsAppWebhookBodyParser, webhookSafeRequestSerializer } from './whatsapp-webhook.http';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** A minimal Express app wired exactly as main.ts wires the real one (the webhook parser first, then Nest's usual JSON parser). */
function makeApp(enabled = true) {
  const app = express();
  configureWhatsAppWebhookBodyParser({ use: (...args: unknown[]) => (app.use as (...a: unknown[]) => void)(...args) } as unknown as INestApplication, enabled);
  app.use(express.json()); // Nest's default JSON parser
  app.post(WHATSAPP_WEBHOOK_ROUTE, (req, res) => res.json({ isBuffer: Buffer.isBuffer(req.body), length: Buffer.isBuffer(req.body) ? req.body.length : null, sha256: Buffer.isBuffer(req.body) ? sha256(req.body) : null }));
  app.get(WHATSAPP_WEBHOOK_ROUTE, (req, res) => res.json({ query: req.query, body: req.body ?? null }));
  app.post('/api/other', (req, res) => res.json({ isBuffer: Buffer.isBuffer(req.body), body: req.body }));
  return app;
}

describe('WhatsApp webhook raw body', () => {
  it('hands the route the EXACT bytes received (odd whitespace, key order, unicode escapes and non-ASCII intact)', async () => {
    const bytes = Buffer.from('{ "b" : 1,\n "a":"\\u00e1 á \u{1F600}" ,  "object":"whatsapp_business_account" }\n', 'utf8');

    const res = await request(makeApp()).post(WHATSAPP_WEBHOOK_ROUTE).set('Content-Type', 'application/json').send(bytes.toString('utf8')).expect(200); // a string: superagent JSON-encodes a Buffer

    expect(res.body).toEqual({ isBuffer: true, length: bytes.length, sha256: sha256(bytes) });
    // and that re-serializing the parsed JSON would NOT have produced those bytes (why raw is required)
    expect(Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')))).equals(bytes)).toBe(false);
  });

  it('does not depend on the content type: the signature, not the header, authenticates', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream', 'application/json; charset=utf-8']) {
      const res = await request(makeApp()).post(WHATSAPP_WEBHOOK_ROUTE).set('Content-Type', type).send('{"x":1}').expect(200);
      expect(res.body).toMatchObject({ isBuffer: true, length: 7 });
    }
  });

  it('an empty body is an empty Buffer (the signature guard then rejects it), not a crash', async () => {
    const res = await request(makeApp()).post(WHATSAPP_WEBHOOK_ROUTE).expect(200);

    expect(res.body).toMatchObject({ isBuffer: true, length: 0 });
  });

  it('accepts up to 3 MB (the maximum Meta documents) and answers 413 above it, as plain JSON', async () => {
    const atLimit = 'a'.repeat(WHATSAPP_WEBHOOK_MAX_BYTES);
    const over = 'a'.repeat(WHATSAPP_WEBHOOK_MAX_BYTES + 1);

    await request(makeApp()).post(WHATSAPP_WEBHOOK_ROUTE).set('Content-Type', 'application/json').send(atLimit).expect(200);
    const res = await request(makeApp()).post(WHATSAPP_WEBHOOK_ROUTE).set('Content-Type', 'application/json').send(over).expect(413);

    expect(res.body).toEqual({ statusCode: 413, message: 'Payload too large' });
    expect(res.text).not.toMatch(/at .*\.js|node_modules|PayloadTooLargeError/); // no stack trace
  });

  it('refuses a compressed body (no decompression, so no decompression bomb) with a JSON error', async () => {
    const res = await request(makeApp()).post(WHATSAPP_WEBHOOK_ROUTE).set('Content-Encoding', 'gzip').set('Content-Type', 'application/json').send('not really gzip').expect(415);

    expect(res.body).toMatchObject({ statusCode: 415 });
    expect(res.text).not.toMatch(/node_modules|Error:/);
  });

  it('touches only POST on this route: the GET handshake keeps its query and has no body', async () => {
    const res = await request(makeApp()).get(`${WHATSAPP_WEBHOOK_ROUTE}?hub.mode=subscribe&hub.challenge=123`).expect(200);

    expect(res.body.query).toMatchObject({ 'hub.mode': 'subscribe', 'hub.challenge': '123' });
  });

  it('leaves every other endpoint on its normal JSON parser', async () => {
    const res = await request(makeApp()).post('/api/other').send({ a: 1 }).expect(200);

    expect(res.body).toEqual({ isBuffer: false, body: { a: 1 } });
  });

  it('registers nothing while the integration is disabled: a disabled deployment does not buffer 3 MB for a 404 route', async () => {
    const res = await request(makeApp(false)).post(WHATSAPP_WEBHOOK_ROUTE).set('Content-Type', 'application/json').send({ a: 1 }).expect(200);

    expect(res.body.isBuffer).toBe(false); // Nest's default parser handled it
  });
});

describe('request logging of the webhook route (real pino-http options)', () => {
  const VERIFY_TOKEN = randomBytes(16).toString('hex');
  const SIGNATURE = `sha256=${randomBytes(32).toString('hex')}`;

  function loggedLines() {
    const lines: Record<string, any>[] = [];
    const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(JSON.parse(chunk.toString())), cb()) });
    const app = express();
    app.use(pinoHttp({ level: 'info', ...pinoHttpOptions }, stream));
    app.use((_req, res) => void res.status(200).send('ok'));
    return { app, lines };
  }

  it('the GET handshake never writes the verify token (URL, query or anywhere) to the log', async () => {
    const { app, lines } = loggedLines();

    await request(app).get(`${WHATSAPP_WEBHOOK_ROUTE}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`).expect(200);

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(VERIFY_TOKEN);
    expect(JSON.stringify(lines)).not.toContain('hub.verify_token');
    expect(lines[0].req.url).toBe(WHATSAPP_WEBHOOK_ROUTE);
    expect(lines[0].req.method).toBe('GET');
  });

  it('the signature header is redacted on POST', async () => {
    const { app, lines } = loggedLines();

    await request(app).post(WHATSAPP_WEBHOOK_ROUTE).set('X-Hub-Signature-256', SIGNATURE).send({ x: 1 }).expect(200);

    expect(JSON.stringify(lines)).not.toContain(SIGNATURE);
    expect(lines[0].req.headers['x-hub-signature-256']).toBe('[Redacted]');
  });

  it('Authorization and cookies stay redacted, as before', async () => {
    const { app, lines } = loggedLines();

    await request(app).get('/api/anything').set('Authorization', 'Bearer SECRET-TOKEN').set('Cookie', 'refresh=SECRET-COOKIE').expect(200);

    expect(JSON.stringify(lines)).not.toMatch(/SECRET-TOKEN|SECRET-COOKIE/);
  });

  it('every OTHER route is logged exactly as before, query string included', async () => {
    const { app, lines } = loggedLines();

    await request(app).get('/api/leads?status=OPEN&page=2').expect(200);

    expect(lines[0].req.url).toBe('/api/leads?status=OPEN&page=2');
  });

  describe('webhookSafeRequestSerializer', () => {
    it('drops the query string from the URL and the parsed query on the webhook route only', () => {
      const req = { id: 1, method: 'GET', url: `${WHATSAPP_WEBHOOK_ROUTE}?hub.verify_token=${VERIFY_TOKEN}`, query: { 'hub.verify_token': VERIFY_TOKEN }, headers: {} };

      const safe = webhookSafeRequestSerializer(req);

      expect(safe.url).toBe(WHATSAPP_WEBHOOK_ROUTE);
      expect(safe.query).toBeUndefined();
      expect(JSON.stringify(safe)).not.toContain(VERIFY_TOKEN);
    });

    it('returns the very same object for any other route', () => {
      const req = { url: '/api/leads?x=1', query: { x: '1' } };
      expect(webhookSafeRequestSerializer(req)).toBe(req);
    });

    it('does not throw on a request without a url', () => {
      expect(() => webhookSafeRequestSerializer({})).not.toThrow();
    });
  });
});
