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
import { CalendarEventItem, CalendarEventListResult, CalendarEventsService } from './calendar-events.service';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { ListCalendarEventsQueryDto } from './dto/list-calendar-events.dto';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';

@ApiTags('Agenda')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('calendar/events')
export class CalendarEventsController {
  constructor(private readonly events: CalendarEventsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista eventos de agenda do tenant, ordenados por startsAt.' })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListCalendarEventsQueryDto,
  ): Promise<CalendarEventListResult> {
    return this.events.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe do evento. Cross-tenant retorna 404.' })
  @ApiResponse({ status: 404, description: 'Evento inexistente ou de outro tenant.' })
  getById(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CalendarEventItem> {
    return this.events.getById(ctx, id);
  }

  @Post()
  @ApiOperation({ summary: 'Cria um evento de agenda (status inicial SCHEDULED) no tenant atual.' })
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateCalendarEventDto,
  ): Promise<CalendarEventItem> {
    return this.events.create(ctx, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Atualiza campos do evento (não altera status).' })
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCalendarEventDto,
  ): Promise<CalendarEventItem> {
    return this.events.update(ctx, id, dto);
  }

  @Patch(':id/complete')
  @ApiOperation({ summary: 'Conclui o evento. Idempotente se já concluído; rejeita se cancelado.' })
  @ApiResponse({ status: 409, description: 'Transição inválida (ex.: cancelado -> concluído).' })
  complete(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CalendarEventItem> {
    return this.events.complete(ctx, id);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancela o evento. Idempotente se já cancelado; rejeita se concluído.' })
  @ApiResponse({ status: 409, description: 'Transição inválida (ex.: concluído -> cancelado).' })
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CalendarEventItem> {
    return this.events.cancel(ctx, id);
  }
}
