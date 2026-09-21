import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { createGlobalValidationPipe } from '../../../common/http/global-validation.pipe';
import { InvalidPhoneNumberException } from '../../contacts/phone-number';
import type { ConversationIngressResult } from '../conversation-ingress.service';
import { ConversationInboundController, INBOUND_RATE_LIMIT } from './conversation-inbound.controller';
import { InboundMessageDto } from './dto/inbound-message.dto';
import type { AuthenticatedInboundService } from './inbound-credentials.service';
import { InboundExceptionFilter } from './inbound-exception.filter';
import { InboundServiceGuard } from './inbound-service.guard';

const CALLER: AuthenticatedInboundService = { tenantId: randomUUID(), channel: 'WHATSAPP', keyId: 'test-tenant-a-whatsapp' };

const validBody = (over: Record<string, unknown> = {}) => ({
  externalContactId: 'wa-1',
  externalMessageId: 'wamid-1',
  content: 'Olá, preciso de um orçamento',
  ...over,
});

/** Runs the same pipe main.ts installs, as Nest does before the handler. */
async function bind(body: unknown): Promise<InboundMessageDto> {
  return createGlobalValidationPipe().transform(body, { type: 'body', metatype: InboundMessageDto }) as Promise<InboundMessageDto>;
}

function result(over: Partial<ConversationIngressResult> = {}): ConversationIngressResult {
  return {
    contact: { id: 'contact-1' },
    conversation: { id: 'conversation-1' },
    message: { id: 'message-1' },
    contactCreated: true,
    identityCreated: true,
    conversationCreated: true,
    messageCreated: true,
    duplicate: false,
    ...over,
  } as unknown as ConversationIngressResult;
}

