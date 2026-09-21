import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  Contact,
  Conversation,
  ConversationChannel,
  ConversationState,
  Message,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { ContactsService } from '../contacts/contacts.service';
import type { CountryCode } from '../contacts/phone-number';

/**
 * Total attempts of the persist transaction (1 try + 2 retries), and at most
 * ONE retry per kind of lost race (see LostRace). A lost race means a
 * concurrent request committed the row we tried to create, so a single retry in
 * a fresh transaction already sees it; needing more than that for the same
 * kind means something other than the expected race is going on.
 */
const MAX_PERSIST_ATTEMPTS = 3;
const MAX_RETRIES_PER_RACE_KIND = 1;

export interface ConversationIngressInput {
  /**
   * Trusted tenant, resolved server-side from the channel configuration.
   * NEVER take it from a payload the external party controls.
   */
  tenantId: string;
  channel: ConversationChannel;
  /** Channel-scoped id of the sender (WhatsApp wa_id, webchat visitor id, ...). */
  externalContactId: string;
  /**
   * Provider thread/session id, when the channel has one (webchat session,
   * Instagram thread). Identifies the OPEN conversation of that thread; it
   * anchors a new conversation, or one that has no anchor yet, and never
   * overwrites a different anchor. See resolveConversation.
   */
  externalConversationId?: string | null;
  /**
   * Idempotency key: the provider's message id. First persisted event wins.
   * Unique per TENANT (not per channel) in the schema, so it must be unique
   * across all of a tenant's channels.
   */
  externalMessageId: string;
  /** Passed straight to ContactsService.findOrCreateByIdentity. */
  contact?: {
    name?: string | null;
    /** Already-normalized/verified phone; see FindOrCreateContactByIdentityInput.phone. */
    phone?: string | null;
    email?: string | null;
    defaultCountry?: CountryCode;
  };
  content: string;
  /**
   * When the provider says the message was sent. Stored as Message.createdAt
   * (so the thread reads chronologically) and used for lastMessageAt. Future
   * values are clamped to the time of receipt.
   */
  occurredAt?: Date;
}

export interface ConversationIngressResult {
  contact: Contact;
  conversation: Conversation;
  message: Message;
  contactCreated: boolean;
  identityCreated: boolean;
  conversationCreated: boolean;
  messageCreated: boolean;
  /** externalMessageId was already persisted; `message` is the ORIGINAL one. */
  duplicate: boolean;
}

interface IngressArgs {
  tenantId: string;
  channel: ConversationChannel;
  externalContactId: string;
  externalConversationId: string | null;
  externalMessageId: string;
  content: string;
  /** Message timestamp: min(occurredAt ?? receivedAt, receivedAt). */
  sentAt: Date;
}

type RaceKind = 'conversation' | 'message';

/**
 * Internal signal, thrown from inside the transaction callback so the whole
 * transaction rolls back, that an INSERT lost a race we know how to recover
 * from. Raised per call site (not by inspecting the error), because the
 * installed Prisma reports `meta.target = null` for every unique violation.
 */
class LostRace extends Error {
  constructor(
    readonly kind: RaceKind,
    readonly original: unknown,
  ) {
    super(`Lost ${kind} race`);
  }
}

