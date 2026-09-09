# RLS & Multi-Tenant Integration Test Plan (post-migration)

These integration tests are BLOCKERS before advancing to WhatsApp/IA. They run
against a real Postgres (the docker-compose instance), after the first migration
and after the RLS policies + two roles are applied. They are NOT executed during
Step 2 because no migration exists yet.

## Setup
- Apply migration as the OWNER role.
- Apply `prisma/rls-proposal.sql` (ENABLE + FORCE + policies) as the OWNER role.
- Connect the test suite as the APPLICATION role (`inovasix_app`,
  NOSUPERUSER / NOBYPASSRLS / non-owner).
- Seed two tenants (A and B), each with a user, contact, pipeline+stage, lead,
  conversation, message.
- All data access in tests goes through `PrismaService.runWithTenant(tenantId, ...)`.

## Scenarios

| # | Scenario | Expectation |
|---|----------|-------------|
| 1 | Tenant A reads its own rows | Rows returned |
| 2 | Tenant A reads Tenant B rows (query without predicate, relying on RLS) | Zero rows |
| 3 | Tenant A UPDATE targeting a Tenant B row id | 0 rows affected (blocked) |
| 4 | Tenant A DELETE targeting a Tenant B row id | 0 rows affected (blocked) |
| 5 | Query run with NO tenant context (no set_config) | Zero rows (fail closed) |
| 6 | Application role privileges | `rolbypassrls = false`, `rolsuper = false`; is not table owner |
| 7 | Insert a child with tenantId=A but parentId belonging to B | FK violation (composite FK rejects) |
| 8 | Insert Message with conversationId of another tenant | FK violation |
| 9 | Insert AuthSession with userId of another tenant | FK violation |

## Notes
- Scenarios 7–9 validate the composite-FK layer independently of RLS: they must
  fail at the constraint level even if RLS were disabled.
- Scenario 6 introspects `pg_roles` for the connected role.
- Scenarios 2–5 validate RLS specifically: they deliberately omit the
  application-level tenant predicate so that only RLS stands between the query
  and the data.
- Test file naming: `*.integration-spec.ts` (see test/jest.integration.json).
