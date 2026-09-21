-- Outbound delivery state for messages (outbox / delivery engine).
--
-- Message already has status (PENDING/SENT/DELIVERED/READ/FAILED) and
-- external_id. What it lacked to deliver safely from several API instances:
--   * next_attempt_at   when a PENDING outbound message becomes eligible
--                       (NULL = not in the queue: inbound, MANUAL, historical);
--   * delivery_attempts counted when an attempt is CLAIMED, before the provider
--                       is called, so an attempt that dies mid-flight still counts;
--   * last_attempt_at   observability;
--   * lease_token / lease_expires_at
--                       ownership of an in-flight attempt; an expired lease is
--                       how a message stuck by a crashed worker is recovered;
--   * last_error_code   short machine code, never provider text or PII.
--
-- No new enum value: "in flight" is PENDING with an unexpired lease.
-- No backfill on purpose: existing OUTBOUND/PENDING rows (first-contact replies
-- created before this migration) keep next_attempt_at NULL and stay OUT of the
-- queue, so history is never sent when a real adapter is activated.
--
-- Timestamps are timestamptz so comparisons against now() do not depend on the
-- session TimeZone (the older created_at columns are timestamp without tz).
--
-- Prisma cannot express CHECK constraints or partial indexes: hand-written SQL,
-- ignored by Prisma when diffing (same as conversations_open_per_contact_channel).

ALTER TABLE "messages"
  ADD COLUMN "next_attempt_at"   TIMESTAMPTZ(3),
  ADD COLUMN "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_attempt_at"   TIMESTAMPTZ(3),
  ADD COLUMN "lease_token"       UUID,
  ADD COLUMN "lease_expires_at"  TIMESTAMPTZ(3),
  ADD COLUMN "last_error_code"   VARCHAR(64);

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_delivery_attempts_nonneg"
    CHECK ("delivery_attempts" >= 0),
  -- A lease is a token AND an expiry, never one without the other.
  ADD CONSTRAINT "messages_lease_pair"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  -- Only a PENDING message can be queued or leased. SENT/DELIVERED/READ/FAILED
  -- are terminal for the engine: FAILED can never silently go back to the queue.
  ADD CONSTRAINT "messages_delivery_state_only_pending"
    CHECK ("status" = 'PENDING' OR ("lease_token" IS NULL AND "next_attempt_at" IS NULL)),
  -- Only OUTBOUND messages carry delivery state.
  ADD CONSTRAINT "messages_delivery_state_only_outbound"
    CHECK ("direction" = 'OUTBOUND'
           OR ("next_attempt_at" IS NULL AND "lease_token" IS NULL AND "delivery_attempts" = 0));

-- The live queue only: small, whatever the size of the messages table.
-- tenant_id first: the claim filters one tenant and orders by next_attempt_at;
-- the tenant-discovery function walks it in tenant_id order.
CREATE INDEX "messages_outbound_due_idx"
  ON "messages" ("tenant_id", "next_attempt_at")
  WHERE "direction" = 'OUTBOUND'
    AND "status" = 'PENDING'
    AND "next_attempt_at" IS NOT NULL;

-- Tenant discovery for the delivery worker.
--
-- FORCE RLS hides every tenant from a role without tenant context (tenants is
-- self-isolated too), so the worker cannot even list tenants. Same answer as
-- login (auth_lookup_login): a narrow SECURITY DEFINER function.
--
-- It returns ONLY tenant ids that have a message due for delivery: no body, no
-- contact, no message id, no counts. Everything else (claiming, reading the
-- body, finalizing) happens afterwards under normal RLS via runWithTenant.
--
-- p_after is a keyset cursor over tenant_id so the worker can page through ALL
-- tenants with due messages over successive polls; without it, tenants whose
-- due messages cannot be delivered yet (no adapter for their channel) would
-- sit at the front of every page and starve the others.
--
-- Hardening (same as auth_lookup_login): SECURITY DEFINER, fixed search_path
-- (pg_catalog first, no pg_temp), schema-qualified objects, no dynamic SQL,
-- STABLE, read-only, bounded page size, REVOKE ALL FROM PUBLIC.
--
-- Like auth_lookup_login this migration only CREATES the function (owned by the
-- migration role, NOBYPASSRLS => it returns 0 rows). Ownership transfer to
-- inovasix_auth_definer, the column-level SELECT grant it needs and EXECUTE for
-- the app role are done by infra/postgres/configure-outbound-definer.sql.
CREATE OR REPLACE FUNCTION public.outbound_tenants_with_due_messages(p_limit integer, p_after uuid DEFAULT NULL)
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT m.tenant_id
  FROM public.messages m
  WHERE m.direction = 'OUTBOUND'
    AND m.status = 'PENDING'
    AND m.next_attempt_at <= now()
    AND (m.lease_expires_at IS NULL OR m.lease_expires_at < now())
    AND (p_after IS NULL OR m.tenant_id > p_after)
  GROUP BY m.tenant_id
  ORDER BY m.tenant_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.outbound_tenants_with_due_messages(integer, uuid) FROM PUBLIC;