@Injectable()
export class ConversationIngressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
  ) {}

  /**
   * Turn an already-normalized external message into
   * Contact -> Conversation -> inbound Message, idempotently.
   *
   * Flow:
   *  0. Validate input (no DB).
   *  1. Duplicate check by externalMessageId (tenant-scoped). Found -> return
   *     the original Contact/Conversation/Message, nothing else runs.
   *  2. ContactsService.findOrCreateByIdentity - its OWN transaction.
   *  3. One transaction: re-check duplicate, find/create the Conversation,
   *     create the Message, advance lastMessageAt.
   *
   * Transaction boundary: step 2 commits before step 3 starts (ContactsService
   * owns its transaction so it can retry its own races). If step 3 fails, a
   * Contact/identity may exist with no conversation or message. That is fine:
   * contact resolution is idempotent, and the provider's redelivery of the
   * same event reuses it. Step 3 itself is atomic: a Conversation is never
   * committed without its Message and lastMessageAt.
   *
   * Idempotency: externalMessageId is the key and the FIRST persisted event
   * wins. A redelivery with different content/timestamp returns the original
   * Message untouched. A message id already used by ANOTHER channel of the same
   * tenant is a collision, not a redelivery, and is rejected (409) rather than
   * silently dropped.
   *
   * Concurrency: two first messages can both find "no open conversation" (or
   * both miss the same externalMessageId). The loser's INSERT violates a unique
   * constraint (partial index conversations_open_per_contact_channel, or
   * (tenant, external_id)); its transaction rolls back and the persist step is
   * re-run in a NEW transaction (a failed statement aborts a Postgres
   * transaction, so it cannot continue in the same one), where it finds the
   * winner's row. Retries are limited and only for these two expected races;
   * any other unique violation propagates.
   *
   * @throws BadRequestException (400) on invalid input; InvalidPhoneNumberException (400) on a bad contact phone
   * @throws ConflictException (409) when externalConversationId belongs to another contact, or
   *         externalMessageId was already used by another channel
   */
  async ingest(input: ConversationIngressInput): Promise<ConversationIngressResult> {
    const args = validate(input);
    const { tenantId } = args;

    const alreadyProcessed = await this.prisma.runWithTenant(tenantId, (tx) => findProcessed(tx, args));
    if (alreadyProcessed) return alreadyProcessed;

    const resolved = await this.contacts.findOrCreateByIdentity({
      tenantId,
      channel: args.channel,
      externalContactId: args.externalContactId,
      // Field by field (no spread): nothing in `contact` may override tenantId/channel.
      name: input.contact?.name,
      phone: input.contact?.phone,
      email: input.contact?.email,
      defaultCountry: input.contact?.defaultCountry,
    });

    const retries: Record<RaceKind, number> = { conversation: 0, message: 0 };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.runWithTenant(tenantId, async (tx) => {
          // Re-check inside the transaction: this is what a retry after a lost
          // message race resolves through.
          const processed = await findProcessed(tx, args);
          if (processed) {
            return { ...processed, contactCreated: resolved.contactCreated, identityCreated: resolved.identityCreated };
          }

          const { conversation, created } = await resolveConversation(tx, args, resolved.contact);
          const message = await createMessage(tx, args, conversation.id);
          const current = await advanceLastMessageAt(tx, args, conversation.id, message.createdAt);

          return {
            contact: resolved.contact,
            conversation: current,
            message,
            contactCreated: resolved.contactCreated,
            identityCreated: resolved.identityCreated,
            conversationCreated: created,
            messageCreated: true,
            duplicate: false,
          };
        });
      } catch (error) {
        if (!(error instanceof LostRace)) throw error;
        const exhausted = attempt >= MAX_PERSIST_ATTEMPTS || retries[error.kind] >= MAX_RETRIES_PER_RACE_KIND;
        if (exhausted) throw error.original;
        retries[error.kind]++;
      }
    }
  }
}

function validate(input: ConversationIngressInput): IngressArgs {
  if (!input.tenantId) throw new BadRequestException('tenantId é obrigatório.');
  if (!Object.values(ConversationChannel).includes(input.channel)) {
    throw new BadRequestException('Canal inválido.');
  }
  const externalContactId = input.externalContactId?.trim();
  if (!externalContactId) throw new BadRequestException('Identificador externo do contato é obrigatório.');
  const externalMessageId = input.externalMessageId?.trim();
  if (!externalMessageId) throw new BadRequestException('Identificador externo da mensagem é obrigatório.');
  // Same rule as the agent API (CreateMessageDto): non-empty, no trimming.
  // No upper bound here: providers accept more than the agent API's 4000 (WhatsApp: 4096)
  // and dropping a customer's message over length is worse than storing it.
  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new BadRequestException('Conteúdo da mensagem é obrigatório.');
  }
  if (input.occurredAt !== undefined && Number.isNaN(input.occurredAt.getTime())) {
    throw new BadRequestException('Data da mensagem inválida.');
  }

  const receivedAt = new Date();
  const occurredAt = input.occurredAt ?? receivedAt;
  return {
    tenantId: input.tenantId,
    channel: input.channel,
    externalContactId,
    externalConversationId: input.externalConversationId?.trim() || null,
    externalMessageId,
    content: input.content,
    // A provider clock ahead of ours must not pin lastMessageAt in the future
    // (it only ever moves forward).
    sentAt: occurredAt.getTime() > receivedAt.getTime() ? receivedAt : occurredAt,
  };
}

/** The result for an already-persisted externalMessageId, or null. Tenant-scoped. */
async function findProcessed(tx: TenantTx, args: IngressArgs): Promise<ConversationIngressResult | null> {
  const message = await tx.message.findUnique({
    where: { tenantId_externalId: { tenantId: args.tenantId, externalId: args.externalMessageId } },
    include: { conversation: { include: { contact: true } } },
  });
  if (!message) return null;

  const { conversation: withContact, ...persisted } = message;
  const { contact, ...conversation } = withContact;
  if (conversation.channel !== args.channel) {
    // The unique key is (tenant, external_id), not per channel. Treating this
    // as a redelivery would drop a different message, so refuse it loudly.
    throw new ConflictException('Identificador externo da mensagem já utilizado em outro canal.');
  }

  return {
    contact,
    conversation,
    message: persisted,
    contactCreated: false,
    identityCreated: false,
    conversationCreated: false,
    messageCreated: false,
    duplicate: true,
  };
}

