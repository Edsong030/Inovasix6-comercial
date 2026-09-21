import { BadRequestException, ConflictException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfigService } from '../../../config/app-config.service';
import { WhatsAppCloudAccount } from '../../../config/whatsapp-cloud';
import type { ConversationIntakeService } from '../../conversations/conversation-intake.service';
import { InvalidPhoneNumberException } from '../../contacts/phone-number';
import { WhatsAppAccountResolver } from '../whatsapp-account.resolver';
import type { WhatsAppStatusService } from './whatsapp-status.service';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const PHONE_ID_A = '100000000000001';
const PHONE_ID_B = '200000000000002';
const VERIFY_TOKEN = randomBytes(16).toString('hex');
const WA_ID = '5541999990000';
const BSUID = 'US.13491208655302741918';
const TEXT = 'Texto sigiloso do cliente';
const NAME = 'Ana Cliente Sigilosa';

const message = (over: Record<string, unknown> = {}) => ({ id: 'wamid.IN1', from: WA_ID, timestamp: '1758000000', type: 'text', text: { body: TEXT }, ...over });
const change = (phoneNumberId: string, value: Record<string, unknown>, field = 'messages') => ({
  field,
  value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId }, ...value },
});
const notification = (...changes: unknown[]) => Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes }] }));
const oneMessage = (over: Record<string, unknown> = {}, phoneNumberId = PHONE_ID_A) =>
  notification(change(phoneNumberId, { contacts: [{ wa_id: WA_ID, profile: { name: NAME } }], messages: [message(over)] }));

