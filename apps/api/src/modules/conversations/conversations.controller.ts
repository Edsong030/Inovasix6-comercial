import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AssignConversationDto } from './dto/assign-conversation.dto';
import { ChangeConversationStateDto } from './dto/change-conversation-state.dto';
import { ListConversationsQueryDto } from './dto/list-conversations.dto';
import { ConversationListItem, ConversationListResult, ConversationsService } from './conversations.service';

/**
 * Role gating for Conversations is intentionally NOT decorator-based
 * (no @Roles/RolesGuard): every one of the 4 roles needs Inbox access, and
 * the actual restriction (e.g. "só pode transferir o que é seu") depends on
 * conversation data — who it is currently assigned to — not just the caller's
 * role, so it is enforced inside ConversationsService instead.
 */
@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista conversas do tenant, ordenadas por última mensagem.' })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListConversationsQueryDto,
  ): Promise<ConversationListResult> {
    return this.conversations.list(ctx, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe da conversa. Cross-tenant retorna 404.' })
  @ApiResponse({ status: 404, description: 'Conversa inexistente ou de outro tenant.' })
  getById(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationListItem> {
    return this.conversations.getById(ctx, id);
  }

  @Patch(':id/state')
  @ApiOperation({ summary: 'Altera o estado da conversa (transição validada).' })
  @ApiResponse({ status: 409, description: 'Transição de estado inválida a partir do estado atual.' })
  @ApiResponse({ status: 403, description: 'Encerrar/reabrir exige que a conversa seja do próprio atendente (exceto ADMIN/GESTOR).' })
  changeState(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeConversationStateDto,
  ): Promise<ConversationListItem> {
    return this.conversations.changeState(ctx, id, dto.state);
  }

  @Patch(':id/assign')
  @ApiOperation({ summary: 'Atribui/transfere a conversa para um usuário do mesmo tenant.' })
  @ApiResponse({ status: 409, description: 'A conversa foi atribuída por outro atendente nesse meio tempo.' })
  @ApiResponse({ status: 403, description: 'ATENDENTE/COMERCIAL só pode assumir uma conversa livre ou transferir a que já é sua.' })
  assign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignConversationDto,
  ): Promise<ConversationListItem> {
    return this.conversations.assign(ctx, id, dto.userId);
  }

  @Patch(':id/unassign')
  @ApiOperation({ summary: 'Desatribui a conversa (volta para a fila). Idempotente se já não tiver responsável.' })
  @ApiResponse({ status: 403, description: 'ATENDENTE/COMERCIAL só pode desatribuir uma conversa que já é sua.' })
  unassign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationListItem> {
    return this.conversations.unassign(ctx, id);
  }
}
