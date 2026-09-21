import { BadRequestException } from '@nestjs/common';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type { CountryCode };

/** Raised when a phone value cannot be resolved to a valid E.164 number. */
export class InvalidPhoneNumberException extends BadRequestException {
  constructor() {
    super('Telefone inválido.');
  }
}

/**
 * Normalize a raw phone value to E.164 (`+5541999999999`).
 *
 * - Uses libphonenumber-js with the full ("max") metadata so validity is checked
 *   against per-country number patterns, not just length.
 * - A number written with an international prefix (`+1 415 555 2671`) is parsed
 *   on its own; `defaultCountry` only matters for national-format input
 *   (`(41) 99999-9999`).
 * - Invalid numbers are REJECTED with InvalidPhoneNumberException. Nothing is
 *   repaired, padded or guessed.
 * - Blank / missing input returns null ("no phone provided"), which is not the
 *   same thing as an invalid phone.
 *
 * A digits-only value WITHOUT "+" is always read as a national number of
 * `defaultCountry`, never as international. Ids that a trusted channel
 * delivers as international digits-only (WhatsApp `wa_id`, `5541999999999`)
 * must go through normalizeInternationalPhoneDigits() instead.
 */
export function normalizePhoneE164(
  raw: string | null | undefined,
  defaultCountry?: CountryCode,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  return toValidE164(trimmed, defaultCountry);
}

/**
 * Normalize an INTERNATIONAL, digits-only phone id (country code included, no
 * "+") delivered by a trusted channel — e.g. the WhatsApp `wa_id`
 * `5541999999999` -> `+5541999999999`.
 *
 * This is an explicit opt-in: the caller states that the value is
 * international, so the "+" is added here, once, instead of in every channel
 * adapter. It is deliberately separate from normalizePhoneE164 so a national
 * number typed by a person (`41999999999`) is never promoted to international
 * by guessing from its length.
 *
 * Strict input: after trimming, only digits, optionally preceded by a single
 * "+" (accepted and equivalent to omitting it). Letters, spaces, dashes,
 * parentheses and any other character are rejected — a channel id has no
 * formatting, so its presence means the value is not what the caller believes.
 * No default country is involved; the country code is part of the digits.
 *
 * Blank / missing input returns null ("no phone"); anything else that is not a
 * valid number throws InvalidPhoneNumberException.
 */
export function normalizeInternationalPhoneDigits(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const match = /^\+?(\d+)$/.exec(trimmed);
  if (!match) throw new InvalidPhoneNumberException();

  return toValidE164(`+${match[1]}`);
}

function toValidE164(value: string, defaultCountry?: CountryCode): string {
  const parsed = parsePhoneNumberFromString(value, defaultCountry);
  if (!parsed || !parsed.isValid()) throw new InvalidPhoneNumberException();

  return parsed.number;
}