describe('WhatsAppWebhookService', () => {
  const logs: { level: string; payload: any }[] = [];
  let receive: jest.Mock;
  let apply: jest.Mock;
  let service: WhatsAppWebhookService;
  const events = (name: string) => logs.filter((l) => l.payload?.event === name).map((l) => l.payload);

  beforeEach(() => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push({ level, payload: args[0] }));
    }
    const config = {
      whatsappCloud: {
        enabled: true,
        verifyToken: VERIFY_TOKEN,
        accounts: [new WhatsAppCloudAccount(TENANT_A, PHONE_ID_A, `EAAG${randomBytes(30).toString('hex')}`), new WhatsAppCloudAccount(TENANT_B, PHONE_ID_B, `EAAG${randomBytes(30).toString('hex')}`)],
      },
    } as unknown as AppConfigService;
    receive = jest.fn().mockResolvedValue({ duplicate: false, conversation: { id: 'conv-1' }, autoReply: { reason: 'replied' } });
    apply = jest.fn().mockResolvedValue('updated');
    service = new WhatsAppWebhookService(config, new WhatsAppAccountResolver(config), { receive } as unknown as ConversationIntakeService, { apply } as unknown as WhatsAppStatusService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('GET verification', () => {
    it('echoes the challenge for the right token', () => {
      expect(service.verifySubscription('subscribe', VERIFY_TOKEN, '1158201444')).toBe('1158201444');
    });

    it('refuses a wrong token (403) and never echoes the challenge', () => {
      expect(() => service.verifySubscription('subscribe', `${VERIFY_TOKEN}x`, '1158201444')).toThrow(ForbiddenException);
      expect(() => service.verifySubscription('subscribe', '', '1158201444')).toThrow(ForbiddenException);
    });

    it.each([
      ['no mode', [undefined, VERIFY_TOKEN, '123']],
      ['no token', ['subscribe', undefined, '123']],
      ['no challenge', ['subscribe', VERIFY_TOKEN, undefined]],
      ['a mode other than subscribe', ['unsubscribe', VERIFY_TOKEN, '123']],
      ['a repeated parameter (array)', ['subscribe', [VERIFY_TOKEN, VERIFY_TOKEN], '123']],
      ['a challenge with markup (it is echoed back)', ['subscribe', VERIFY_TOKEN, '<script>alert(1)</script>']],
      ['a challenge with a newline', ['subscribe', VERIFY_TOKEN, '123\nSet-Cookie: a=b']],
      ['an over-long challenge', ['subscribe', VERIFY_TOKEN, '1'.repeat(300)]],
      ['an empty challenge', ['subscribe', VERIFY_TOKEN, '']],
    ])('rejects %s with 400', (_name, [mode, token, challenge]) => {
      expect(() => service.verifySubscription(mode, token, challenge)).toThrow(BadRequestException);
    });

    it('logs a failed verification without the token that was tried', () => {
      const tried = `wrong-${randomBytes(8).toString('hex')}`;
      expect(() => service.verifySubscription('subscribe', tried, '123')).toThrow();

      expect(events('whatsapp.webhook.verification_failed')).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(tried);
      expect(JSON.stringify(logs)).not.toContain(VERIFY_TOKEN);
    });
  });

  describe('a text message', () => {
    it('becomes an intake call with the tenant from CONFIGURATION, the wa_id as identity, and the wamid as the idempotency key', async () => {
      await service.process(oneMessage());

      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        channel: 'WHATSAPP',
        externalContactId: WA_ID,
        externalConversationId: null,
        externalMessageId: 'wamid.IN1',
        contact: { name: NAME, phone: '+5541999990000' },
        content: TEXT,
        occurredAt: new Date(1_758_000_000_000),
      });
    });

    it('is not classified: any first text goes through the same path and nothing about the text reaches a decision', async () => {
      for (const [i, content] of ['Oi', 'Bom dia', 'Quero informações', 'Quanto custa?', 'Preciso de orçamento'].entries()) await service.process(oneMessage({ id: `wamid.IN${i}`, text: { body: content } }));

      expect(receive).toHaveBeenCalledTimes(5);
      expect(receive.mock.calls.map(([arg]) => arg.content)).toEqual(['Oi', 'Bom dia', 'Quero informações', 'Quanto custa?', 'Preciso de orçamento']);
    });

    it('uses the Stage B phone helper: the wa_id gains its "+" and no default country is ever guessed', async () => {
      await service.process(oneMessage({ from: '14155552671' }));

      expect(receive.mock.calls[0][0].contact.phone).toBe('+14155552671');
      expect(receive.mock.calls[0][0].externalContactId).toBe('14155552671');
    });

    it('a wa_id our phone metadata does not recognise still gets stored and answered (identity by wa_id, no normalized phone)', async () => {
      await service.process(oneMessage({ from: '5541000' }));

      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive.mock.calls[0][0]).toMatchObject({ externalContactId: '5541000', contact: { phone: null } });
      expect(events('whatsapp.phone.not_normalizable')).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain('5541000');
    });

    it('a user with a username (BSUID, no phone) is identified by the BSUID and has no phone', async () => {
      const payload = notification(change(PHONE_ID_A, { contacts: [{ user_id: BSUID, profile: { name: 'Jane', username: 'janedoe' } }], messages: [{ id: 'wamid.B', from_user_id: BSUID, timestamp: '1758000000', type: 'text', text: { body: TEXT } }] }));

      await service.process(payload);

      expect(receive.mock.calls[0][0]).toMatchObject({ externalContactId: BSUID, contact: { name: 'Jane', phone: null }, externalMessageId: 'wamid.B' });
    });

    it('when the payload has both, the phone is the identity (so an existing phone contact keeps its conversation)', async () => {
      await service.process(oneMessage({ from_user_id: BSUID }));

      expect(receive.mock.calls[0][0].externalContactId).toBe(WA_ID);
    });

    it('reports a redelivery as a duplicate and does not count it as a new message twice', async () => {
      receive.mockResolvedValueOnce({ duplicate: true, conversation: { id: 'conv-1' }, autoReply: { reason: 'duplicate' } });

      const summary = await service.process(oneMessage());

      expect(summary).toMatchObject({ messages: 1, duplicates: 1 });
      expect(events('whatsapp.message.received')[0]).toMatchObject({ duplicate: true, autoReply: 'duplicate' });
    });
  });

  describe('tenant resolution: only from configuration, by phone_number_id', () => {
    it('two tenants: each event goes to the tenant that owns ITS phone number', async () => {
      const payload = notification(
        change(PHONE_ID_A, { messages: [message({ id: 'wamid.A' })] }),
        change(PHONE_ID_B, { messages: [message({ id: 'wamid.B', from: '5511977770000' })] }),
      );

      await service.process(payload);

      expect(receive.mock.calls.map(([arg]) => [arg.tenantId, arg.externalMessageId])).toEqual([
        [TENANT_A, 'wamid.A'],
        [TENANT_B, 'wamid.B'],
      ]);
    });

    it('an unknown phone_number_id is dropped: no intake, no status, not routed to any other tenant', async () => {
      const summary = await service.process(notification(change('999999999999999', { messages: [message()], statuses: [{ id: 'wamid.OUT', status: 'delivered' }] })));

      expect(receive).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(summary.unknownPhoneNumber).toBe(2);
      expect(events('whatsapp.webhook.unknown_phone_number')[0]).toMatchObject({ phoneNumberId: '999999999999999' });
    });

    it('a tenantId (or channel) planted in the payload is never used', async () => {
      const raw = JSON.parse(oneMessage({ tenantId: TENANT_B, channel: 'INSTAGRAM' }).toString());
      raw.tenantId = TENANT_B;
      raw.entry[0].tenantId = TENANT_B;
      raw.entry[0].changes[0].value.metadata.tenant_id = TENANT_B;
      raw.entry[0].changes[0].value.contacts[0].tenantId = TENANT_B;

      await service.process(Buffer.from(JSON.stringify(raw)));

      expect(receive.mock.calls[0][0].tenantId).toBe(TENANT_A);
      expect(receive.mock.calls[0][0].channel).toBe('WHATSAPP');
    });

    it('a phone_number_id belonging to tenant B cannot be made to act as tenant A by any other field', async () => {
      const raw = JSON.parse(oneMessage({}, PHONE_ID_B).toString());
      raw.entry[0].id = PHONE_ID_A; // the WABA id field is not a routing key either

      await service.process(Buffer.from(JSON.stringify(raw)));

      expect(receive.mock.calls[0][0].tenantId).toBe(TENANT_B);
    });
  });

  describe('events that are acknowledged and ignored', () => {
    it.each(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'reaction', 'interactive'])('a %s message creates nothing and answers nothing', async (type) => {
      const summary = await service.process(notification(change(PHONE_ID_A, { messages: [message({ type, text: undefined })] })));

      expect(receive).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ messages: 0, ignored: 1 });
      expect(events('whatsapp.webhook.processed')[0].ignoredBy).toEqual({ [`unsupported_message_type:${type}`]: 1 });
    });

    it('business-app echoes (smb_message_echoes) are never processed: no message, no automatic reply, no loop', async () => {
      await service.process(notification(change(PHONE_ID_A, { messages: [message({ from: '15550001111' })] }, 'smb_message_echoes')));

      expect(receive).not.toHaveBeenCalled();
    });

    it('a message from the business own number is dropped even inside the messages field', async () => {
      await service.process(notification(change(PHONE_ID_A, { messages: [message({ from: '15550001111' })] })));

      expect(receive).not.toHaveBeenCalled();
    });

    it('status callbacks never create messages', async () => {
      await service.process(notification(change(PHONE_ID_A, { statuses: [{ id: 'wamid.OUT', status: 'delivered', timestamp: '1758000100' }] })));

      expect(receive).not.toHaveBeenCalled();
    });

    it('other webhook fields (templates, account updates, ...) are ignored', async () => {
      const summary = await service.process(notification(change(PHONE_ID_A, {}, 'message_template_status_update'), change(PHONE_ID_A, {}, 'account_update')));

      expect(receive).not.toHaveBeenCalled();
      expect(summary.ignored).toBe(2);
    });

    it('not a WhatsApp payload at all: accepted, nothing done', async () => {
      await expect(service.process(Buffer.from('{"object":"instagram","entry":[]}'))).resolves.toMatchObject({ messages: 0, ignored: 1 });
      expect(receive).not.toHaveBeenCalled();
    });
  });

  describe('status callbacks', () => {
    const status = (over: Record<string, unknown> = {}) => notification(change(PHONE_ID_A, { statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1758000100', ...over }] }));

    it('are applied for the tenant of their phone_number_id, by the wamid', async () => {
      await service.process(status({ status: 'read' }));

      expect(apply).toHaveBeenCalledWith({ tenantId: TENANT_A, messageId: 'wamid.OUT1', status: 'read', errorCode: null });
    });

    it('a failed status passes only the numeric error code on', async () => {
      await service.process(status({ status: 'failed', errors: [{ code: 131047, title: 'x', message: `to ${WA_ID}` }] }));

      expect(apply).toHaveBeenCalledWith({ tenantId: TENANT_A, messageId: 'wamid.OUT1', status: 'failed', errorCode: '131047' });
      expect(JSON.stringify(logs)).not.toContain(WA_ID);
    });

    it('counts updated / noop / unmatched, and warns about a callback nobody owns', async () => {
      apply.mockResolvedValueOnce('updated').mockResolvedValueOnce('noop').mockResolvedValueOnce('unmatched');
      const payload = notification(change(PHONE_ID_A, { statuses: [{ id: 'a', status: 'delivered' }, { id: 'b', status: 'delivered' }, { id: 'c', status: 'delivered' }] }));

      const summary = await service.process(payload);

      expect(summary).toMatchObject({ statusesApplied: 1, statusesNoop: 1, statusesUnmatched: 1 });
      expect(logs.find((l) => l.payload?.event === 'whatsapp.status.received' && l.payload.outcome === 'unmatched')?.level).toBe('warn');
    });

    it('processes the callbacks of a batch in order, each independently', async () => {
      await service.process(notification(change(PHONE_ID_A, { statuses: [{ id: 'a', status: 'read' }, { id: 'a', status: 'delivered' }, { id: 'a', status: 'sent' }] })));

      expect(apply.mock.calls.map(([arg]) => arg.status)).toEqual(['read', 'delivered', 'sent']);
    });

    it('does not turn "played"/unknown statuses into updates', async () => {
      await service.process(status({ status: 'played' }));

      expect(apply).not.toHaveBeenCalled();
    });
  });

  describe('error policy: acknowledge what a retry cannot fix, ask Meta to retry what it can', () => {
    it.each([
      ['an invalid phone', new InvalidPhoneNumberException()],
      ['a conflict (id used on another channel)', new ConflictException()],
      ['a bad request', new BadRequestException()],
      ['a foreign key violation (the configured tenant does not exist)', new Prisma.PrismaClientKnownRequestError('x', { code: 'P2003', clientVersion: 'test' })],
      ['a value too long for a column', new Prisma.PrismaClientKnownRequestError('x', { code: 'P2000', clientVersion: 'test' })],
    ])('%s is REJECTED: logged and acknowledged (no 503, Meta would re-send it to fail the same way for 7 days)', async (_name, error) => {
      receive.mockRejectedValueOnce(error);

      const summary = await service.process(oneMessage());

      expect(summary.rejected).toBe(1);
      expect(events('whatsapp.event.rejected')).toHaveLength(1);
      expect(events('whatsapp.event.failed')).toHaveLength(0);
    });

    it.each([
      ['a generic error', new Error('boom')],
      ['the database being unreachable', new Prisma.PrismaClientKnownRequestError('x', { code: 'P1001', clientVersion: 'test' })],
      ['a timeout', new Prisma.PrismaClientKnownRequestError('x', { code: 'P2024', clientVersion: 'test' })],
      ['an unexpected unique violation', new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' })],
      ['a 5xx HttpException', new ServiceUnavailableException()],
    ])('%s answers 503 so Meta redelivers', async (_name, error) => {
      receive.mockRejectedValueOnce(error);

      await expect(service.process(oneMessage())).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(events('whatsapp.event.failed')).toHaveLength(1);
    });

    it('one failing event does not stop the others in the same notification, and the 503 comes after they were processed', async () => {
      receive.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ duplicate: false, conversation: { id: 'c' }, autoReply: { reason: 'replied' } });
      const payload = notification(change(PHONE_ID_A, { messages: [message({ id: 'wamid.1' }), message({ id: 'wamid.2' }), message({ id: 'wamid.3' })] }));

      await expect(service.process(payload)).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(receive.mock.calls.map(([arg]) => arg.externalMessageId)).toEqual(['wamid.1', 'wamid.2', 'wamid.3']);
    });

    it('a rejected event does not prevent the next one, and does not cause a 503', async () => {
      receive.mockRejectedValueOnce(new BadRequestException()).mockResolvedValue({ duplicate: false, conversation: { id: 'c' }, autoReply: { reason: 'replied' } });
      const payload = notification(change(PHONE_ID_A, { messages: [message({ id: 'wamid.1' }), message({ id: 'wamid.2' })] }));

      const summary = await service.process(payload);

      expect(summary).toMatchObject({ messages: 1, rejected: 1 });
    });

    it('a status failing for a transient reason also asks for a retry', async () => {
      apply.mockRejectedValueOnce(new Error('db down'));

      await expect(service.process(notification(change(PHONE_ID_A, { statuses: [{ id: 'x', status: 'delivered' }] })))).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('a signed body that is not JSON is a 400', async () => {
      await expect(service.process(Buffer.from('not json'))).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.process(Buffer.alloc(0))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('logs never carry the customer\'s data', () => {
    it('no text, name, phone, wa_id, BSUID, tokens or payload, on any path (processed, ignored, rejected, failed, status)', async () => {
      receive.mockResolvedValueOnce({ duplicate: false, conversation: { id: 'conv-1' }, autoReply: { reason: 'replied' } }).mockRejectedValueOnce(new Error(`db said: ${TEXT} ${WA_ID} ${NAME}`)).mockRejectedValueOnce(new BadRequestException(`bad ${TEXT} ${WA_ID}`));
      const payload = notification(
        change(PHONE_ID_A, {
          contacts: [{ wa_id: WA_ID, user_id: BSUID, profile: { name: NAME } }],
          messages: [message({ id: 'wamid.1', from_user_id: BSUID }), message({ id: 'wamid.2' }), message({ id: 'wamid.3' }), message({ id: 'wamid.4', type: 'image' })],
          statuses: [{ id: 'wamid.OUT', status: 'failed', recipient_id: WA_ID, errors: [{ code: 131047, message: `to ${WA_ID}` }] }],
        }),
      );

      await service.process(payload).catch(() => undefined);

      expect(logs.length).toBeGreaterThan(3);
      const everything = JSON.stringify(logs.map((l) => l.payload));
      for (const secret of [TEXT, NAME, WA_ID, BSUID, VERIFY_TOKEN]) expect(everything).not.toContain(secret);
    });

    it('the received-message line has ids and outcomes only', async () => {
      await service.process(oneMessage());

      expect(events('whatsapp.message.received')).toEqual([
        { event: 'whatsapp.message.received', tenantId: TENANT_A, phoneNumberId: PHONE_ID_A, messageId: 'wamid.IN1', conversationId: 'conv-1', senderKind: 'phone', duplicate: false, autoReply: 'replied' },
      ]);
    });
  });
});
