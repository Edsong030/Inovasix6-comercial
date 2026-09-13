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
import { RoleCode } from '@prisma/client';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads.dto';
import { MoveLeadDto } from './dto/move-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadsService, type LeadListItem, type LeadListResult } from './leads.service';

@ApiTags('Leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @Roles(RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL, RoleCode.ATENDENTE)
  @ApiOperation({ summary: 'Lista leads do tenant com busca, filtros e paginação.' })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListLeadsQueryDto,
  ): Promise<LeadListResult> {
    return this.leads.list(ctx, query);
  }

  @Get(':id')
  @Roles(RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL, RoleCode.ATENDENTE)
  @ApiOperation({ summary: 'Detalhe do lead. Cross-tenant retorna 404.' })
  @ApiResponse({ status: 404, description: 'Lead inexistente ou de outro tenant.' })
  getById(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LeadListItem> {
    return this.leads.getById(ctx, id);
  }

  @Post()
  @Roles(RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL, RoleCode.ATENDENTE)
  @ApiOperation({ summary: 'Cria um lead (e o contato associado) no tenant atual.' })
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateLeadDto,
  ): Promise<LeadListItem> {
    return this.leads.create(ctx, dto);
  }

  @Patch(':id')
  @Roles(RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL)
  @ApiOperation({ summary: 'Atualiza campos comerciais do lead.' })
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto,
  ): Promise<LeadListItem> {
    return this.leads.update(ctx, id, dto);
  }

  @Patch(':id/stage')
  @Roles(RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL)
  @ApiOperation({ summary: 'Move o lead para outra etapa do mesmo tenant.' })
  moveStage(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveLeadDto,
  ): Promise<LeadListItem> {
    return this.leads.moveStage(ctx, id, dto.stageId);
  }
}
