-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "external_conversation_id" TEXT;

-- CreateTable
CREATE TABLE "contact_channel_identities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "channel" "ConversationChannel" NOT NULL,
    "external_contact_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_channel_identities_tenant_id_contact_id_idx" ON "contact_channel_identities"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_channel_identities_tenant_id_channel_external_conta_key" ON "contact_channel_identities"("tenant_id", "channel", "external_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_channel_external_conversation_id_key" ON "conversations"("tenant_id", "channel", "external_conversation_id");

-- AddForeignKey
ALTER TABLE "contact_channel_identities" ADD CONSTRAINT "contact_channel_identities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_channel_identities" ADD CONSTRAINT "contact_channel_identities_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index: at most one NON-CLOSED conversation per (tenant,
-- contact, channel). This is the DB-level guarantee that closes the race
-- where two concurrent inbound messages for a brand-new thread could each
-- decide "no open conversation, create one" and create two. A losing
-- concurrent insert hits this constraint (P2002) and the caller re-fetches
-- the conversation the winner created instead of duplicating it.
--
-- A plain @@unique([tenantId, contactId, channel]) in the Prisma schema
-- cannot express the "WHERE state <> 'ENCERRADA'" predicate, so — like the
-- RLS policies below — this is hand-written SQL, not schema-generated.
CREATE UNIQUE INDEX "conversations_open_per_contact_channel"
  ON "conversations" ("tenant_id", "contact_id", "channel")
  WHERE "state" <> 'ENCERRADA';

-- Row Level Security for the new tenant-owned table.
--
-- Same idempotent pattern as 20260908194359_add_multi_tenant_rls and
-- 20260909211519_add_followups_and_calendar_events: ENABLE/FORCE are
-- idempotent, the policy is dropped (IF EXISTS) before being recreated. No
-- existing table, policy, or migration is touched — this only adds
-- contact_channel_identities to the same tenant-isolation strategy.
DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY['contact_channel_identities'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END
$$;
