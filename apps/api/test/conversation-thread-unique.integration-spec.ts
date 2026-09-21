import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * Database-level guarantees of the two partial unique indexes on
 * `conversations`, against REAL Postgres (no application code involved):
 *
 *  - conversations_open_external_conversation_id
 *      UNIQUE (tenant_id, channel, external_conversation_id)
 *      WHERE external_conversation_id IS NOT NULL AND state <> 'ENCERRADA'
 *    replaced the total unique that kept a thread id bound to a closed
 *    conversation forever (migration 20260921121609).
 *  - conversations_open_per_contact_channel
 *      UNIQUE (tenant_id, contact_id, channel) WHERE state <> 'ENCERRADA'
 *    must keep working, untouched.
 */
describe('conversations partial unique indexes (integration, real Postgres)', () => {
  let owner: PrismaClient;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const thread = 'thread-123';

  const run = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(owner, tenantId, work);

  const newContact = (tenantId: string): Promise<string> =>
    run(tenantId, async (tx) => (await tx.contact.create({ data: { tenantId } })).id);

  const newConversation = (
    tenantId: string,
    contactId: string,
    over: { channel?: any; externalConversationId?: string | null; state?: any } = {},
  ) =>
    run(tenantId, (tx) =>
      tx.conversation.create({
        data: { tenantId, contactId, channel: over.channel ?? 'WEBCHAT', externalConversationId: over.externalConversationId ?? null, state: over.state ?? 'AI_ATENDENDO' },
      }),
    );

  /** Resolves with the Prisma error code the database raised, or null when the write was accepted. */
  const codeOf = (promise: Promise<unknown>): Promise<string | null> =>
    promise.then(
      () => null,
      (e) => e?.code ?? 'UNKNOWN',
    );

  async function wipe(tenantId: string) {
    await run(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  beforeAll(async () => {
    owner = makeOwnerClient();
    for (const [id, slug] of [
      [tenantA, 'thread-uq-a'],
      [tenantB, 'thread-uq-b'],
    ]) {
      await run(id, async (tx) => {
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
      await run(tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await owner.$disconnect();
  });

  it('schema: the partial thread index exists, the old total one is gone, open-per-contact is intact', async () => {
    const rows: Array<{ indexname: string; indexdef: string }> = await owner.$queryRaw`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'conversations'`;
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef;

    const thread = def('conversations_open_external_conversation_id');
    expect(thread).toMatch(/CREATE UNIQUE INDEX/);
    expect(thread).toMatch(/\(tenant_id, channel, external_conversation_id\)/);
    expect(thread).toMatch(/WHERE .*external_conversation_id IS NOT NULL.*state <> 'ENCERRADA'/);

    expect(def('conversations_tenant_id_channel_external_conversation_id_key')).toBeUndefined();

    const perContact = def('conversations_open_per_contact_channel');
    expect(perContact).toMatch(/CREATE UNIQUE INDEX/);
    expect(perContact).toMatch(/\(tenant_id, contact_id, channel\)/);
    expect(perContact).toMatch(/WHERE .*state <> 'ENCERRADA'/);
  });

  it('A) a thread id held by an ENCERRADA conversation can be used again by a new open conversation', async () => {
    const contact = await newContact(tenantA);
    await newConversation(tenantA, contact, { externalConversationId: thread, state: 'ENCERRADA' });

    const reopened = await codeOf(newConversation(tenantA, contact, { externalConversationId: thread, state: 'AI_ATENDENDO' }));

    expect(reopened).toBeNull();
  });

  it('C) an old closed conversation and a new open one can share the thread id (and closed ones can pile up)', async () => {
    const contact = await newContact(tenantA);
    await newConversation(tenantA, contact, { externalConversationId: thread, state: 'ENCERRADA' });
    await newConversation(tenantA, contact, { externalConversationId: thread, state: 'ENCERRADA' });
    await newConversation(tenantA, contact, { externalConversationId: thread, state: 'AI_ATENDENDO' });

    const rows = await run(tenantA, (tx) => tx.conversation.findMany({ where: { tenantId: tenantA, externalConversationId: thread } }));
    expect(rows.map((r: any) => r.state).sort()).toEqual(['AI_ATENDENDO', 'ENCERRADA', 'ENCERRADA']);
  });

  it('B) two OPEN conversations of different contacts cannot hold the same thread id', async () => {
    const [c1, c2] = [await newContact(tenantA), await newContact(tenantA)];
    await newConversation(tenantA, c1, { externalConversationId: thread });

    expect(await codeOf(newConversation(tenantA, c2, { externalConversationId: thread }))).toBe('P2002');
    // AGUARDANDO_HUMANO / HUMANO_ATENDENDO are open too
    expect(await codeOf(newConversation(tenantA, c2, { externalConversationId: thread, state: 'AGUARDANDO_HUMANO' }))).toBe('P2002');
    expect(await codeOf(newConversation(tenantA, c2, { externalConversationId: thread, state: 'HUMANO_ATENDENDO' }))).toBe('P2002');
  });

  it('B) CONCURRENT: 8 contacts racing to open the same thread id -> the database lets exactly one through', async () => {
    const contacts = await Promise.all(Array.from({ length: 8 }, () => newContact(tenantA)));

    const codes = await Promise.all(contacts.map((c) => codeOf(newConversation(tenantA, c, { externalConversationId: thread }))));

    expect(codes.filter((c) => c === null)).toHaveLength(1);
    expect(codes.filter((c) => c === 'P2002')).toHaveLength(7);
    const open = await run(tenantA, (tx) => tx.conversation.count({ where: { tenantId: tenantA, externalConversationId: thread } }));
    expect(open).toBe(1);
  });

  it('a closed conversation cannot be reopened while another open one holds the same thread id', async () => {
    const [c1, c2] = [await newContact(tenantA), await newContact(tenantA)];
    const closed = await newConversation(tenantA, c1, { externalConversationId: thread, state: 'ENCERRADA' });
    await newConversation(tenantA, c2, { externalConversationId: thread });

    const code = await codeOf(run(tenantA, (tx) => tx.conversation.update({ where: { id: closed.id }, data: { state: 'AGUARDANDO_HUMANO' } })));

    expect(code).toBe('P2002');
  });

  it('D) tenant A and tenant B can each have an open conversation with the same thread id', async () => {
    const [ca, cb] = [await newContact(tenantA), await newContact(tenantB)];

    expect(await codeOf(newConversation(tenantA, ca, { externalConversationId: thread }))).toBeNull();
    expect(await codeOf(newConversation(tenantB, cb, { externalConversationId: thread }))).toBeNull();
  });

  it('E) the same thread id on different channels of one tenant does not collide', async () => {
    const [c1, c2] = [await newContact(tenantA), await newContact(tenantA)];

    expect(await codeOf(newConversation(tenantA, c1, { channel: 'WEBCHAT', externalConversationId: thread }))).toBeNull();
    expect(await codeOf(newConversation(tenantA, c2, { channel: 'INSTAGRAM', externalConversationId: thread }))).toBeNull();
    // ...but the same channel still does
    const c3 = await newContact(tenantA);
    expect(await codeOf(newConversation(tenantA, c3, { channel: 'WEBCHAT', externalConversationId: thread }))).toBe('P2002');
  });

  it('conversations without a thread id never collide with each other', async () => {
    const [c1, c2, c3] = [await newContact(tenantA), await newContact(tenantA), await newContact(tenantA)];

    expect(await codeOf(newConversation(tenantA, c1))).toBeNull();
    expect(await codeOf(newConversation(tenantA, c2))).toBeNull();
    expect(await codeOf(newConversation(tenantA, c3, { channel: 'WHATSAPP' }))).toBeNull();
  });

  it('regression: conversations_open_per_contact_channel still allows only one open conversation per contact+channel', async () => {
    const contact = await newContact(tenantA);
    await newConversation(tenantA, contact, { externalConversationId: 'thread-1' });

    // a different thread id does not help: same tenant + contact + channel
    expect(await codeOf(newConversation(tenantA, contact, { externalConversationId: 'thread-2' }))).toBe('P2002');
    expect(await codeOf(newConversation(tenantA, contact))).toBe('P2002');
    // another channel is fine, and so is a closed one
    expect(await codeOf(newConversation(tenantA, contact, { channel: 'INSTAGRAM' }))).toBeNull();
    expect(await codeOf(newConversation(tenantA, contact, { externalConversationId: 'thread-3', state: 'ENCERRADA' }))).toBeNull();
  });

  it('regression: CONCURRENT open conversations for one contact+channel -> exactly one', async () => {
    const contact = await newContact(tenantA);

    const codes = await Promise.all(Array.from({ length: 8 }, () => codeOf(newConversation(tenantA, contact))));

    expect(codes.filter((c) => c === null)).toHaveLength(1);
    expect(codes.filter((c) => c === 'P2002')).toHaveLength(7);
  });
});
