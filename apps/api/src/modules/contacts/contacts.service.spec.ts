import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContactsService } from './contacts.service';
import {
  InvalidPhoneNumberException,
  normalizeInternationalPhoneDigits,
  normalizePhoneE164,
} from './phone-number';

/**
 * Unit tests for ContactsService against an in-memory fake that behaves like
 * Postgres where it matters for this flow (READ COMMITTED):
 *  - writes stay pending until the transaction commits; a throw rolls them back
 *  - unique constraints raise a real Prisma P2002 (identity + tenant/phone)
 *  - composite FK: an identity's contact must exist in the SAME tenant
 *  - RLS: a transaction only sees/writes rows of the tenant it was opened for
 * Real-database concurrency lives in test/contacts.integration-spec.ts.
 */

type Row = Record<string, any>;
type Op = 'contact.findUnique' | 'contact.create' | 'identity.findUnique' | 'identity.create';

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

class FakeDb {
  contacts: Row[] = [];
  identities: Row[] = [];
  transactions = 0;
  private seq = 0;

  /** Called right before each operation; lets a test interleave a "winner". */
  before?: (op: Op, tenantId: string) => void;
  /** Force an operation to throw (consumed once). */
  failOnce?: { op: Op; error: Error };

  id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  /** Commit rows directly, as if another request had already finished. */
  commitContact(row: Row): Row {
    const created = { id: this.id('contact'), name: null, phoneE164: null, email: null, ...row };
    this.contacts.push(created);
    return created;
  }

  commitIdentity(row: Row): Row {
    const created = { id: this.id('identity'), ...row };
    this.identities.push(created);
    return created;
  }

  prisma(): any {
    return {
      runWithTenant: async (tenantId: string, work: (tx: any) => Promise<unknown>) => {
        this.transactions++;
        const pending = { contacts: [] as Row[], identities: [] as Row[] };
        const tx = this.makeTx(tenantId, pending);
        // A throw from `work` propagates and `pending` is discarded (rollback).
        const result = await work(tx);
        this.contacts.push(...pending.contacts); // commit
        this.identities.push(...pending.identities);
        return result;
      },
    };
  }

  private makeTx(tenantId: string, pending: { contacts: Row[]; identities: Row[] }) {
    const guard = (op: Op) => {
      this.before?.(op, tenantId);
      if (this.failOnce?.op === op) {
        const { error } = this.failOnce;
        this.failOnce = undefined;
        throw error;
      }
    };
    // RLS: only rows of the current tenant are visible.
    const visibleContacts = () => [...this.contacts, ...pending.contacts].filter((c) => c.tenantId === tenantId);
    const visibleIdentities = () => [...this.identities, ...pending.identities].filter((i) => i.tenantId === tenantId);
    // Unique checks see everything committed (a competing txn) + own pending rows.
    const allContacts = () => [...this.contacts, ...pending.contacts];
    const allIdentities = () => [...this.identities, ...pending.identities];
    const rlsCheck = (row: Row) => {
      if (row.tenantId !== tenantId) throw new Error('new row violates row-level security policy');
    };

    return {
      contact: {
        findUnique: async ({ where }: any) => {
          guard('contact.findUnique');
          const key = where.tenantId_phoneE164;
          return visibleContacts().find((c) => c.tenantId === key.tenantId && c.phoneE164 === key.phoneE164) ?? null;
        },
        create: async ({ data }: any) => {
          guard('contact.create');
          rlsCheck(data);
          if (
            data.phoneE164 &&
            allContacts().some((c) => c.tenantId === data.tenantId && c.phoneE164 === data.phoneE164)
          ) {
            throw p2002(['tenant_id', 'phone_e164']);
          }
          const row = { id: this.id('contact'), name: null, phoneE164: null, email: null, ...data };
          pending.contacts.push(row);
          return row;
        },
      },
      contactChannelIdentity: {
        findUnique: async ({ where, include }: any) => {
          guard('identity.findUnique');
          const key = where.tenantId_channel_externalContactId;
          const row = visibleIdentities().find(
            (i) =>
              i.tenantId === key.tenantId && i.channel === key.channel && i.externalContactId === key.externalContactId,
          );
          if (!row) return null;
          return include?.contact ? { ...row, contact: visibleContacts().find((c) => c.id === row.contactId) } : row;
        },
        create: async ({ data }: any) => {
          guard('identity.create');
          rlsCheck(data);
          // composite FK (tenant_id, contact_id) -> contacts(tenant_id, id)
          if (!allContacts().some((c) => c.tenantId === data.tenantId && c.id === data.contactId)) {
            throw new Error('Foreign key constraint violated: contact_channel_identities_tenant_id_contact_id_fkey');
          }
          if (
            allIdentities().some(
              (i) =>
                i.tenantId === data.tenantId &&
                i.channel === data.channel &&
                i.externalContactId === data.externalContactId,
            )
          ) {
            throw p2002(['tenant_id', 'channel', 'external_contact_id']);
          }
          const row = { id: this.id('identity'), ...data };
          pending.identities.push(row);
          return row;
        },
      },
    };
  }
}

