import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PipelinesService, type PipelineView } from './pipelines.service';

@ApiTags('Pipelines')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista os pipelines do tenant com etapas ordenadas.' })
  list(@CurrentTenant() ctx: TenantContext): Promise<PipelineView[]> {
    return this.pipelines.list(ctx);
  }
}
