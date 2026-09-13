-- Opportunity value on Lead.
--
-- Additive, non-destructive: a single nullable integer column holding the
-- opportunity value in cents (integer avoids float rounding). Feeds the
-- dashboard's pipelineValue and monthlySales aggregations.
--
-- No impact on RLS: `leads` already has ENABLE + FORCE ROW LEVEL SECURITY and
-- the `leads_tenant_isolation` policy, which apply to every column of the row.
-- No table recreation, no FK/index change, no data loss.

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "amount_cents" INTEGER;