describe('normalizePhoneE164', () => {
  it('6. normalizes a valid Brazilian national number using the default country', () => {
    expect(normalizePhoneE164('(41) 99999-9999', 'BR')).toBe('+5541999999999');
    expect(normalizePhoneE164('41 99999-9999', 'BR')).toBe('+5541999999999');
    expect(normalizePhoneE164('+55 (41) 99999-9999')).toBe('+5541999999999');
  });

  it('7. normalizes valid international numbers, ignoring the default country', () => {
    expect(normalizePhoneE164('+1 (415) 555-2671', 'BR')).toBe('+14155552671');
    expect(normalizePhoneE164('+351 912 345 678', 'BR')).toBe('+351912345678');
    // a national-format number uses the country the caller supplies
    expect(normalizePhoneE164('(415) 555-2671', 'US')).toBe('+14155552671');
  });

  it('8. rejects invalid numbers explicitly instead of repairing them', () => {
    expect(() => normalizePhoneE164('abc', 'BR')).toThrow(InvalidPhoneNumberException);
    expect(() => normalizePhoneE164('12345', 'BR')).toThrow(InvalidPhoneNumberException);
    expect(() => normalizePhoneE164('(41) 9999-99', 'BR')).toThrow(InvalidPhoneNumberException);
    expect(() => normalizePhoneE164('+55 41 99999', 'BR')).toThrow(InvalidPhoneNumberException);
    // national format with NO country to interpret it in is invalid, not guessed
    expect(() => normalizePhoneE164('(41) 99999-9999')).toThrow(InvalidPhoneNumberException);
  });

  it('8. InvalidPhoneNumberException is a 400', () => {
    try {
      normalizePhoneE164('abc', 'BR');
      fail('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getStatus()).toBe(400);
    }
  });

  it('treats blank or missing input as "no phone", not as invalid', () => {
    expect(normalizePhoneE164(undefined, 'BR')).toBeNull();
    expect(normalizePhoneE164(null, 'BR')).toBeNull();
    expect(normalizePhoneE164('   ', 'BR')).toBeNull();
  });

  it('digits-only without "+" stays NATIONAL: US digits are not promoted to international', () => {
    // A national BR number without "+" keeps working under defaultCountry.
    expect(normalizePhoneE164('41999999999', 'BR')).toBe('+5541999999999');
    // The same digits a WhatsApp adapter would send for a US contact are NOT
    // guessed to be +1...; under BR they are an invalid national number.
    expect(() => normalizePhoneE164('14155552671', 'BR')).toThrow(InvalidPhoneNumberException);
    // ...and are valid only when the caller says which country they belong to.
    expect(normalizePhoneE164('14155552671', 'US')).toBe('+14155552671');
  });

  it('InvalidPhoneNumberException carries the UTF-8 message intact', () => {
    expect(() => normalizePhoneE164('abc', 'BR')).toThrow('Telefone inválido.');
  });
});

describe('normalizeInternationalPhoneDigits', () => {
  it('normalizes a valid BR wa_id (digits-only) to E.164', () => {
    expect(normalizeInternationalPhoneDigits('5541999999999')).toBe('+5541999999999');
  });

  it('normalizes a valid US digits-only id to E.164', () => {
    expect(normalizeInternationalPhoneDigits('14155552671')).toBe('+14155552671');
  });

  it('normalizes another international id (PT) without any default country', () => {
    expect(normalizeInternationalPhoneDigits('351912345678')).toBe('+351912345678');
  });

  it('rejects invalid international digits-only ids', () => {
    expect(() => normalizeInternationalPhoneDigits('5541999')).toThrow(InvalidPhoneNumberException); // too short
    expect(() => normalizeInternationalPhoneDigits('554199999999999999')).toThrow(InvalidPhoneNumberException); // too long
    expect(() => normalizeInternationalPhoneDigits('0')).toThrow(InvalidPhoneNumberException);
    // a national BR number is NOT valid as international: no length-guessing
    expect(() => normalizeInternationalPhoneDigits('41999999999')).toThrow(InvalidPhoneNumberException);
  });

  it('rejects input containing letters', () => {
    expect(() => normalizeInternationalPhoneDigits('55419ABC99999')).toThrow(InvalidPhoneNumberException);
    expect(() => normalizeInternationalPhoneDigits('abc')).toThrow(InvalidPhoneNumberException);
  });

  it('rejects formatted input: a channel id has no separators', () => {
    expect(() => normalizeInternationalPhoneDigits('+55 (41) 99999-9999')).toThrow(InvalidPhoneNumberException);
    expect(() => normalizeInternationalPhoneDigits('55 41 99999 9999')).toThrow(InvalidPhoneNumberException);
    expect(() => normalizeInternationalPhoneDigits('++5541999999999')).toThrow(InvalidPhoneNumberException);
  });

  it('accepts one leading "+" as equivalent to omitting it (documented behavior)', () => {
    expect(normalizeInternationalPhoneDigits('+5541999999999')).toBe('+5541999999999');
    expect(normalizeInternationalPhoneDigits(' 5541999999999 ')).toBe('+5541999999999');
  });

  it('treats blank or missing input as "no phone"', () => {
    expect(normalizeInternationalPhoneDigits(undefined)).toBeNull();
    expect(normalizeInternationalPhoneDigits(null)).toBeNull();
    expect(normalizeInternationalPhoneDigits('  ')).toBeNull();
  });

  it('its E.164 output flows through ContactsService unchanged, for any default country', async () => {
    const db = new FakeDb();
    const service = new ContactsService(db.prisma());
    const wa = normalizeInternationalPhoneDigits('14155552671'); // US wa_id; default country is BR

    const result = await service.findOrCreateByIdentity({
      tenantId: 'tenant-a',
      channel: 'WHATSAPP',
      externalContactId: '14155552671',
      phone: wa,
    });

    expect(result.contact.phoneE164).toBe('+14155552671');
  });
});

describe('ContactsService.findOrCreateByIdentity', () => {
  const TENANT_A = 'tenant-a';
  const TENANT_B = 'tenant-b';
  let db: FakeDb;
  let service: ContactsService;

  beforeEach(() => {
    db = new FakeDb();
    service = new ContactsService(db.prisma());
  });

  it('1. existing identity returns its Contact without writing anything', async () => {
    const contact = db.commitContact({ tenantId: TENANT_A, name: 'Ana', phoneE164: '+5541999999999' });
    db.commitIdentity({
      tenantId: TENANT_A,
      contactId: contact.id,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
    });

    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      name: 'Outro Nome',
      phone: '(11) 98888-7777',
    });

    expect(result).toEqual({ contact, contactCreated: false, identityCreated: false });
    expect(db.contacts).toHaveLength(1);
    expect(db.identities).toHaveLength(1);
    // existing data is not overwritten by what the channel sends
    expect(db.contacts[0].name).toBe('Ana');
    expect(db.contacts[0].phoneE164).toBe('+5541999999999');
  });

  it('2. unknown identity + unknown phone creates Contact and identity together', async () => {
    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      name: '  Ana  ',
      phone: '(41) 99999-9999',
      email: '  ANA@Example.com ',
    });

    expect(result.contactCreated).toBe(true);
    expect(result.identityCreated).toBe(true);
    expect(db.contacts).toHaveLength(1);
    expect(db.contacts[0]).toMatchObject({
      tenantId: TENANT_A,
      name: 'Ana',
      phoneE164: '+5541999999999',
      email: 'ana@example.com',
    });
    expect(db.identities).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A,
        contactId: db.contacts[0].id,
        channel: 'WHATSAPP',
        externalContactId: 'wa-1',
      }),
    ]);
    expect(result.contact.id).toBe(db.contacts[0].id);
  });

  it('2b. no phone: creates a Contact without inventing one', async () => {
    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WEBCHAT',
      externalContactId: 'visitor-1',
      phone: '  ',
    });

    expect(result.contactCreated).toBe(true);
    expect(db.contacts[0]).toMatchObject({ name: null, phoneE164: null, email: null });
  });

  it('3. unknown identity + phone already in the same tenant reuses the Contact', async () => {
    const existing = db.commitContact({ tenantId: TENANT_A, name: 'Ana', phoneE164: '+5541999999999' });

    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      phone: '(41) 99999-9999',
      name: 'Nome do WhatsApp',
    });

    expect(result).toEqual({ contact: existing, contactCreated: false, identityCreated: true });
    expect(db.contacts).toHaveLength(1);
    expect(db.contacts[0].name).toBe('Ana'); // not overwritten
    expect(db.identities).toEqual([expect.objectContaining({ contactId: existing.id, externalContactId: 'wa-1' })]);
  });

  it('4. same externalContactId on different channels does not collide', async () => {
    const wa = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: '12345',
    });
    const ig = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'INSTAGRAM',
      externalContactId: '12345',
    });

    expect(wa.contact.id).not.toBe(ig.contact.id);
    expect(db.identities).toHaveLength(2);

    // and each one still resolves back to its own contact
    const waAgain = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: '12345',
    });
    expect(waAgain.contact.id).toBe(wa.contact.id);
    expect(waAgain.identityCreated).toBe(false);
  });

  it('5. same channel + externalContactId in different tenants stays isolated', async () => {
    const a = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      phone: '+5541999999999',
    });
    const b = await service.findOrCreateByIdentity({
      tenantId: TENANT_B,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      phone: '+5541999999999',
    });

    expect(a.contact.id).not.toBe(b.contact.id);
    expect(a.contact.tenantId).toBe(TENANT_A);
    expect(b.contact.tenantId).toBe(TENANT_B);
    expect(db.identities.map((i) => i.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it('11. never reuses a Contact (or identity) of another tenant', async () => {
    const otherTenantContact = db.commitContact({ tenantId: TENANT_B, name: 'Bia', phoneE164: '+5541999999999' });
    db.commitIdentity({
      tenantId: TENANT_B,
      contactId: otherTenantContact.id,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
    });

    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1', // same identity key as tenant B's
      phone: '(41) 99999-9999', // same phone as tenant B's contact
    });

    expect(result.contactCreated).toBe(true);
    expect(result.identityCreated).toBe(true);
    expect(result.contact.id).not.toBe(otherTenantContact.id);
    expect(result.contact.tenantId).toBe(TENANT_A);
    expect(db.contacts.filter((c) => c.tenantId === TENANT_B)).toEqual([otherTenantContact]);
    expect(db.identities.filter((i) => i.tenantId === TENANT_A)).toEqual([
      expect.objectContaining({ contactId: result.contact.id }),
    ]);
  });

  it('11b. the fake FK/RLS reject an identity pointing at another tenant’s contact', async () => {
    // Guards the fake itself: proves the tenant checks in tests 5/11 are live.
    const otherTenantContact = db.commitContact({ tenantId: TENANT_B });
    await expect(
      db.prisma().runWithTenant(TENANT_A, (tx: any) =>
        tx.contactChannelIdentity.create({
          data: {
            tenantId: TENANT_A,
            contactId: otherTenantContact.id,
            channel: 'WHATSAPP',
            externalContactId: 'x',
          },
        }),
      ),
    ).rejects.toThrow(/Foreign key/);
  });

  it('does not deduplicate on email (no uniqueness in the schema)', async () => {
    const first = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WEBCHAT',
      externalContactId: 'v-1',
      email: 'shared@example.com',
    });
    const second = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WEBCHAT',
      externalContactId: 'v-2',
      email: 'shared@example.com',
    });

    expect(first.contact.id).not.toBe(second.contact.id);
    expect(db.contacts).toHaveLength(2);
  });

  it('8. an invalid phone is rejected before any database access', async () => {
    await expect(
      service.findOrCreateByIdentity({
        tenantId: TENANT_A,
        channel: 'WHATSAPP',
        externalContactId: 'wa-1',
        phone: '12345',
      }),
    ).rejects.toBeInstanceOf(InvalidPhoneNumberException);

    expect(db.transactions).toBe(0);
    expect(db.contacts).toHaveLength(0);
    expect(db.identities).toHaveLength(0);
  });

  it('rejects a blank externalContactId', async () => {
    await expect(
      service.findOrCreateByIdentity({ tenantId: TENANT_A, channel: 'WHATSAPP', externalContactId: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transactions).toBe(0);
  });

  it('honors an explicit defaultCountry for national-format phones', async () => {
    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-us',
      phone: '(415) 555-2671',
      defaultCountry: 'US',
    });
    expect(result.contact.phoneE164).toBe('+14155552671');
  });

  describe('concurrency', () => {
    it('9. P2002 on the identity: rolls back, re-reads and returns the winner’s Contact', async () => {
      let winner: Row | undefined;
      // The loser has already missed the identity and created its own Contact
      // when the winner commits Contact + identity for the same external id.
      db.before = (op, tenantId) => {
        if (op === 'identity.create' && !winner) {
          winner = db.commitContact({ tenantId, name: 'Vencedor' });
          db.commitIdentity({ tenantId, contactId: winner.id, channel: 'WHATSAPP', externalContactId: 'wa-1' });
        }
      };

      const result = await service.findOrCreateByIdentity({
        tenantId: TENANT_A,
        channel: 'WHATSAPP',
        externalContactId: 'wa-1',
        name: 'Perdedor',
      });

      expect(result.contact.id).toBe(winner!.id);
      expect(result).toMatchObject({ contactCreated: false, identityCreated: false });
      // exactly 1 Contact + 1 identity: the loser's Contact was rolled back
      expect(db.contacts).toHaveLength(1);
      expect(db.identities).toHaveLength(1);
      expect(db.transactions).toBe(2);
    });

    it('10. P2002 on (tenant, phone) with the SAME identity: resolves to the winner, no duplicate', async () => {
      let winner: Row | undefined;
      db.before = (op, tenantId) => {
        if (op === 'contact.create' && !winner) {
          winner = db.commitContact({ tenantId, phoneE164: '+5541999999999' });
          db.commitIdentity({ tenantId, contactId: winner.id, channel: 'WHATSAPP', externalContactId: 'wa-1' });
        }
      };

      const result = await service.findOrCreateByIdentity({
        tenantId: TENANT_A,
        channel: 'WHATSAPP',
        externalContactId: 'wa-1',
        phone: '(41) 99999-9999',
      });

      expect(result.contact.id).toBe(winner!.id);
      expect(db.contacts).toHaveLength(1);
      expect(db.identities).toHaveLength(1);
      expect(db.transactions).toBe(2);
    });

    it('10b. P2002 on (tenant, phone) from a DIFFERENT identity: reuses that Contact and adds ours', async () => {
      let winner: Row | undefined;
      db.before = (op, tenantId) => {
        if (op === 'contact.create' && !winner) {
          winner = db.commitContact({ tenantId, phoneE164: '+5541999999999' });
          db.commitIdentity({ tenantId, contactId: winner.id, channel: 'WEBCHAT', externalContactId: 'visitor-9' });
        }
      };

      const result = await service.findOrCreateByIdentity({
        tenantId: TENANT_A,
        channel: 'WHATSAPP',
        externalContactId: 'wa-1',
        phone: '(41) 99999-9999',
      });

      expect(result).toMatchObject({ contactCreated: false, identityCreated: true });
      expect(result.contact.id).toBe(winner!.id);
      expect(db.contacts).toHaveLength(1); // no duplicate for the phone
      expect(db.identities.map((i) => i.externalContactId).sort()).toEqual(['visitor-9', 'wa-1']);
      expect(db.identities.every((i) => i.contactId === winner!.id)).toBe(true);
    });

    it('does not retry forever: gives up after 3 attempts and rethrows the P2002', async () => {
      db.before = (op, tenantId) => {
        // every attempt loses to a fresh competitor
        if (op === 'identity.create') {
          const c = db.commitContact({ tenantId });
          db.commitIdentity({ tenantId, contactId: c.id, channel: 'WHATSAPP', externalContactId: 'wa-1' });
        }
      };
      // make the identity lookup miss so every attempt reaches the insert
      const realPrisma = db.prisma();
      const blind = {
        runWithTenant: (tenantId: string, work: any) =>
          realPrisma.runWithTenant(tenantId, (tx: any) =>
            work({
              ...tx,
              contactChannelIdentity: { ...tx.contactChannelIdentity, findUnique: async () => null },
            }),
          ),
      };
      const stubborn = new ContactsService(blind as any);

      await expect(
        stubborn.findOrCreateByIdentity({ tenantId: TENANT_A, channel: 'WHATSAPP', externalContactId: 'wa-1' }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(db.transactions).toBe(3);
    });

    it('does not retry errors that are not unique violations', async () => {
      db.failOnce = { op: 'contact.create', error: new Error('connection reset') };

      await expect(
        service.findOrCreateByIdentity({ tenantId: TENANT_A, channel: 'WHATSAPP', externalContactId: 'wa-1' }),
      ).rejects.toThrow('connection reset');
      expect(db.transactions).toBe(1);
    });
  });

  it('12. a failure while creating the identity leaves no partial Contact behind', async () => {
    db.failOnce = { op: 'identity.create', error: new Error('boom') };

    await expect(
      service.findOrCreateByIdentity({
        tenantId: TENANT_A,
        channel: 'WHATSAPP',
        externalContactId: 'wa-1',
        phone: '(41) 99999-9999',
      }),
    ).rejects.toThrow('boom');

    expect(db.contacts).toHaveLength(0);
    expect(db.identities).toHaveLength(0);

    // and a later call still works normally (idempotent recovery)
    const result = await service.findOrCreateByIdentity({
      tenantId: TENANT_A,
      channel: 'WHATSAPP',
      externalContactId: 'wa-1',
      phone: '(41) 99999-9999',
    });
    expect(result).toMatchObject({ contactCreated: true, identityCreated: true });
    expect(db.contacts).toHaveLength(1);
    expect(db.identities).toHaveLength(1);
  });
});
