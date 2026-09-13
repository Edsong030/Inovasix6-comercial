-- CreateEnum
CREATE TYPE "FollowUpType" AS ENUM ('CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'OTHER');

-- CreateEnum
CREATE TYPE "FollowUpPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CalendarEventType" AS ENUM ('MEETING', 'CALL', 'TASK', 'OTHER');

-- CreateEnum
CREATE TYPE "CalendarEventStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELED');

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "FollowUpType" NOT NULL DEFAULT 'OTHER',
    "priority" "FollowUpPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID,
    "owner_user_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "CalendarEventType" NOT NULL DEFAULT 'MEETING',
    "status" "CalendarEventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_ups_tenant_id_status_scheduled_at_idx" ON "follow_ups"("tenant_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "follow_ups_tenant_id_owner_user_id_scheduled_at_idx" ON "follow_ups"("tenant_id", "owner_user_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "follow_ups_tenant_id_lead_id_idx" ON "follow_ups"("tenant_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_tenant_id_id_key" ON "follow_ups"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "calendar_events_tenant_id_status_starts_at_idx" ON "calendar_events"("tenant_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_events_tenant_id_owner_user_id_starts_at_idx" ON "calendar_events"("tenant_id", "owner_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_events_tenant_id_lead_id_idx" ON "calendar_events"("tenant_id", "lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_tenant_id_id_key" ON "calendar_events"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_tenant_id_owner_user_id_fkey" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_tenant_id_owner_user_id_fkey" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Row Level Security for the two new tenant-owned tables.
--
-- Same idempotent pattern as 20260908194359_add_multi_tenant_rls: ENABLE/FORCE
-- are idempotent, the policy is dropped (IF EXISTS) before being recreated.
-- No existing table, policy, or migration is touched — this only adds
-- follow_ups and calendar_events to the same tenant-isolation strategy.
DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY['follow_ups', 'calendar_events'];
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
