import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBasicAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { ConversationIntakeService } from '../conversation-intake.service';
import { CurrentInboundService } from './current-inbound-service.decorator';
import { InboundMessageDto, InboundMessageResultDto } from './dto/inbound-message.dto';
import type { AuthenticatedInboundService } from './inbound-credentials.service';
import { InboundExceptionFilter } from './inbound-exception.filter';
import { InboundServiceGuard } from './inbound-service.guard';

/**
 * Per-IP ceiling for this endpoint, in memory and per process. A safety net
 * against floods and credential probing, not capacity planning: the secrets are
 * long random strings, so guessing is infeasible regardless.
 */
export const INBOUND_RATE_LIMIT = { limit: 600, ttl: 60_000 };

/**
 * HTTP port for channel adapters. It only adapts HTTP to
 * ConversationIntakeService.receive; all business rules (idempotency,
 * Contact/Conversation resolution, tenant isolation, first-contact reply) live
 * in the services behind it.
 *
 * tenantId and channel are taken from the authenticated service credential
 * (InboundServiceGuard), never from the body. Guard order matters: the rate
 * limit runs first so floods are cut before any credential work, and both run
 * before body validation so an unauthenticated caller learns nothing about the
 * schema.
 */
@ApiTags('Inbound')
@ApiBasicAuth('inbound-service')
@UseGuards(ThrottlerGuard, InboundServiceGuard)
@UseFilters(InboundExceptionFilter)
@Throttle({ default: INBOUND_RATE_LIMIT })
@Controller('conversations/inbound')
export class ConversationInboundController {
  private readonly logger = new Logger(ConversationInboundController.name);

  constructor(private readonly intake: ConversationIntakeService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Recebe uma mensagem de cliente vinda de um canal (uso interno, máquina-a-máquina).',
    description:
      'Autenticação: HTTP Basic com `<KEY_ID>:<SERVICE_SECRET>` (credencial de serviço configurada no servidor). ' +
      'O tenant e o canal vêm da credencial; o corpo NÃO aceita `tenantId` nem `channel` (400). ' +
      'Cria/reutiliza Contact e Conversation e grava a mensagem INBOUND. Idempotente por `externalMessageId`: ' +
      '201 quando a mensagem é nova, 200 na reentrega (retorna a mensagem original, sem sobrescrever). ' +
      'Se a mensagem abre o primeiro contato de uma conversa, também é criada UMA resposta automática de acolhimento ' +
      '(mensagem OUTBOUND pendente de envio) e a conversa passa para AGUARDANDO_HUMANO; a resposta desta API não a inclui.',
  })
  @ApiResponse({ status: 201, description: 'Mensagem nova registrada.', type: InboundMessageResultDto })
  @ApiResponse({ status: 200, description: 'Reentrega: externalMessageId já processado (`duplicate: true`).', type: InboundMessageResultDto })
  @ApiResponse({ status: 400, description: 'Corpo inválido, campo desconhecido (inclui tenantId/channel) ou telefone inválido.' })
  @ApiResponse({ status: 401, description: 'Credencial de serviço ausente ou inválida.' })
  @ApiResponse({ status: 409, description: 'externalConversationId pertence a outro contato, ou externalMessageId já usado em outro canal.' })
  @ApiResponse({ status: 429, description: 'Limite de requisições excedido.' })
  async receive(
    @CurrentInboundService() service: AuthenticatedInboundService,
    @Body() dto: InboundMessageDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<InboundMessageResultDto> {
    const result = await this.intake.receive({
      tenantId: service.tenantId,
      channel: service.channel,
      externalContactId: dto.externalContactId,
      externalConversationId: dto.externalConversationId,
      externalMessageId: dto.externalMessageId,
      contact: dto.contact && {
        name: dto.contact.name,
        phone: dto.contact.phone,
        email: dto.contact.email,
        defaultCountry: dto.contact.defaultCountry,
      },
      content: dto.content,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
    });

    response.status(result.duplicate ? HttpStatus.OK : HttpStatus.CREATED);

    // Identifiers only: no content, no phone/email/name.
    this.logger.log({
      event: 'inbound.message',
      keyId: service.keyId,
      tenantId: service.tenantId,
      channel: service.channel,
      externalMessageId: dto.externalMessageId,
      duplicate: result.duplicate,
      conversationId: result.conversation.id,
      autoReply: result.autoReply.reason,
    });

    return {
      duplicate: result.duplicate,
      contactId: result.contact.id,
      conversationId: result.conversation.id,
      messageId: result.message.id,
      contactCreated: result.contactCreated,
      identityCreated: result.identityCreated,
      conversationCreated: result.conversationCreated,
      messageCreated: result.messageCreated,
    };
  }
}
