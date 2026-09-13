import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import type { TenantContext } from '../../common/tenant/tenant-context';

export interface PipelineStageView {
  id: string;
  name: string;
  position: number;
}

export interface PipelineView {
  id: string;
  name: string;
  isDefault: boolean;
  stages: PipelineStageView[];
}

@Injectable()
export class PipelinesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All pipelines of the tenant with ordered stages. */
  async list(ctx: TenantContext): Promise<PipelineView[]> {
    return this.prisma.runWithTenant(ctx.tenantId, (tx) => this.listTx(tx));
  }

  /** Shared query, reusable from inside another tenant transaction. */
  async listTx(tx: TenantTx): Promise<PipelineView[]> {
    const pipelines = await tx.pipeline.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: p.isDefault,
      stages: p.stages.map((s) => ({ id: s.id, name: s.name, position: s.position })),
    }));
  }

  /** The default pipeline (or the first) — used to resolve a fallback stage. */
  async getDefault(ctx: TenantContext): Promise<PipelineView> {
    const all = await this.list(ctx);
    const found = all[0];
    if (!found) throw new NotFoundException('Nenhum pipeline configurado.');
    return found;
  }
}
