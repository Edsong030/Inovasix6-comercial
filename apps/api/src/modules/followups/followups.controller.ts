import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateFollowUpDto } from './dto/create-followup.dto';
import { ListFollowUpsQueryDto } from './dto/list-followups.dto';
import { RescheduleFollowUpDto } from './dto/reschedule-followup.dto';
import { UpdateFollowUpDto } from './dto/update-followup.dto';
import { FollowUpItem, FollowUpListResult, FollowUpsService } from './followups.service';

@ApiTags('Follow-ups')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista follow-ups do tenant. "Hoje" via from/to; "atrasados" via overdue=true.',
  })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListFollowUpsQueryDto,
  ): Promise<FollowUpListResult> {
    return this.followUps.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe do follow-up. Cross-tenant retorna 404.' })
  @ApiResponse({ status: 404, description: 'Follow-up inexistente ou de outro tenant.' })
  getById(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FollowUpItem> {
    return this.followUps.getById(ctx, id);
  }

  @Post()
  @ApiOperation({ summary: 'Cria um follow-up (status inicial PENDING) para um lead do tenant atual.' })
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateFollowUpDto,
  ): Promise<FollowUpItem> {
    return this.followUps.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza campos do follow-up (não altera status/scheduledAt).' })
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFollowUpDto,
  ): Promise<FollowUpItem> {
    return this.followUps.update(ctx, id, dto);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Conclui o follow-up. Idempotente se já concluído; rejeita se cancelado.' })
  @ApiResponse({ status: 409, description: 'Transição inválida (ex.: cancelado -> concluído).' })
  complete(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FollowUpItem> {
    return this.followUps.complete(ctx, id);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancela o follow-up. Idempotente se já cancelado; rejeita se concluído.' })
  @ApiResponse({ status: 409, description: 'Transição inválida (ex.: concluído -> cancelado).' })
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FollowUpItem> {
    return this.followUps.cancel(ctx, id);
  }

  @Patch(':id/reschedule')
  @ApiOperation({ summary: 'Reagenda um follow-up PENDING para uma nova data/hora.' })
  @ApiResponse({ status: 409, description: 'Follow-up não está PENDING.' })
  reschedule(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleFollowUpDto,
  ): Promise<FollowUpItem> {
    return this.followUps.reschedule(ctx, id, dto.scheduledAt);
  }
}
