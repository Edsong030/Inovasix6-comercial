import { BadRequestException, Injectable } from '@nestjs/common';
import { Contact, ConversationChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CountryCode, normalizePhoneE164 } from './phone-number';

/**
 * Country assumed for national-format phones when the caller does not say
 * otherwise. Numbers with an international prefix ("+...") ignore it.
 */
export const DEFAULT_PHONE_COUNTRY: CountryCode = 'BR';

/**
 * Total attempts of the resolve transaction (1 try + 2 retries).
 *
 * A unique-violation (P2002) means a concurrent request created the row we
 * wanted. Postgres only raises it after the competing transaction has
 * committed (or immediately if it already had), so ONE retry already sees the
 * winner. The extra attempt covers the rare cascade where the winner itself
 * rolled back. Beyond that something else is wrong, so the error is rethrown.
 */
const MAX_RESOLVE_ATTEMPTS = 3;

export interface FindOrCreateContactByIdentityInput {
  /**
   * Trusted tenant, resolved server-side (e.g. from the channel configuration).
   * Never take it from a payload the external party controls.
   */
  tenantId: string;
  channel: ConversationChannel;
  /** Channel-scoped id: WhatsApp wa_id, Webchat visitor id, Instagram scoped id... */
  externalContactId: string;
  name?: string | null;
  /**
   * Raw phone as received. Only pass a phone the channel has VERIFIED (e.g.
   * WhatsApp): a matching phone links this identity to the existing Contact,
   * so an unverified, user-typed phone could attach a stranger to someone
   * else's contact. Re-normalized here with normalizePhoneE164, so an E.164
   * value from normalizeInternationalPhoneDigits() (e.g. the WhatsApp wa_id)
   * passes through unchanged; do NOT pass raw digits-only ids, they would be
   * read as national numbers of `defaultCountry`.
   */
  phone?: string | null;
  /** Stored on a NEW contact only; never used to match (see resolve notes). */
  email?: string | null;
  /** Country for national-format phones. Defaults to DEFAULT_PHONE_COUNTRY. */
  defaultCountry?: CountryCode;
}

export interface FindOrCreateContactByIdentityResult {
  contact: Contact;
  /** A new Contact row was inserted by this call. */
  contactCreated: boolean;
  /** A new ContactChannelIdentity row was inserted by this call. */
  identityCreated: boolean;
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve (or create) the Contact behind a channel identity, atomically and
   * idempotently.
   *
   * Resolution order, all inside ONE tenant-scoped (RLS) transaction:
   *  1. ContactChannelIdentity (tenant, channel, externalContactId) exists
   *     -> return its Contact, nothing is written.
   *  2. Else, if a phone was given, normalize it to E.164 and look for a
   *     Contact with that (tenant, phoneE164) -> reuse it.
   *  3. Else create a new Contact.
   *  In cases 2 and 3 the ContactChannelIdentity is then created. Contact and
   *  identity commit together or not at all.
   *
   * Email is NOT a matching key: the schema only has a plain index on
   * (tenantId, email), no uniqueness, so two people can legitimately share an
   * address and deduplicating on it would merge strangers.
   *
   * Concurrency: two first messages for the same identity can both miss in
   * step 1. The loser then fails on a unique constraint (identity or
   * (tenant, phone)); its whole transaction rolls back (no orphan Contact) and
   * it is re-run in a fresh transaction, where the winner's rows are visible.
   * A failed statement aborts a Postgres transaction, so the retry MUST be a
   * new transaction — it cannot be done inside the callback.
   *
   * @throws InvalidPhoneNumberException (400) when `phone` is present but not a valid number
   * @throws BadRequestException (400) when `externalContactId` is blank
   */
  async findOrCreateByIdentity(
    input: FindOrCreateContactByIdentityInput,
  ): Promise<FindOrCreateContactByIdentityResult> {
    const externalContactId = input.externalContactId?.trim();
    if (!externalContactId) {
      throw new BadRequestException('Identificador externo do contato é obrigatório.');
    }

    // Validate/normalize BEFORE opening a transaction: bad input fails fast and
    // never touches the database.
    const phoneE164 = normalizePhoneE164(input.phone, input.defaultCountry ?? DEFAULT_PHONE_COUNTRY);
    const args: ResolveArgs = {
      tenantId: input.tenantId,
      channel: input.channel,
      externalContactId,
      name: input.name?.trim() || null,
      email: input.email?.trim().toLowerCase() || null,
      phoneE164,
    };

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.resolveInTransaction(args);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= MAX_RESOLVE_ATTEMPTS) throw error;
        // Lost a race; the next attempt re-reads in a new transaction.
      }
    }
  }

  private resolveInTransaction(args: ResolveArgs): Promise<FindOrCreateContactByIdentityResult> {
    const { tenantId, channel, externalContactId, phoneE164 } = args;

    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const identity = await tx.contactChannelIdentity.findUnique({
        where: { tenantId_channel_externalContactId: { tenantId, channel, externalContactId } },
        include: { contact: true },
      });
      if (identity) {
        return { contact: identity.contact, contactCreated: false, identityCreated: false };
      }

      const existingByPhone = phoneE164
        ? await tx.contact.findUnique({ where: { tenantId_phoneE164: { tenantId, phoneE164 } } })
        : null;

      const contact =
        existingByPhone ??
        (await tx.contact.create({
          data: { tenantId, name: args.name, phoneE164, email: args.email },
        }));

      await tx.contactChannelIdentity.create({
        data: { tenantId, contactId: contact.id, channel, externalContactId },
      });

      return { contact, contactCreated: !existingByPhone, identityCreated: true };
    });
  }
}

interface ResolveArgs {
  tenantId: string;
  channel: ConversationChannel;
  externalContactId: string;
  name: string | null;
  email: string | null;
  phoneE164: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
