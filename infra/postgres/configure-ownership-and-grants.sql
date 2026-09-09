-- =============================================================================
-- configure-ownership-and-grants.sql — Ownership + least-privilege grants.
-- Run by an admin/superuser (or owner) AFTER migrations have created the tables.
-- Idempotent. No secrets. No DDL on business tables.
--
-- Order matters: run this AFTER `prisma migrate deploy` so the tables exist.
-- =============================================================================

-- 1) Ensure the OWNER role owns the schema and every table/sequence, so the
--    application role is never a table owner (owners bypass RLS unless FORCE;
--    separate ownership is the primary guarantee, FORCE is the backup).
ALTER SCHEMA public OWNER TO inovasix_owner;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO inovasix_owner;', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO inovasix_owner;', r.sequencename);
  END LOOP;
END
$$;

-- 2) Least-privilege DML grants for the runtime application role.
GRANT CONNECT ON DATABASE inovasix_flow TO inovasix_app;
GRANT USAGE ON SCHEMA public TO inovasix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inovasix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO inovasix_app;

-- 3) Future tables/sequences created by the owner inherit the same DML grants.
ALTER DEFAULT PRIVILEGES FOR ROLE inovasix_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO inovasix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE inovasix_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO inovasix_app;

-- 4) The app role must not create objects and must not touch Prisma bookkeeping.
REVOKE CREATE ON SCHEMA public FROM inovasix_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM inovasix_app;
