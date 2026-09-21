import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages.dto';
import { MessageItem, MessageListResult, MessagesService } from './messages.service';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('conversations/:conversationId/messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  @ApiOperation({ summary: 'Histórico de mensagens da conversa, ordem cronológica (paginação por cursor).' })
  @ApiResponse({ status: 404, description: 'Conversa inexistente ou de outro tenant.' })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessageListResult> {
    return this.messages.list(ctx, conversationId, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Registra uma mensagem do agente autenticado (OUTBOUND/AGENT).',
    description:
      'Em canal externo (WhatsApp, Instagram, Facebook, Webchat) a mensagem é criada como PENDING e entra na fila do motor de entrega; ' +
      'vira SENT (com externalId) quando o adapter do canal a aceita, e FAILED se a entrega falhar de forma definitiva. ' +
      'Em conversa MANUAL não há provedor externo: a mensagem nasce SENT.',
  })
  @ApiResponse({ status: 404, description: 'Conversa inexistente ou de outro tenant.' })
  @ApiResponse({ status: 409, description: 'Conversa encerrada não aceita novas mensagens.' })
  send(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: CreateMessageDto,
  ): Promise<MessageItem> {
    return this.messages.send(ctx, conversationId, dto);
  }
}
