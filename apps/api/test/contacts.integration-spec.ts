import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { InvalidPhoneNumberException } from '../src/modules/contacts/phone-number';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeAppClient, makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * ContactsService.findOrCreateByIdentity against REAL Postgres (app role, RLS
 * enforced). The point of this suite is the concurrency guarantee: parallel
 * first messages for the same identity must end in exactly one Contact and one
 * ContactChannelIdentity, enforced by the database's unique constraints and
 * the service's P2002 handling — which an in-memory fake cannot prove.
 */
describe('ContactsService.findOrCreateByIdentity (integration, real Postgres)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let service: ContactsService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();

  async function counts(tenantId: string) {
    return runWithTenant(ownerPrisma, tenantId, async (tx) => ({
      contacts: await tx.contact.count({ where: { tenantId } }),
      identities: await tx.contactChannelIdentity.count({ where: { tenantId } }),
    }));
  }

  async function wipe(tenantId: string) {
    await runWithTenant(ownerPrisma, tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    service = new ContactsService(appPrisma as unknown as PrismaService);

    for (const [id, slug] of [
      [tenantA, 'contacts-int-a'],
      [tenantB, 'contacts-int-b'],
    ]) {
      await runWithTenant(ownerPrisma, id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
  });

  afterEach(async () => {
    await wipe(tenantA);
    await wipe(tenantB);
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await wipe(tenantId);
      await runWithTenant(ownerPrisma, tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    process.stdout.write(`
`);
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  it('creates Contact + identity, then resolves the same Contact on the next call', async () => {
    const first = await service.findOrCreateByIdentity({
      tenantId: tenantA,
      channel: 'WHATSAPP',
      externalContactId: 'wa-seq',
      name: 'Ana',
      phone: '(41) 99999-9999',
    });
    const second = await service.findOrCreateByIdentity({
      tenantId: tenantA,
      channel: 'WHATSAPP',
      externalContactId: 'wa-seq',
    });

    expect(first).toMatchObject({ contactCreated: true, identityCreated: true });
    expect(first.contact.phoneE164).toBe('+5541999999999');
    expect(second).toMatchObject({ contactCreated: false, identityCreated: false });
    expect(second.contact.id).toBe(first.contact.id);
    expect(await counts(tenantA)).toEqual({ contacts: 1, identities: 1 });
  });

  it('CONCURRENT: same tenant + channel + externalContactId (with phone) -> 1 Contact, 1 identity', async () => {
    for (let round = 0; round < 5; round++) {
      const externalContactId = `wa-race-phone-${round}`;
      const phone = `(41) 98888-77${String(round).padStart(2, '0')}`;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.findOrCreateByIdentity({
            tenantId: tenantA,
            channel: 'WHATSAPP',
            externalContactId,
            phone,
          }),
        ),
      );

      expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
      // exactly one caller actually created the Contact / the identity
      expect(results.filter((r) => r.contactCreated)).toHaveLength(1);
      expect(results.filter((r) => r.identityCreated)).toHaveLength(1);
    }
    expect(await counts(tenantA)).toEqual({ contacts: 5, identities: 5 });
  });

  it('CONCURRENT: same identity WITHOUT phone -> 1 Contact, 1 identity (losers roll back their Contact)', async () => {
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.findOrCreateByIdentity({
            tenantId: tenantA,
            channel: 'WEBCHAT',
            externalContactId: `visitor-race-${round}`,
          }),
        ),
      );
      expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
    }
    // No orphan Contacts left behind by the losing transactions.
    expect(await counts(tenantA)).toEqual({ contacts: 5, identities: 5 });
  });

  it('CONCURRENT: different identities sharing one phone -> 1 Contact, 2 identities', async () => {
    const phone = '+5511977776666';
    const calls = [
      ...Array.from({ length: 4 }, () =>
        service.findOrCreateByIdentity({ tenantId: tenantA, channel: 'WHATSAPP', externalContactId: 'wa-shared', phone }),
      ),
      ...Array.from({ length: 4 }, () =>
        service.findOrCreateByIdentity({ tenantId: tenantA, channel: 'INSTAGRAM', externalContactId: 'ig-shared', phone }),
      ),
    ];
    const results = await Promise.all(calls);

    expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
    expect(await counts(tenantA)).toEqual({ contacts: 1, identities: 2 });
  });

  it('CONCURRENT: same identity + phone in two tenants stays isolated', async () => {
    const input = { channel: 'WHATSAPP' as const, externalContactId: 'wa-both', phone: '+5511966665555' };
    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => service.findOrCreateByIdentity({ ...input, tenantId: tenantA })),
      ...Array.from({ length: 4 }, () => service.findOrCreateByIdentity({ ...input, tenantId: tenantB })),
    ]);

    const inA = results.slice(0, 4);
    const inB = results.slice(4);
    expect(new Set(inA.map((r) => r.contact.id)).size).toBe(1);
    expect(new Set(inB.map((r) => r.contact.id)).size).toBe(1);
    expect(inA[0].contact.id).not.toBe(inB[0].contact.id);
    expect(inA.every((r) => r.contact.tenantId === tenantA)).toBe(true);
    expect(inB.every((r) => r.contact.tenantId === tenantB)).toBe(true);
    expect(await counts(tenantA)).toEqual({ contacts: 1, identities: 1 });
    expect(await counts(tenantB)).toEqual({ contacts: 1, identities: 1 });
  });

  it('tenant A never reuses tenant B’s Contact or identity, even with identical keys', async () => {
    const b = await service.findOrCreateByIdentity({
      tenantId: tenantB,
      channel: 'WHATSAPP',
      externalContactId: 'wa-x',
      phone: '+5511955554444',
    });
    const a = await service.findOrCreateByIdentity({
      tenantId: tenantA,
      channel: 'WHATSAPP',
      externalContactId: 'wa-x',
      phone: '+5511955554444',
    });

    expect(a.contactCreated).toBe(true);
    expect(a.identityCreated).toBe(true);
    expect(a.contact.id).not.toBe(b.contact.id);
  });

  it('rejects an invalid phone without writing anything', async () => {
    await expect(
      service.findOrCreateByIdentity({
        tenantId: tenantA,
        channel: 'WHATSAPP',
        externalContactId: 'wa-bad',
        phone: '12345',
      }),
    ).rejects.toBeInstanceOf(InvalidPhoneNumberException);
    expect(await counts(tenantA)).toEqual({ contacts: 0, identities: 0 });
  });
});