/**
 * Find or create the Conversation for this contact, without ever moving a
 * conversation between contacts or tenants. Only OPEN (not ENCERRADA)
 * conversations take part: a closed one is history, it never blocks a thread id
 * (the unique conversations_open_external_conversation_id is partial) and is
 * never reused.
 *
 *  1. externalConversationId given: look for an OPEN conversation with it in
 *     (tenant, channel). The partial unique guarantees at most one.
 *     - belongs to ANOTHER contact -> 409, never reassigned.
 *     - same contact -> reuse.
 *  2. Otherwise reuse the open conversation of (tenant, contact, channel); the
 *     partial unique conversations_open_per_contact_channel guarantees at most
 *     one.
 *     - anchored to a DIFFERENT thread id: that anchor is kept and the incoming
 *       id is not stored. One open conversation per contact/channel is the hard
 *       rule and the message must not be lost.
 *     - NOT anchored yet: it is anchored with the incoming id ("first anchor
 *       wins"). Safe because step 1 just found no open conversation holding that
 *       id, and the UPDATE only matches while the anchor is still NULL and the
 *       conversation still open; if another request claims the id meanwhile the
 *       partial unique makes this one lose (LostRace) and the retry resolves it
 *       through step 1 (reuse, or 409 if the winner belongs to another contact).
 *  3. Otherwise create one (default state AI_ATENDENDO, no lead) carrying the
 *     incoming externalConversationId.
 */
async function resolveConversation(
  tx: TenantTx,
  args: IngressArgs,
  contact: Contact,
): Promise<{ conversation: Conversation; created: boolean }> {
  const { tenantId, channel, externalConversationId } = args;

  if (externalConversationId) {
    // Prisma has no unique input for a partial index, hence findFirst; every
    // filter (tenant, channel, thread, open) matches the index predicate.
    const byThread = await tx.conversation.findFirst({
      where: { tenantId, channel, externalConversationId, state: { not: ConversationState.ENCERRADA } },
    });
    if (byThread) {
      if (byThread.contactId !== contact.id) {
        throw new ConflictException('Conversa externa pertence a outro contato.');
      }
      return { conversation: byThread, created: false };
    }
  }

  const open = await tx.conversation.findFirst({
    where: { tenantId, contactId: contact.id, channel, state: { not: ConversationState.ENCERRADA } },
    orderBy: { createdAt: 'desc' },
  });
  if (open) {
    if (externalConversationId && open.externalConversationId === null) {
      await anchorOpenConversation(tx, args, open.id, externalConversationId);
    }
    return { conversation: open, created: false };
  }

  try {
    const conversation = await tx.conversation.create({
      data: { tenantId, contactId: contact.id, channel, externalConversationId },
    });
    return { conversation, created: true };
  } catch (error) {
    // Expected: conversations_open_per_contact_channel, or the thread-id
    // unique, when a concurrent request created it first.
    if (isUniqueViolation(error, 'Conversation')) throw new LostRace('conversation', error);
    throw error;
  }
}

/** Sets the thread id on an open, still-unanchored conversation. Never overwrites an existing anchor. */
async function anchorOpenConversation(
  tx: TenantTx,
  args: IngressArgs,
  conversationId: string,
  externalConversationId: string,
): Promise<void> {
  try {
    await tx.conversation.updateMany({
      where: {
        id: conversationId,
        tenantId: args.tenantId,
        externalConversationId: null,
        state: { not: ConversationState.ENCERRADA },
      },
      data: { externalConversationId },
    });
  } catch (error) {
    // Expected: another open conversation claimed this thread id first.
    if (isUniqueViolation(error, 'Conversation')) throw new LostRace('conversation', error);
    throw error;
  }
}

async function createMessage(tx: TenantTx, args: IngressArgs, conversationId: string): Promise<Message> {
  try {
    return await tx.message.create({
      data: {
        tenantId: args.tenantId,
        conversationId,
        direction: MessageDirection.INBOUND,
        status: MessageStatus.DELIVERED,
        senderType: MessageSenderType.CUSTOMER,
        externalId: args.externalMessageId,
        body: args.content,
        createdAt: args.sentAt,
      },
    });
  } catch (error) {
    // Expected: (tenant, external_id) - the same event delivered concurrently.
    if (isUniqueViolation(error, 'Message')) throw new LostRace('message', error);
    throw error;
  }
}

/**
 * lastMessageAt = max(current, sentAt), as ONE conditional UPDATE. Postgres
 * re-evaluates the WHERE against the latest committed row after waiting for a
 * concurrent writer, so concurrent/out-of-order messages can never move it
 * backwards, with no read-modify-write in the application.
 */
async function advanceLastMessageAt(
  tx: TenantTx,
  args: IngressArgs,
  conversationId: string,
  messageAt: Date,
): Promise<Conversation> {
  await tx.conversation.updateMany({
    where: {
      id: conversationId,
      tenantId: args.tenantId,
      OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: messageAt } }],
    },
    data: { lastMessageAt: messageAt },
  });
  return tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
}

function isUniqueViolation(error: unknown, model: 'Conversation' | 'Message'): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const reported = error.meta?.modelName;
  return reported === undefined || reported === model;
}
