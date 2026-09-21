import { createHmac, randomBytes } from 'node:crypto';
import { checkMetaSignature, matchesVerifyToken } from './meta-signature';

const APP_SECRET = randomBytes(16).toString('hex');
const sign = (body: Buffer | string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('Meta webhook signature (X-Hub-Signature-256)', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

  it('accepts the HMAC-SHA256 of the raw body keyed with the App Secret', () => {
    expect(checkMetaSignature(body, sign(body), APP_SECRET)).toEqual({ valid: true });
  });

  it('accepts uppercase hex and surrounding whitespace in the header', () => {
    const upper = `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex').toUpperCase()}`;
    expect(checkMetaSignature(body, upper, APP_SECRET).valid).toBe(true);
    expect(checkMetaSignature(body, ` ${sign(body)} `, APP_SECRET).valid).toBe(true);
  });

  it('rejects a missing or empty header', () => {
    expect(checkMetaSignature(body, undefined, APP_SECRET)).toEqual({ valid: false, reason: 'missing' });
    expect(checkMetaSignature(body, '', APP_SECRET)).toEqual({ valid: false, reason: 'missing' });
  });

  it.each([
    ['no sha256= prefix', createHmac('sha256', APP_SECRET).update(body).digest('hex')],
    ['another algorithm', `sha1=${'a'.repeat(40)}`],
    ['a truncated signature', sign(body).slice(0, -2)],
    ['a signature that is too long', `${sign(body)}00`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['just the prefix', 'sha256='],
    ['garbage', 'hello'],
  ])('rejects %s as malformed, without throwing', (_name, header) => {
    expect(checkMetaSignature(body, header, APP_SECRET)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects a repeated header (an array is ambiguous)', () => {
    expect(checkMetaSignature(body, [sign(body), sign(body)] as unknown as string[], APP_SECRET)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects a payload altered after signing, by even one byte', () => {
    const header = sign(body);
    for (const altered of [Buffer.from(body.toString().replace('entry', 'entrz')), Buffer.concat([body, Buffer.from(' ')]), body.subarray(0, body.length - 1), Buffer.alloc(0)]) {
      expect(checkMetaSignature(altered, header, APP_SECRET)).toEqual({ valid: false, reason: 'mismatch' });
    }
  });

  it('rejects a signature made with another secret', () => {
    expect(checkMetaSignature(body, sign(body, randomBytes(16).toString('hex')), APP_SECRET)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('is computed over the received BYTES: a re-serialized equivalent JSON does not verify', () => {
    const original = Buffer.from('{ "object" : "whatsapp_business_account", "entry" : [ ] }'); // odd whitespace, as sent
    const header = sign(original);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString())));

    expect(checkMetaSignature(original, header, APP_SECRET).valid).toBe(true);
    expect(checkMetaSignature(reserialized, header, APP_SECRET).valid).toBe(false);
  });

  it('handles non-ASCII bodies exactly as signed (utf-8 bytes, no escaping changes)', () => {
    const utf8 = Buffer.from('{"text":{"body":"Olá, tudo bem? çãõ ✓ 😀"}}', 'utf8');
    expect(checkMetaSignature(utf8, sign(utf8), APP_SECRET).valid).toBe(true);
  });

  it('never throws whatever the input', () => {
    for (const header of ['sha256=' + 'g'.repeat(64), '\u0000', 'sha256=' + 'a'.repeat(1_000_000), 'SHA256=' + 'a'.repeat(64)]) {
      expect(() => checkMetaSignature(body, header, APP_SECRET)).not.toThrow();
    }
  });
});

describe('verify token comparison', () => {
  const expected = randomBytes(16).toString('hex');

  it('matches only the exact token', () => {
    expect(matchesVerifyToken(expected, expected)).toBe(true);
    expect(matchesVerifyToken(`${expected}x`, expected)).toBe(false);
    expect(matchesVerifyToken(expected.slice(1), expected)).toBe(false);
    expect(matchesVerifyToken(expected.toUpperCase(), expected)).toBe(false);
    expect(matchesVerifyToken('', expected)).toBe(false);
  });

  it('rejects non-strings (repeated query parameters arrive as arrays) and an unset expected token', () => {
    expect(matchesVerifyToken([expected], expected)).toBe(false);
    expect(matchesVerifyToken(undefined, expected)).toBe(false);
    expect(matchesVerifyToken({ a: 1 }, expected)).toBe(false);
    expect(matchesVerifyToken('', '')).toBe(false); // never "empty equals empty"
    expect(matchesVerifyToken('anything', '')).toBe(false);
  });

  it('compares strings of very different length without throwing', () => {
    expect(() => matchesVerifyToken('x'.repeat(100_000), expected)).not.toThrow();
    expect(matchesVerifyToken('x'.repeat(100_000), expected)).toBe(false);
  });
});
