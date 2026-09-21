-- Scope the provider thread/session id uniqueness to conversations that are
-- still open.
--
-- The total unique index conversations_tenant_id_channel_external_conversation_id_key
-- kept an external_conversation_id bound to its conversation forever. Once that
-- conversation was ENCERRADA, a new conversation for the same thread (e.g. the
-- same webchat session writing again) could not carry the id and had to be
-- created without it. Uniqueness only matters among OPEN conversations: two
-- open conversations must never share a thread, a closed one is history.
--
-- Created BEFORE the old index is dropped so there is no moment without a
-- guarantee. It is strictly weaker than the index it replaces, so every
-- existing row satisfies it: no data is read or changed.
--
-- The `IS NOT NULL` predicate is redundant for uniqueness (Postgres already
-- treats NULLs as distinct) but states the intent and keeps NULL rows out of
-- the index. Like conversations_open_per_contact_channel, Prisma cannot
-- express a partial unique index, so it is hand-written SQL and not declared
-- in schema.prisma (Prisma ignores partial indexes when diffing).
--
-- conversations_open_per_contact_channel (one open conversation per tenant +
-- contact + channel) is not touched.
CREATE UNIQUE INDEX "conversations_open_external_conversation_id"
  ON "conversations" ("tenant_id", "channel", "external_conversation_id")
  WHERE "external_conversation_id" IS NOT NULL
    AND "state" <> 'ENCERRADA';

-- DropIndex
DROP INDEX "conversations_tenant_id_channel_external_conversation_id_key";
