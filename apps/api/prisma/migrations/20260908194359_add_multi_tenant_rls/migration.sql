-- Multi-tenant Row Level Security.
--
-- Idempotent by design so it is safe against an environment where RLS may have
-- been applied manually (local dev) and safe on a fresh environment via
-- `prisma migrate deploy`. ENABLE/FORCE are idempotent; policies are dropped
-- (IF EXISTS) before being (re)created. No data is touched, no table recreated.
--
-- Strategy (approved):
--   * tenant_id tables: USING/WITH CHECK tenant_id = current_setting('app.current_tenant_id', true)::uuid
--   * tenants (keyed by id): USING/WITH CHECK id = current_setting('app.current_tenant_id', true)::uuid
--   * No tenant context => predicate is NULL/false => fail closed (no rows).
--
-- Roles/grants are NOT part of this migration (no CREATE ROLE / passwords in
-- versioned schema migrations). See infra/postgres/ for role provisioning.

-- Tenant-owned tables carrying a tenant_id column.
DO $$
DECLARE
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'users', 'roles', 'user_roles', 'auth_sessions', 'contacts',
    'pipelines', 'pipeline_stages', 'leads', 'conversations',
    'messages', 'audit_logs'
  ];
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

-- Root tenants table: self-isolation on id.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self_isolation ON public.tenants;
CREATE POLICY tenants_self_isolation ON public.tenants
  USING (id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant_id', true)::uuid);
