-- =============================================================================
-- configure-auth-definer.sql — Activate the login-lookup SECURITY DEFINER.
-- Run by an admin/superuser (privileged) AFTER:
--   1. provision-roles.sql created inovasix_auth_definer, and
--   2. the Prisma migration created public.auth_lookup_login(text, text).
-- Idempotent. No secrets.
--
-- This is the ONLY place the function's DEFINER identity is set. Transferring
-- ownership to inovasix_auth_definer (BYPASSRLS, NOLOGIN) is what makes the
-- function able to read tenants/users under FORCE RLS. The migration itself
-- deliberately leaves the function owned by inovasix_owner (NOBYPASSRLS), so
-- until this script runs the function returns 0 rows.
-- =============================================================================

-- Fail clearly if prerequisites are missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inovasix_auth_definer') THEN
    RAISE EXCEPTION 'Role inovasix_auth_definer does not exist. Run provision-roles.sql first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'auth_lookup_login'
  ) THEN
    RAISE EXCEPTION 'Function public.auth_lookup_login does not exist. Run prisma migrate deploy first.';
  END IF;
END
$$;

-- DEFINER identity: the technical BYPASSRLS role owns the function.
ALTER FUNCTION public.auth_lookup_login(text, text) OWNER TO inovasix_auth_definer;

-- Only the runtime app role may call it. PUBLIC already revoked by the migration.
REVOKE ALL ON FUNCTION public.auth_lookup_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_lookup_login(text, text) TO inovasix_app;
-- The owner runs the dev seed and uses this function to discover the demo
-- tenant id idempotently under RLS. Harmless in prod (seed never runs there).
GRANT EXECUTE ON FUNCTION public.auth_lookup_login(text, text) TO inovasix_owner;
