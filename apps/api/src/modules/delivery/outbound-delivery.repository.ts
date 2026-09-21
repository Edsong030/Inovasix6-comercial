import { Injectable } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OUTBOUND_MAX_ATTEMPTS } from './delivery-policy';

/** A message this worker now holds the lease of. */
export interface ClaimedMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  channel: ConversationChannel;
  body: string | null;
  /** 1-based number of THIS attempt (already counted by the claim). */
  attempt: number;
  leaseToken: string;
  externalConversationId: string | null;
  /** The contact's id on this channel, or null when the contact has none. */
  recipientExternalId: string | null;
}

/** A message the claim moved to FAILED because its attempts ran out (never re-sent). */
export interface ExhaustedMessage {
  id: string;
  conversationId: string;
  attempt: number;
  code: 'LEASE_EXPIRED' | 'ATTEMPTS_EXHAUSTED';
}

export interface ClaimResult {
  claimed: ClaimedMessage[];
  exhausted: ExhaustedMessage[];
}

export interface ClaimOptions {
  /** Channels that have an adapter in this process. Anything else is left untouched. */
  channels: readonly ConversationChannel[];
  batchSize: number;
  leaseMs: number;
}

/** 'sent_external_id_conflict': accepted by the provider and SENT, but the id could not be stored (see markSent). */
export type SentOutcome = 'sent' | 'sent_external_id_conflict' | 'lease_lost';
export type FinalizeOutcome = 'done' | 'lease_lost';

export interface UndeliverableGroup {
  channel: ConversationChannel;
  count: number;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  body: string | null;
  delivery_attempts: number;
  lease_token: string;
  channel: ConversationChannel;
  external_conversation_id: string | null;
  recipient: string | null;
}

/**
 * All SQL of the outbound delivery engine. The state machine lives here so it
 * can be proven against a real PostgreSQL; the dispatcher only orchestrates.
 *
 * Time comes from the DATABASE clock (now()) everywhere: leases and backoff are
 * compared on one clock no matter how many API instances run or how far their
 * own clocks drift. (Writers that enqueue a message use the application clock
 * for next_attempt_at; the skew only delays eligibility by the skew.)
 *
 * The lease protocol:
 *   1. CLAIM (short transaction, committed BEFORE the provider is called):
 *      SELECT ... FOR UPDATE SKIP LOCKED picks due rows nobody else holds,
 *      then the same statement stamps lease_token/lease_expires_at and counts
 *      the attempt. Two concurrent claims can never get the same row: a row
 *      locked by one is skipped by the other, and a row whose lease was just
 *      committed fails the re-evaluated WHERE.
 *   2. SEND happens outside any transaction.
 *   3. FINALIZE (new short transaction): compare-and-set on lease_token. Only
 *      the current holder can move the message to SENT / retry / FAILED. A
 *      worker whose lease expired and was re-claimed finds 0 rows.
 *
 * Crash recovery is the lease expiring: the message is due again. What the
 * engine can NOT know is whether the provider accepted the message before the
 * crash: delivery is AT-LEAST-ONCE (see OutboundDispatcherService).
 */
