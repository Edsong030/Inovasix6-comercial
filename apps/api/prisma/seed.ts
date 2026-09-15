import { LeadStatus, PrismaClient, RoleCode, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

/**
 * DEV seed only. Idempotent. Creates the demo tenant, admin, a "Comercial"
 * pipeline with 7 stages and a handful of fictional leads so the CRM/Dashboard
 * render real data. NEVER run against production. All people are fictional.
 *
 * Connects as the OWNER role and sets the tenant context so RLS WITH CHECK is
 * satisfied on insert.
 */

const SLUG = 'inovasix-demo';
const ADMIN_EMAIL = 'edson@demo.local';
const PIPELINE_NAME = 'Comercial';
const STAGES = [
  'Novo lead',
  'Contato realizado',
  'Em atendimento',
  'Qualificado',
  'Proposta enviada',
  'Negociação',
  'Cliente (Ganho)',
];

interface DemoLead {
  contact: string;
  email: string;
  stageIndex: number;
  amountCents: number;
  status: LeadStatus;
  source: string;
  interest: string;
  nextInDays: number | null;
}

const DEMO_LEADS: DemoLead[] = [
  { contact: 'Maria Silva', email: 'maria@exemplo.test', stageIndex: 0, amountCents: 240000, status: LeadStatus.OPEN, source: 'WhatsApp', interest: 'Silva & Cia', nextInDays: 0 },
  { contact: 'Rafael Nunes', email: 'rafael@exemplo.test', stageIndex: 1, amountCents: 120000, status: LeadStatus.OPEN, source: 'Instagram', interest: 'Nunes Odonto', nextInDays: 0 },
  { contact: 'João Oliveira', email: 'joao@exemplo.test', stageIndex: 2, amountCents: 310000, status: LeadStatus.OPEN, source: 'Site', interest: 'Oliveira Log', nextInDays: 1 },
  { contact: 'Ana Costa', email: 'ana@exemplo.test', stageIndex: 3, amountCents: 450000, status: LeadStatus.OPEN, source: 'WhatsApp', interest: 'Costa Imóveis', nextInDays: 0 },
  { contact: 'Carlos Mendes', email: 'carlos@exemplo.test', stageIndex: 4, amountCents: 620000, status: LeadStatus.OPEN, source: 'WhatsApp', interest: 'Mendes Engenharia', nextInDays: 2 },
  { contact: 'Paulo Lima', email: 'paulo@exemplo.test', stageIndex: 5, amountCents: 890000, status: LeadStatus.OPEN, source: 'Indicação', interest: 'Lima Distribuidora', nextInDays: 0 },
  { contact: 'Mariana Souza', email: 'mariana@exemplo.test', stageIndex: 6, amountCents: 370000, status: LeadStatus.WON, source: 'WhatsApp', interest: 'Souza Advocacia', nextInDays: null },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed in production.');
  }

  const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('Set SEED_ADMIN_PASSWORD to seed the demo admin.');
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    // Resolve or create the tenant id first (outside RLS context we cannot read,
    // so we discover it by setting a context we do not yet know — instead we
    // create with a fresh id and, if the slug exists, reuse it via a fixed id).
    const tenantId = await ensureTenant(prisma, passwordHash);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

      // Pipeline (idempotent by unique [tenantId, name]).
      let pipeline = await tx.pipeline.findFirst({ where: { name: PIPELINE_NAME } });
      pipeline ??= await tx.pipeline.create({
        data: { tenantId, name: PIPELINE_NAME, isDefault: true },
      });

      // Stages (idempotent by unique [tenantId, pipelineId, position]).
      const stageIds: string[] = [];
      for (let position = 0; position < STAGES.length; position++) {
        const existing = await tx.pipelineStage.findFirst({
          where: { pipelineId: pipeline.id, position },
        });
        const stage =
          existing ??
          (await tx.pipelineStage.create({
            data: { tenantId, pipelineId: pipeline.id, name: STAGES[position], position },
          }));
        stageIds.push(stage.id);
      }

      // Demo leads — only seed if none exist yet (keeps the seed idempotent).
      const leadCount = await tx.lead.count();
      if (leadCount === 0) {
        const now = Date.now();
        for (const demo of DEMO_LEADS) {
          const contact = await tx.contact.create({
            data: { tenantId, name: demo.contact, email: demo.email },
          });
          await tx.lead.create({
            data: {
              tenantId,
              contactId: contact.id,
              pipelineStageId: stageIds[demo.stageIndex],
              amountCents: demo.amountCents,
              status: demo.status,
              source: demo.source,
              interest: demo.interest,
              nextActionAt:
                demo.nextInDays === null
                  ? null
                  : new Date(now + demo.nextInDays * 24 * 60 * 60 * 1000),
            },
          });
        }
        // eslint-disable-next-line no-console
        console.log(`Seeded ${DEMO_LEADS.length} demo leads into "${PIPELINE_NAME}".`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`Leads already present (${leadCount}); skipping lead seed.`);
      }
    });

    // eslint-disable-next-line no-console
    console.log(`Seed complete for tenant "${SLUG}" (admin ${ADMIN_EMAIL}).`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Returns the demo tenant id, creating the tenant + admin + ADMIN role if it
 * does not exist yet.
 *
 * Idempotency under RLS: we first discover any existing tenant id via the
 * `auth_lookup_login` SECURITY DEFINER function (BYPASSRLS), which returns the
 * tenant_id for the known (slug, admin email). If found, we reuse that id; if
 * not, we create the tenant with a fresh id under its own context.
 */
async function ensureTenant(prisma: PrismaClient, passwordHash: string): Promise<string> {
  const found = await prisma.$queryRaw<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM auth_lookup_login(${SLUG}, ${ADMIN_EMAIL})
  `;
  if (found[0]?.tenant_id) return found[0].tenant_id;

  const tenantId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    const tenant = await tx.tenant.create({
      data: { id: tenantId, name: 'Inovasix Demo', slug: SLUG, timezone: 'America/Sao_Paulo' },
    });
    const admin = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: ADMIN_EMAIL,
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
  });
  return tenantId;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
