-- Auth login-lookup function (multi-tenant bootstrap read path).
--
-- Runs as a SECURITY DEFINER so that login can resolve a user by (slug, email)
-- BEFORE any tenant context exists. Login cannot query tenants/users directly:
-- FORCE RLS makes those tables return 0 rows to any NOBYPASSRLS role (proven
-- empirically), including the owner and the app role.
--
-- SPLIT OF RESPONSIBILITIES (approved):
--   * THIS migration (runs as inovasix_owner) only: CREATE FUNCTION + REVOKE
--     ALL FROM PUBLIC. It does NOT transfer ownership and does NOT grant
--     EXECUTE — those require the technical role and are done by the privileged
--     infra script (infra/postgres/configure-auth-definer.sql).
--   * While the function is still owned by inovasix_owner (NOBYPASSRLS), it
--     returns 0 rows. Login only works AFTER the infra step transfers ownership
--     to inovasix_auth_definer (BYPASSRLS). This is intentional and matches the
--     documented bootstrap order.
--
-- Security hardening:
--   * SECURITY DEFINER + fixed search_path (pg_catalog first, then public):
--     built-in functions/operators resolve to trusted objects; pg_temp is NOT
--     on the path, blocking search_path hijacking.
--   * No dynamic SQL. All objects are schema-qualified.
--   * STABLE, read-only. Returns only the fields login needs.
--   * tenant is derived from the public, non-secret slug; no client-provided
--     tenantId is ever trusted.

CREATE OR REPLACE FUNCTION public.auth_lookup_login(p_slug text, p_email text)
RETURNS TABLE (
  tenant_id uuid,
  user_id uuid,
  password_hash text,
  status public."UserStatus",
  role_codes text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT
    u.tenant_id,
    u.id,
    u.password_hash,
    u.status,
    COALESCE(array_agg(r.code::text) FILTER (WHERE r.code IS NOT NULL), '{}')
  FROM public.tenants t
  JOIN public.users u
    ON u.tenant_id = t.id
   AND lower(u.email) = lower(p_email)
  LEFT JOIN public.user_roles ur
    ON ur.tenant_id = u.tenant_id AND ur.user_id = u.id
  LEFT JOIN public.roles r
    ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
  WHERE t.slug = lower(p_slug)
  GROUP BY u.tenant_id, u.id, u.password_hash, u.status;
$$;

-- No implicit access. Ownership transfer + EXECUTE grant happen in the infra
-- step (privileged), not here.
REVOKE ALL ON FUNCTION public.auth_lookup_login(text, text) FROM PUBLIC;