@Injectable()
export class OutboundDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tenants that have something due, in tenant_id order, after the cursor.
   * Goes through the SECURITY DEFINER function: without a tenant context RLS
   * would hide every row. Returns ids only.
   */
  async discoverTenants(limit: number, after: string | null): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ tenant_id: string }[]>`
      SELECT t AS tenant_id FROM public.outbound_tenants_with_due_messages(${limit}::int, ${after}::uuid) AS t`;
    return rows.map((row) => row.tenant_id);
  }

  /**
   * Claims up to batchSize due messages of one tenant on channels that have an
   * adapter, after first moving messages whose attempts ran out to FAILED.
   */
  async claim(tenantId: string, options: ClaimOptions): Promise<ClaimResult> {
    const channels = options.channels.map(String);
    const leaseSeconds = options.leaseMs / 1000;

    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // A message that used up its attempts is never sent again. Two ways to get
      // here: the last attempt's lease expired (its worker died or hung), or it
      // is PENDING with no attempts left and no lease. FAILED is terminal: the
      // constraints forbid a queue state on it and nothing moves it back.
      const exhausted = await tx.$queryRaw<
        { id: string; conversation_id: string; delivery_attempts: number; code: ExhaustedMessage['code'] }[]
      >`
        UPDATE messages
        SET status = 'FAILED',
            last_error_code = CASE WHEN lease_expires_at IS NULL THEN 'ATTEMPTS_EXHAUSTED' ELSE 'LEASE_EXPIRED' END,
            lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL
        WHERE tenant_id = ${tenantId}::uuid
          AND direction = 'OUTBOUND' AND status = 'PENDING'
          AND next_attempt_at IS NOT NULL
          AND delivery_attempts >= ${OUTBOUND_MAX_ATTEMPTS}
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        RETURNING id, conversation_id, delivery_attempts, last_error_code AS code`;

      let claimed: ClaimedRow[] = [];
      if (channels.length > 0 && options.batchSize > 0) {
        claimed = await tx.$queryRaw<ClaimedRow[]>`
          WITH due AS (
            SELECT m.id
            FROM messages m
            JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
            WHERE m.tenant_id = ${tenantId}::uuid
              AND m.direction = 'OUTBOUND' AND m.status = 'PENDING'
              AND m.next_attempt_at IS NOT NULL AND m.next_attempt_at <= now()
              AND (m.lease_expires_at IS NULL OR m.lease_expires_at < now())
              AND m.delivery_attempts < ${OUTBOUND_MAX_ATTEMPTS}
              AND c.channel <> 'MANUAL'
              AND c.channel::text = ANY(${channels}::text[])
            ORDER BY m.next_attempt_at, m.id
            LIMIT ${options.batchSize}
            FOR UPDATE OF m SKIP LOCKED
          ), claimed AS (
            UPDATE messages m
            SET lease_token = gen_random_uuid(),
                lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::double precision),
                delivery_attempts = m.delivery_attempts + 1,
                last_attempt_at = now()
            FROM due
            WHERE m.id = due.id AND m.tenant_id = ${tenantId}::uuid
            RETURNING m.id, m.tenant_id, m.conversation_id, m.body, m.delivery_attempts, m.lease_token
          )
          SELECT cl.id, cl.tenant_id, cl.conversation_id, cl.body, cl.delivery_attempts, cl.lease_token,
                 c.channel, c.external_conversation_id,
                 (SELECT i.external_contact_id
                    FROM contact_channel_identities i
                   WHERE i.tenant_id = cl.tenant_id AND i.contact_id = c.contact_id AND i.channel = c.channel
                   ORDER BY i.created_at DESC, i.id
                   LIMIT 1) AS recipient
          FROM claimed cl
          JOIN conversations c ON c.tenant_id = cl.tenant_id AND c.id = cl.conversation_id`;
      }

      return {
        exhausted: exhausted.map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          attempt: row.delivery_attempts,
          code: row.code,
        })),
        claimed: claimed.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          conversationId: row.conversation_id,
          channel: row.channel,
          body: row.body,
          attempt: row.delivery_attempts,
          leaseToken: row.lease_token,
          externalConversationId: row.external_conversation_id,
          recipientExternalId: row.recipient,
        })),
      };
    });
  }

  /**
   * The provider accepted the message: SENT (never DELIVERED: that needs the
   * provider's own confirmation) plus its id as Message.externalId.
   *
   * externalId is never overwritten. If the row already carries a DIFFERENT id,
   * or the provider's id is already used by another message of the tenant
   * (unique (tenant_id, external_id)), the message is still marked SENT (the
   * provider did accept it: calling it FAILED would invite a duplicate send),
   * its externalId is left as it was, and last_error_code says
   * EXTERNAL_ID_CONFLICT so it is visible and the caller logs it.
   */
  async markSent(tenantId: string, messageId: string, leaseToken: string, externalMessageId: string): Promise<SentOutcome> {
    try {
      const stored = await this.prisma.runWithTenant(tenantId, (tx) =>
        tx.$queryRaw<{ id: string }[]>`
          UPDATE messages
          SET status = 'SENT', external_id = ${externalMessageId},
              next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
          WHERE id = ${messageId}::uuid AND tenant_id = ${tenantId}::uuid
            AND direction = 'OUTBOUND' AND status = 'PENDING' AND lease_token = ${leaseToken}::uuid
            AND (external_id IS NULL OR external_id = ${externalMessageId})
          RETURNING id`,
      );
      if (stored.length > 0) return 'sent';
    } catch (error) {
      // The transaction is gone with the failed statement; fall through to the
      // fallback below, which runs in a fresh one.
      if (!isUniqueViolation(error)) throw error;
    }

    const kept = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        UPDATE messages
        SET status = 'SENT', next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error_code = 'EXTERNAL_ID_CONFLICT'
        WHERE id = ${messageId}::uuid AND tenant_id = ${tenantId}::uuid
          AND direction = 'OUTBOUND' AND status = 'PENDING' AND lease_token = ${leaseToken}::uuid
        RETURNING id`,
    );
    return kept.length > 0 ? 'sent_external_id_conflict' : 'lease_lost';
  }

  /** Temporary failure with attempts left: back into the queue, eligible again after delayMs. */
  async markRetry(tenantId: string, messageId: string, leaseToken: string, code: string, delayMs: number): Promise<FinalizeOutcome> {
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        UPDATE messages
        SET next_attempt_at = now() + make_interval(secs => ${delayMs / 1000}::double precision),
            lease_token = NULL, lease_expires_at = NULL, last_error_code = ${code}
        WHERE id = ${messageId}::uuid AND tenant_id = ${tenantId}::uuid
          AND direction = 'OUTBOUND' AND status = 'PENDING' AND lease_token = ${leaseToken}::uuid
        RETURNING id`,
    );
    return rows.length > 0 ? 'done' : 'lease_lost';
  }

  /** Permanent failure, or the last attempt failed: FAILED, out of the queue for good. */
  async markFailed(tenantId: string, messageId: string, leaseToken: string, code: string): Promise<FinalizeOutcome> {
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        UPDATE messages
        SET status = 'FAILED', next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL,
            last_error_code = ${code}
        WHERE id = ${messageId}::uuid AND tenant_id = ${tenantId}::uuid
          AND direction = 'OUTBOUND' AND status = 'PENDING' AND lease_token = ${leaseToken}::uuid
        RETURNING id`,
    );
    return rows.length > 0 ? 'done' : 'lease_lost';
  }

  /**
   * Due messages of this tenant that cannot be delivered from this process
   * because their channel has no adapter registered. They stay PENDING; this
   * only lets the dispatcher say so instead of hiding it.
   */
  async countWithoutAdapter(tenantId: string, channels: readonly ConversationChannel[]): Promise<UndeliverableGroup[]> {
    const registered = channels.map(String);
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<{ channel: ConversationChannel; count: number }[]>`
        SELECT c.channel, count(*)::int AS count
        FROM messages m
        JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = ${tenantId}::uuid
          AND m.direction = 'OUTBOUND' AND m.status = 'PENDING'
          AND m.next_attempt_at IS NOT NULL AND m.next_attempt_at <= now()
          AND (m.lease_expires_at IS NULL OR m.lease_expires_at < now())
          AND m.delivery_attempts < ${OUTBOUND_MAX_ATTEMPTS}
          AND c.channel <> 'MANUAL'
          AND NOT (c.channel::text = ANY(${registered}::text[]))
        GROUP BY c.channel`,
    );
    return rows.map((row) => ({ channel: row.channel, count: row.count }));
  }
}

/** Postgres 23505 as Prisma reports it for raw statements (P2010 wraps the driver code) or model writes (P2002). */
function isUniqueViolation(error: unknown): boolean {
  const failure = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return failure?.code === 'P2002' || (failure?.code === 'P2010' && failure.meta?.code === '23505');
}
