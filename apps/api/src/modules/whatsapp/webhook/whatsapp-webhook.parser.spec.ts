import { parseWhatsAppWebhook } from './whatsapp-webhook.parser';

const PHONE_NUMBER_ID = '109876543210987';
const BUSINESS_NUMBER = '15550001111';
const BSUID = 'US.13491208655302741918';

const message = (over: Record<string, unknown> = {}) => ({ id: 'wamid.HBgL', from: '5541999990000', timestamp: '1758000000', type: 'text', text: { body: 'Oi' }, ...over });
const envelope = (value: Record<string, unknown>, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '+1 555-000-1111', phone_number_id: PHONE_NUMBER_ID }, ...value } }] }],
});
const withMessage = (over: Record<string, unknown> = {}, contacts: unknown[] = [{ wa_id: '5541999990000', profile: { name: 'Ana Cliente' } }]) => envelope({ contacts, messages: [message(over)] });
const withStatus = (over: Record<string, unknown> = {}) => envelope({ statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: '1758000100', recipient_id: '5541999990000', ...over }] });

describe('WhatsApp webhook parser', () => {
  describe('text messages', () => {
    it('extracts the wamid, sender, phone_number_id, text, timestamp and profile name', () => {
      const parsed = parseWhatsAppWebhook(withMessage());

      expect(parsed.ignored).toEqual([]);
      expect(parsed.events).toEqual([
        {
          kind: 'text',
          phoneNumberId: PHONE_NUMBER_ID,
          messageId: 'wamid.HBgL',
          sender: { waId: '5541999990000', bsuid: null },
          profileName: 'Ana Cliente',
          text: 'Oi',
          occurredAt: new Date(1_758_000_000_000),
        },
      ]);
    });

    it('does not look at the text to decide anything: any text is an event (no intent classification)', () => {
      for (const body of ['Oi', 'Bom dia', 'Quero informações', 'Quanto custa?', 'Preciso de orçamento', '?', '👍', 'x'.repeat(4096)]) {
        const parsed = parseWhatsAppWebhook(withMessage({ text: { body } }));
        expect(parsed.events).toHaveLength(1);
        expect((parsed.events[0] as { text: string }).text).toBe(body);
      }
    });

    it('reads every message of a batch, in order, across entries and changes', () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          { changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: [message({ id: 'a' }), message({ id: 'b' })] } }] },
          { changes: [{ field: 'messages', value: { metadata: { phone_number_id: '200000000000002' }, messages: [message({ id: 'c' })] } }] },
        ],
      };

      expect(parseWhatsAppWebhook(payload).events.map((e) => [e.messageId, e.phoneNumberId])).toEqual([
        ['a', PHONE_NUMBER_ID],
        ['b', PHONE_NUMBER_ID],
        ['c', '200000000000002'],
      ]);
    });

    it('takes the profile name of THIS sender by id, never by position', () => {
      const payload = withMessage({}, [
        { wa_id: '5511888880000', profile: { name: 'Outra Pessoa' } },
        { wa_id: '5541999990000', profile: { name: 'Ana Cliente' } },
      ]);

      expect((parseWhatsAppWebhook(payload).events[0] as { profileName: string }).profileName).toBe('Ana Cliente');
    });

    it('cleans control characters from the display name and tolerates a missing profile', () => {
      const dirty = withMessage({}, [{ wa_id: '5541999990000', profile: { name: '  Ana\u0000\u001b[31m Cliente\n ' } }]);
      expect((parseWhatsAppWebhook(dirty).events[0] as { profileName: string }).profileName).toBe('Ana[31m Cliente');
      expect((parseWhatsAppWebhook(withMessage({}, [])).events[0] as { profileName: null }).profileName).toBeNull();
      expect((parseWhatsAppWebhook(withMessage({}, [{ wa_id: '5541999990000' }])).events[0] as { profileName: null }).profileName).toBeNull();
    });

    it('has no occurredAt when the timestamp is absent or not epoch seconds (ingest then uses the time of receipt)', () => {
      for (const timestamp of [undefined, 'yesterday', '', '12', '-5', {}]) {
        expect((parseWhatsAppWebhook(withMessage({ timestamp })).events[0] as { occurredAt: Date | null }).occurredAt).toBeNull();
      }
      expect((parseWhatsAppWebhook(withMessage({ timestamp: 1758000000 })).events[0] as { occurredAt: Date }).occurredAt).toEqual(new Date(1_758_000_000_000));
    });
  });

  describe('sender identity (phone or business-scoped user id)', () => {
    it('uses the BSUID when the phone number is not provided (username users)', () => {
      const payload = envelope({
        contacts: [{ user_id: BSUID, profile: { name: 'Jane', username: 'janedoe' } }],
        messages: [{ id: 'wamid.B', from_user_id: BSUID, timestamp: '1758000000', type: 'text', text: { body: 'Oi' } }],
      });

      const [event] = parseWhatsAppWebhook(payload).events;

      expect(event).toMatchObject({ kind: 'text', sender: { waId: null, bsuid: BSUID }, profileName: 'Jane' });
    });

    it('keeps both when both are present (the phone is preferred later, by the service)', () => {
      const payload = envelope({
        contacts: [{ wa_id: '5541999990000', user_id: BSUID, profile: { name: 'Ana' } }],
        messages: [message({ from_user_id: BSUID })],
      });

      expect((parseWhatsAppWebhook(payload).events[0] as { sender: unknown }).sender).toEqual({ waId: '5541999990000', bsuid: BSUID });
    });

    it.each([
      ['no from and no from_user_id', { from: undefined }],
      ['a from that is not digits', { from: '+55 41 99999-0000' }],
      ['a from that is too short', { from: '123' }],
      ['a malformed BSUID and no phone', { from: undefined, from_user_id: 'not-a-bsuid' }],
    ])('ignores a message with %s (no_sender)', (_name, over) => {
      const parsed = parseWhatsAppWebhook(withMessage(over as Record<string, unknown>));

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'no_sender', type: 'text', phoneNumberId: PHONE_NUMBER_ID }]);
    });
  });

  describe('unsupported message types are acknowledged and ignored', () => {
    it.each(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'reaction', 'interactive', 'button', 'order', 'system', 'unsupported'])('%s', (type) => {
      const parsed = parseWhatsAppWebhook(withMessage({ type, text: undefined, [type]: { anything: 1 } }));

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'unsupported_message_type', type, phoneNumberId: PHONE_NUMBER_ID }]);
    });

    it('never reports an attacker-controlled type string as-is', () => {
      const parsed = parseWhatsAppWebhook(withMessage({ type: 'x'.repeat(500) + '\n{"forged":"log line"}' }));

      expect(parsed.ignored[0]).toMatchObject({ reason: 'unsupported_message_type', type: 'other' });
    });

    it('an empty text body is not a message', () => {
      expect(parseWhatsAppWebhook(withMessage({ text: { body: '' } })).events).toEqual([]);
      expect(parseWhatsAppWebhook(withMessage({ text: {} })).events).toEqual([]);
      expect(parseWhatsAppWebhook(withMessage({ text: 'Oi' })).events).toEqual([]);
    });
  });

  describe('echoes and other webhook fields (loop protection)', () => {
    it('never processes the smb_message_echoes field: what the business itself sent is not a customer message', () => {
      const payload = envelope({ message_echoes: [message({ from: BUSINESS_NUMBER })], messages: [message({ from: BUSINESS_NUMBER })] }, 'smb_message_echoes');

      const parsed = parseWhatsAppWebhook(payload);

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'echo', field: 'smb_message_echoes' }]);
    });

    it('drops a message whose sender is the business own number (second layer)', () => {
      const parsed = parseWhatsAppWebhook(withMessage({ from: BUSINESS_NUMBER }));

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'echo', type: 'text', phoneNumberId: PHONE_NUMBER_ID }]);
    });

    it.each(['message_template_status_update', 'account_update', 'phone_number_quality_update', 'user_id_update', 'calls', 'flows'])('ignores the %s field', (field) => {
      const parsed = parseWhatsAppWebhook(envelope({ event: 'X' }, field));

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'unsupported_field', field }]);
    });
  });

  describe('status callbacks', () => {
    it.each(['sent', 'delivered', 'read'] as const)('%s', (status) => {
      const parsed = parseWhatsAppWebhook(withStatus({ status }));

      expect(parsed.events).toEqual([{ kind: 'status', phoneNumberId: PHONE_NUMBER_ID, messageId: 'wamid.OUT1', status, errorCode: null, occurredAt: new Date(1_758_000_100_000) }]);
    });

    it('failed keeps ONLY the numeric error code (never Meta\'s title/message, which can quote a phone or content)', () => {
      const parsed = parseWhatsAppWebhook(withStatus({ status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message', message: 'to 5541999990000: hello secret', error_data: { details: 'x' } }] }));

      expect(parsed.events[0]).toMatchObject({ kind: 'status', status: 'failed', errorCode: '131047' });
      expect(JSON.stringify(parsed)).not.toMatch(/secret|5541999990000|Re-engagement/);
    });

    it.each([[undefined], [[]], [[{}]], [[{ code: 'oops' }]], [[{ code: 1.5 }]], [[{ code: -1 }]], ['x']])('failed with unusable errors %p has no code', (errors) => {
      expect((parseWhatsAppWebhook(withStatus({ status: 'failed', errors })).events[0] as { errorCode: string | null }).errorCode).toBeNull();
    });

    it.each(['played', 'deleted', 'something_new'])('ignores the %s status', (status) => {
      const parsed = parseWhatsAppWebhook(withStatus({ status }));

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'unsupported_status', type: status, phoneNumberId: PHONE_NUMBER_ID }]);
    });

    it('a status without a usable id is malformed', () => {
      expect(parseWhatsAppWebhook(withStatus({ id: '' })).events).toEqual([]);
      expect(parseWhatsAppWebhook(withStatus({ id: 'has spaces' })).events).toEqual([]);
      expect(parseWhatsAppWebhook(withStatus({ id: undefined })).ignored[0]).toMatchObject({ reason: 'malformed' });
    });

    it('a message and a status in the same notification are both read', () => {
      const payload = envelope({ messages: [message()], statuses: [{ id: 'wamid.OUT1', status: 'read', timestamp: '1758000100' }] });

      expect(parseWhatsAppWebhook(payload).events.map((e) => e.kind)).toEqual(['text', 'status']);
    });
  });

  describe('phone_number_id (input to tenant resolution)', () => {
    it.each([[undefined], [''], ['abc'], ['12'], [12345678901], ['1'.repeat(40)]])('a value that is not a Meta id (%p) makes the whole change malformed', (phone_number_id) => {
      const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id }, messages: [message()] } }] }] };

      const parsed = parseWhatsAppWebhook(payload);

      expect(parsed.events).toEqual([]);
      expect(parsed.ignored).toEqual([{ reason: 'malformed' }]);
    });

    it('a tenantId/channel smuggled anywhere in the payload is not read at all', () => {
      const payload = withMessage({ tenantId: 'tenant-b', channel: 'INSTAGRAM' });
      (payload.entry[0] as Record<string, unknown>).tenantId = 'tenant-b';
      (payload.entry[0].changes[0].value as Record<string, unknown>).tenant_id = 'tenant-b';

      const [event] = parseWhatsAppWebhook(payload).events;

      expect(JSON.stringify(event)).not.toContain('tenant-b');
      expect(Object.keys(event).sort()).toEqual(['kind', 'messageId', 'occurredAt', 'phoneNumberId', 'profileName', 'sender', 'text']);
    });
  });

  describe('defensive against anything else', () => {
    it.each([[null], [undefined], ['text'], [42], [[]], [{}], [{ object: 'instagram' }], [{ object: 'page', entry: [] }]])('%p is not a WhatsApp notification', (payload) => {
      expect(parseWhatsAppWebhook(payload)).toEqual({ events: [], ignored: [{ reason: 'not_whatsapp_object' }] });
    });

    it.each([
      [{ object: 'whatsapp_business_account' }],
      [{ object: 'whatsapp_business_account', entry: 'x' }],
      [{ object: 'whatsapp_business_account', entry: [null, 1, 'x', []] }],
      [{ object: 'whatsapp_business_account', entry: [{ changes: 'x' }] }],
      [{ object: 'whatsapp_business_account', entry: [{ changes: [null, { field: 'messages' }, { field: 'messages', value: 'x' }] }] }],
      [envelope({ messages: 'x', statuses: {}, contacts: 7 })],
      [envelope({ messages: [null, 1, 'x', []], statuses: [null, 1] })],
    ])('never throws on malformed shapes (%#)', (payload) => {
      expect(() => parseWhatsAppWebhook(payload)).not.toThrow();
      expect(parseWhatsAppWebhook(payload).events).toEqual([]);
    });

    it('survives a hostile object (prototype pollution keys, huge arrays)', () => {
      const hostile = JSON.parse(`{"object":"whatsapp_business_account","__proto__":{"polluted":true},"entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"${PHONE_NUMBER_ID}"},"messages":[${Array.from({ length: 2000 }, (_, i) => `{"id":"m${i}","from":"5541999990000","type":"text","text":{"body":"x"}}`).join(',')}]}}]}]}`);

      const parsed = parseWhatsAppWebhook(hostile);

      expect(parsed.events).toHaveLength(2000);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });
});
