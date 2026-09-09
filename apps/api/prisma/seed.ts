import { PrismaClient, RoleCode, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

/**
 * DEV seed only. Creates a demo tenant + admin user so the local API can be
 * exercised. NEVER run against production.
 *
 * The admin password comes from SEED_ADMIN_PASSWORD (no hardcoded secret). The
 * seed connects as the OWNER role (DATABASE_URL_OWNER) and sets a tenant
 * context so RLS WITH CHECK is satisfied on insert.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed in production.');
  }

  const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('Set SEED_ADMIN_PASSWORD to seed the demo admin.');
  }

  const slug = 'inovasix-demo';
  const email = 'edson@demo.local';
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const tenantId = randomUUID();
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // Idempotent: skip if the demo tenant already exists (look up by slug via
      // a raw query is blocked by RLS here, so we rely on a deterministic guard
      // using the unique slug through an upsert-like insert guarded by count).
      const existing = await tx.tenant.findFirst({ where: { slug } });
      if (existing) {
        // eslint-disable-next-line no-console
        console.log(`Demo tenant already present (${existing.id}); nothing to do.`);
        return;
      }

      const tenant = await tx.tenant.create({
        data: { id: tenantId, name: 'Inovasix Demo', slug, timezone: 'America/Sao_Paulo' },
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          name: 'Edson',
          passwordHash,
          status: UserStatus.ACTIVE,
        },
      });

      const role = await tx.role.create({
        data: { tenantId: tenant.id, code: RoleCode.ADMIN, name: 'Administrador' },
      });

      await tx.userRole.create({
        data: { tenantId: tenant.id, userId: admin.id, roleId: role.id },
      });

      // eslint-disable-next-line no-console
      console.log(`Seeded tenant "${slug}" with admin ${email} (login uses slug + email).`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
