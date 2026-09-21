import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every webhook notification with the App Secret and sends the result
 * in `X-Hub-Signature-256: sha256=<hex>`: an HMAC-SHA256 of the RAW request body
 * (the exact bytes received). Verifying it is what proves a notification really
 * comes from Meta, so it is the security boundary of the webhook.
 *
 * Two rules follow from that:
 *  - the HMAC is computed over the received bytes, never over a re-serialized
 *    JSON.stringify(req.body), which can differ in whitespace, key order or
 *    unicode escaping from what Meta signed;
 *  - the comparison is constant time, on buffers of the same length.
 */

export type SignatureCheck = { valid: true } | { valid: false; reason: 'missing' | 'malformed' | 'mismatch' };

const SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/;

export function checkMetaSignature(rawBody: Buffer, header: string | string[] | undefined, appSecret: string): SignatureCheck {
  if (header === undefined || header === '') return { valid: false, reason: 'missing' };
  // A repeated header arrives as an array: ambiguous, so not accepted.
  if (typeof header !== 'string') return { valid: false, reason: 'malformed' };

  const match = SIGNATURE_HEADER.exec(header.trim());
  if (!match) return { valid: false, reason: 'malformed' };

  const provided = Buffer.from(match[1], 'hex'); // exactly 32 bytes: the regex fixed the length
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(provided, expected) ? { valid: true } : { valid: false, reason: 'mismatch' };
}

/**
 * Constant-time check of the GET verification token. Both sides are hashed first
 * so the buffers have equal length whatever the caller sent (timingSafeEqual
 * throws on different lengths, and comparing lengths would leak them).
 */
export function matchesVerifyToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
