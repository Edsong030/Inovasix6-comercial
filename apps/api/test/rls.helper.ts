import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads a specific key from the repo-root .env without extra deps.
 * Integration tests need the app-role and owner-role connection strings.
 */
function readEnv(key: string): string | undefined {
  const candidates = [
    join(__dirname, '..', '..', '..', '.env'),
    join(__dirname, '..', '.env'),
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, 'utf8');
      const line = content
        .split(/\r?\n/)
        .filter((l) => !l.trimStart().startsWith('#'))
        .find((l) => l.startsWith(`${key}=`));
      if (line) return line.slice(key.length + 1).trim();
    } catch {
      // try next candidate
    }
  }
  return process.env[key];
}

/** Prisma client bound to the least-privilege application role (RLS enforced). */
export function makeAppClient(): PrismaClient {
  const url = readEnv('DATABASE_URL_APP') ?? readEnv('DATABASE_URL');
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Prisma client bound to the owner role, used only to seed/cleanup test data. */
export function makeOwnerClient(): PrismaClient {
  const url = readEnv('DATABASE_URL_OWNER') ?? readEnv('DATABASE_URL');
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Run work inside a tenant-scoped transaction, mirroring PrismaService.runWithTenant. */
export async function runWithTenant<T>(
  client: PrismaClient,
  tenantId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return work(tx);
  });
}

export const TENANT_A = '11111111-1111-1111-1111-11111111aaaa';
export const TENANT_B = '22222222-2222-2222-2222-22222222bbbb';
