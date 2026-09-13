import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DashboardService, type DashboardSummary } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Métricas, funil, follow-ups/agenda de hoje e atividade recente do tenant.',
  })
  summary(@CurrentTenant() ctx: TenantContext): Promise<DashboardSummary> {
    return this.dashboard.summary(ctx);
  }
}
