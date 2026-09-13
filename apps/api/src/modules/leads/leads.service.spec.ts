import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { LeadsService } from './leads.service';
import type { TenantContext } from '../../common/tenant/tenant-context';

/**
 * Unit tests for LeadsService with an in-memory fake of the tenant transaction.
 * RLS is exercised by the integration suite; here we validate the service logic
 * (stage resolution, cross-tenant 404/400, audit calls, mapping).
 */
describe('LeadsService', () => {
  const CTX: TenantContext = { tenantId: 'tenant-a', userId: 'user-a', roleCodes: ['ADMIN'] };

  let stages: Array<{ id: string; tenantId: string; position: number; name: string; pipeline?: unknown }>;
  let contacts: Map<string, any>;
  let leads: Map<string, any>;
  let audits: any[];

  function makeTx() {
    return {
      pipelineStage: {
        findUnique: jest.fn(async ({ where }: any) => stages.find((s) => s.id === where.id) ?? null),
        findFirst: jest.fn(async () => stages[0] ?? null),
      },
      contact: {
        create: jest.fn(async ({ data }: any) => {
          const id = `contact-${contacts.size + 1}`;
          const row = { id, ...data };
          contacts.set(id, row);
          return row;
        }),
      },
      user: {
        findUnique: jest.fn(async ({ where }: any) => (where.id === 'user-a' ? { id: 'user-a', name: 'A' } : null)),
      },
      lead: {
        create: jest.fn(async ({ data }: any) => {
          const id = `lead-${leads.size + 1}`;
          const row = {
            id,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
            contact: contacts.get(data.contactId),
            pipelineStage: stages.find((s) => s.id === data.pipelineStageId),
            owner: null,
          };
          leads.set(id, row);
          return row;
        }),
        findUnique: jest.fn(async ({ where }: any) => leads.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...leads.get(where.id), ...data };
          if (data.pipelineStageId) row.pipelineStage = stages.find((s) => s.id === data.pipelineStageId);
          row.contact = contacts.get(row.contactId);
          leads.set(where.id, row);
          return row;
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: any) => {
          audits.push(data);
          return data;
        }),
      },
    };
  }

  let tx: ReturnType<typeof makeTx>;
  let prisma: any;
  let service: LeadsService;

  beforeEach(() => {
    stages = [
      { id: 'stage-1', tenantId: 'tenant-a', position: 0, name: 'Novo lead' },
      { id: 'stage-2', tenantId: 'tenant-a', position: 1, name: 'Contato realizado' },
    ];
    contacts = new Map();
    leads = new Map();
    audits = [];
    tx = makeTx();
    prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    service = new LeadsService(prisma);
  });

  it('creates a lead, its contact and an audit entry', async () => {
    const lead = await service.create(CTX, { name: 'Maria', amountCents: 5000, source: 'WhatsApp' });
    expect(lead.name).toBe('Maria');
    expect(lead.amountCents).toBe(5000);
    expect(contacts.size).toBe(1);
    expect(audits.some((a) => a.action === 'LEAD_CREATED')).toBe(true);
  });

  it('falls back to the first stage when none is provided', async () => {
    await service.create(CTX, { name: 'Sem etapa' });
    const created = [...leads.values()][0];
    expect(created.pipelineStageId).toBe('stage-1');
  });

  it('rejects a stage that does not belong to the tenant (400)', async () => {
    await expect(
      service.create(CTX, { name: 'X', stageId: 'stage-of-other-tenant' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for a missing/cross-tenant lead on detail', async () => {
    await expect(service.getById(CTX, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('moves a lead to another stage of the same tenant and audits it', async () => {
    const lead = await service.create(CTX, { name: 'Move me' });
    const moved = await service.moveStage(CTX, lead.id, 'stage-2');
    expect(moved.stageId).toBe('stage-2');
    expect(audits.some((a) => a.action === 'LEAD_STAGE_CHANGED')).toBe(true);
  });

  it('rejects moving a lead to a stage of another tenant (400)', async () => {
    const lead = await service.create(CTX, { name: 'Guard' });
    await expect(service.moveStage(CTX, lead.id, 'foreign-stage')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('updates commercial fields and audits', async () => {
    const lead = await service.create(CTX, { name: 'Upd' });
    const updated = await service.update(CTX, lead.id, { status: LeadStatus.WON, amountCents: 9000 });
    expect(updated.status).toBe(LeadStatus.WON);
    expect(updated.amountCents).toBe(9000);
    expect(audits.some((a) => a.action === 'LEAD_UPDATED')).toBe(true);
  });
});
