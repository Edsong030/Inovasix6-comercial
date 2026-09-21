-- =============================================================================
-- configure-outbound-definer.sql — Activate the outbound tenant-discovery
-- SECURITY DEFINER.
-- Run by an admin/superuser (privileged) AFTER:
--   1. provision-roles.sql created inovasix_auth_definer, and
--   2. the Prisma migration add_outbound_delivery_state created
--      public.outbound_tenants_with_due_messages(integer, uuid).
-- Idempotent. No secrets.
--
-- Same split of responsibilities as configure-auth-definer.sql: the migration
-- creates the function owned by the (NOBYPASSRLS) migration role, so until this
-- script runs it returns 0 rows and the delivery worker finds nothing to do.
--
-- LEAST PRIVILEGE. The DEFINER role is the only BYPASSRLS role. For this
-- function it gets column-level SELECT on FIVE columns of messages, exactly the
-- ones the function reads to decide "is there something due for this tenant":
--   tenant_id, direction, status, next_attempt_at, lease_expires_at.
-- It does NOT get body, external_id, sender, conversation_id, contact data or
-- any other column, and the function returns tenant ids only.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inovasix_auth_definer') THEN
    RAISE EXCEPTION 'Role inovasix_auth_definer does not exist. Run provision-roles.sql first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'outbound_tenants_with_due_messages'
  ) THEN
    RAISE EXCEPTION 'Function public.outbound_tenants_with_due_messages does not exist. Run prisma migrate deploy first.';
  END IF;
END
$$;

-- Column-level read access only (RLS is bypassed by the role, but a table or
-- column privilege is still required).
GRANT USAGE ON SCHEMA public TO inovasix_auth_definer;
GRANT SELECT (tenant_id, direction, status, next_attempt_at, lease_expires_at)
  ON public.messages TO inovasix_auth_definer;

-- DEFINER identity: the technical BYPASSRLS role owns the function.
ALTER FUNCTION public.outbound_tenants_with_due_messages(integer, uuid) OWNER TO inovasix_auth_definer;

-- Only the runtime app role may call it. PUBLIC already revoked by the migration.
REVOKE ALL ON FUNCTION public.outbound_tenants_with_due_messages(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.outbound_tenants_with_due_messages(integer, uuid) TO inovasix_app;