describe('InboundMessageDto validation (global ValidationPipe)', () => {
  it('accepts a minimal and a complete body', async () => {
    await expect(bind(validBody())).resolves.toBeInstanceOf(InboundMessageDto);
    await expect(
      bind(
        validBody({
          externalConversationId: 'thread-1',
          occurredAt: '2024-01-01T10:00:00Z',
          contact: { name: 'Ana', phone: '+5541999999999', email: 'ana@example.com', defaultCountry: 'BR' },
        }),
      ),
    ).resolves.toBeInstanceOf(InboundMessageDto);
  });

  it('8. rejects tenantId in the body with 400 (not silently ignored)', async () => {
    const error = await bind(validBody({ tenantId: randomUUID() })).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(error.getResponse())).toContain('property tenantId should not exist');
  });

  it('9. rejects channel in the body with 400', async () => {
    const error = await bind(validBody({ channel: 'INSTAGRAM' })).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify(error.getResponse())).toContain('property channel should not exist');
  });

  it('rejects tenantId/channel smuggled inside the nested contact object too', async () => {
    await expect(bind(validBody({ contact: { name: 'Ana', tenantId: randomUUID() } }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(bind(validBody({ contact: { channel: 'WEBCHAT' } }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects any unknown field', async () => {
    await expect(bind(validBody({ surprise: 1 }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['missing externalContactId', { externalContactId: undefined }],
    ['missing externalMessageId', { externalMessageId: undefined }],
    ['missing content', { content: undefined }],
    ['empty externalMessageId', { externalMessageId: '' }],
    ['empty content', { content: '' }],
    ['content over 4000 characters', { content: 'x'.repeat(4001) }],
    ['externalContactId over 255', { externalContactId: 'x'.repeat(256) }],
    ['externalMessageId over 255', { externalMessageId: 'x'.repeat(256) }],
    ['externalConversationId over 255', { externalConversationId: 'x'.repeat(256) }],
    ['non-string content', { content: 12345 }],
    ['non-string externalMessageId', { externalMessageId: { $ne: null } }],
    ['name over 200', { contact: { name: 'x'.repeat(201) } }],
    ['phone over 32', { contact: { phone: '1'.repeat(33) } }],
    ['email over 254', { contact: { email: `${'x'.repeat(250)}@a.co` } }],
    ['invalid email', { contact: { email: 'not-an-email' } }],
    ['unknown defaultCountry', { contact: { defaultCountry: 'ZZ' } }],
    ['lowercase defaultCountry', { contact: { defaultCountry: 'br' } }],
    ['invalid occurredAt', { occurredAt: 'yesterday' }],
    ['non-existent occurredAt date', { occurredAt: '2024-02-31T10:00:00Z' }],
    ['occurredAt without UTC offset', { occurredAt: '2024-01-01T10:00:00' }],
    ['date-only occurredAt', { occurredAt: '2024-01-01' }],
    ['numeric occurredAt', { occurredAt: 1704103200000 }],
  ])('rejects %s with 400', async (_name, over) => {
    await expect(bind(validBody(over))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts content of exactly 1 and 4000 characters, ids of exactly 255', async () => {
    await expect(bind(validBody({ content: 'x' }))).resolves.toBeDefined();
    await expect(bind(validBody({ content: 'x'.repeat(4000) }))).resolves.toBeDefined();
    await expect(bind(validBody({ externalMessageId: 'x'.repeat(255) }))).resolves.toBeDefined();
  });

  it('accepts UTC offsets in either form', async () => {
    for (const occurredAt of ['2024-01-01T10:00:00Z', '2024-01-01T10:00:00.123Z', '2024-01-01T07:00:00-03:00', '2024-01-01T10:00:00+0000']) {
      await expect(bind(validBody({ occurredAt }))).resolves.toBeDefined();
    }
  });

  it('the validation error never echoes submitted values', async () => {
    const error = await bind(validBody({ content: '', contact: { phone: '1'.repeat(33), email: 'secret-person@nope' } })).catch((e) => e);

    const text = JSON.stringify(error.getResponse());
    expect(text).not.toContain('secret-person');
    expect(text).not.toContain('1'.repeat(33));
  });

  it('the app pipe has the options the tenant/channel protection relies on', () => {
    const pipe = createGlobalValidationPipe() as ValidationPipe & { validatorOptions: Record<string, unknown>; isTransformEnabled: boolean };

    expect(pipe.validatorOptions).toMatchObject({ whitelist: true, forbidNonWhitelisted: true });
    expect(pipe.isTransformEnabled).toBe(true);
  });
});

describe('ConversationInboundController', () => {
  let ingest: jest.Mock;
  let controller: ConversationInboundController;
  let res: { status: jest.Mock };
  let logged: string[];

  beforeEach(() => {
    ingest = jest.fn().mockResolvedValue(result());
    controller = new ConversationInboundController({ ingest } as any);
    res = { status: jest.fn() };
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
  });

  afterEach(() => jest.restoreAllMocks());

  it('10. uses the tenantId of the credential, never one that came with the body', async () => {
    const dto = await bind(validBody());
    // even if a tenantId got onto the object by some other path, it is not read
    (dto as any).tenantId = 'attacker-tenant';

    await controller.receive(CALLER, dto, res as any);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0].tenantId).toBe(CALLER.tenantId);
    expect(JSON.stringify(ingest.mock.calls[0][0])).not.toContain('attacker-tenant');
  });

  it('11. uses the channel of the credential, never one that came with the body', async () => {
    const dto = await bind(validBody());
    (dto as any).channel = 'INSTAGRAM';

    await controller.receive(CALLER, dto, res as any);

    expect(ingest.mock.calls[0][0].channel).toBe('WHATSAPP');
  });

  it('delegates the event data to the ingress service and converts occurredAt to a Date', async () => {
    const dto = await bind(
      validBody({
        externalConversationId: 'thread-1',
        occurredAt: '2024-01-01T10:00:00Z',
        contact: { name: 'Ana', phone: '(41) 99999-9999', email: 'ana@example.com', defaultCountry: 'BR' },
      }),
    );

    await controller.receive(CALLER, dto, res as any);

    expect(ingest).toHaveBeenCalledWith({
      tenantId: CALLER.tenantId,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      externalConversationId: 'thread-1',
      externalMessageId: 'wamid-1',
      contact: { name: 'Ana', phone: '(41) 99999-9999', email: 'ana@example.com', defaultCountry: 'BR' },
      content: 'Olá, preciso de um orçamento',
      occurredAt: new Date('2024-01-01T10:00:00Z'),
    });
  });

  it('passes occurredAt/contact as undefined when absent (the ingress owns the defaults)', async () => {
    await controller.receive(CALLER, await bind(validBody()), res as any);

    expect(ingest.mock.calls[0][0]).toMatchObject({ occurredAt: undefined, contact: undefined, externalConversationId: undefined });
  });

  it('12. a NEW message answers 201', async () => {
    await controller.receive(CALLER, await bind(validBody()), res as any);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('13. a duplicate (redelivery) answers 200', async () => {
    ingest.mockResolvedValue(result({ duplicate: true, messageCreated: false, conversationCreated: false, contactCreated: false, identityCreated: false }));

    const body = await controller.receive(CALLER, await bind(validBody()), res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body).toMatchObject({ duplicate: true, messageCreated: false });
  });

  it('answers with ids and flags only, not internal objects', async () => {
    const full = result({
      contact: { id: 'c-1', phoneE164: '+5541999999999', email: 'a@b.co', tenantId: 't' } as any,
      conversation: { id: 'v-1', tenantId: 't', assignedUserId: 'u' } as any,
      message: { id: 'm-1', body: 'texto do cliente', tenantId: 't' } as any,
    });
    ingest.mockResolvedValue(full);

    const body = await controller.receive(CALLER, await bind(validBody()), res as any);

    expect(body).toEqual({
      duplicate: false,
      contactId: 'c-1',
      conversationId: 'v-1',
      messageId: 'm-1',
      contactCreated: true,
      identityCreated: true,
      conversationCreated: true,
      messageCreated: true,
    });
    const text = JSON.stringify(body);
    for (const internal of ['+5541999999999', 'a@b.co', 'texto do cliente', 'tenantId', 'assignedUserId']) {
      expect(text).not.toContain(internal);
    }
  });

  it('14/15/16. propagates the ingress errors unchanged (409 stays 409, phone 400 stays 400, unexpected stays unexpected)', async () => {
    const dto = await bind(validBody());

    ingest.mockRejectedValueOnce(new ConflictException('Conversa externa pertence a outro contato.'));
    await expect(controller.receive(CALLER, dto, res as any)).rejects.toMatchObject({ status: 409 });

    ingest.mockRejectedValueOnce(new InvalidPhoneNumberException());
    await expect(controller.receive(CALLER, dto, res as any)).rejects.toMatchObject({ status: 400 });

    const boom = new Error('connection reset');
    ingest.mockRejectedValueOnce(boom);
    await expect(controller.receive(CALLER, dto, res as any)).rejects.toBe(boom);

    expect(res.status).not.toHaveBeenCalled();
  });

  it('logs identifiers only: no content, phone, email, name or secret', async () => {
    const dto = await bind(
      validBody({ content: 'CONTEUDO-PRIVADO', contact: { name: 'Nome Privado', phone: '+5541988887777', email: 'privado@example.com' } }),
    );

    await controller.receive(CALLER, dto, res as any);

    const line = logged.join('\n');
    expect(line).toContain('inbound.message');
    expect(line).toContain('wamid-1');
    expect(line).toContain(CALLER.tenantId);
    for (const pii of ['CONTEUDO-PRIVADO', 'Nome Privado', '5541988887777', 'privado@example.com']) expect(line).not.toContain(pii);
  });

  it('protects the route with the rate limit first, then the service credential; never the user JWT guard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ConversationInboundController) as unknown[];

    expect(guards).toEqual([ThrottlerGuard, InboundServiceGuard]);
    expect(INBOUND_RATE_LIMIT.limit).toBeGreaterThan(0);
  });
});

describe('InboundExceptionFilter', () => {
  const filter = new InboundExceptionFilter();
  let json: jest.Mock;
  let status: jest.Mock;
  let logged: string[];

  const host = (inboundService?: AuthenticatedInboundService) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ inboundService }),
        getResponse: () => ({ status, json }),
      }),
    }) as unknown as ArgumentsHost;

  beforeEach(() => {
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    logged = [];
    for (const level of ['warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps the status and body of HTTP exceptions (400/401/403/409/429...)', () => {
    for (const exception of [new ConflictException('x'), new BadRequestException(['a must be b']), new ForbiddenException(), new HttpException('Too Many Requests', 429)]) {
      filter.catch(exception, host(CALLER));

      // same shape as Nest's default handler: object bodies as-is, string bodies wrapped
      const body = exception.getResponse();
      expect(status).toHaveBeenLastCalledWith(exception.getStatus());
      expect(json).toHaveBeenLastCalledWith(typeof body === 'string' ? { statusCode: exception.getStatus(), message: body } : body);
    }
  });

  it('16. an unexpected error becomes a generic 500 and the error message is neither returned nor logged', () => {
    const leaky = new Error('Invalid `prisma.message.create()` invocation: data: { body: "CONTEUDO-PRIVADO", phone: "+5541988887777" }');
    (leaky as any).code = 'P2010';

    filter.catch(leaky, host(CALLER));

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
    const line = logged.join('\n');
    expect(line).toContain('inbound.error');
    expect(line).toContain('P2010');
    expect(line).toContain(CALLER.tenantId);
    for (const pii of ['CONTEUDO-PRIVADO', '5541988887777', 'prisma.message.create']) {
      expect(line).not.toContain(pii);
      expect(JSON.stringify(json.mock.calls)).not.toContain(pii);
    }
  });

  it('a non-Error throw is still a generic 500', () => {
    filter.catch('boom', host());
    filter.catch(null, host());

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenLastCalledWith({ statusCode: 500, message: 'Internal server error' });
  });

  it('an explicit InternalServerErrorException keeps its HTTP semantics', () => {
    filter.catch(new InternalServerErrorException(), host(CALLER));

    expect(status).toHaveBeenCalledWith(500);
  });
});
