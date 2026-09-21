import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MetaSignatureGuard, WhatsAppEnabledGuard } from './whatsapp-webhook.guards';
import { WhatsAppWebhookExceptionFilter } from './whatsapp-webhook.filter';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

/**
 * HTTP port of the WhatsApp Cloud API webhook. It only reads the request and
 * delegates: authentication is the guards', every rule is
 * WhatsAppWebhookService's.
 *
 * No rate limit is applied on purpose: a limit keyed by IP would throttle Meta's
 * own servers during a legitimate traffic peak and turn into lost events (Meta
 * would retry, but a limiter is the wrong control). The controls here are the
 * signature (nothing unauthenticated is processed), the 3 MB body cap Meta
 * documents, and idempotent processing.
 */
@ApiTags('Webhooks')
@UseGuards(WhatsAppEnabledGuard)
@UseFilters(WhatsAppWebhookExceptionFilter)
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly webhook: WhatsAppWebhookService) {}

  @Get()
  @ApiOperation({
    summary: 'Verificação do webhook (handshake da Meta).',
    description:
      'Chamado pela Meta ao registrar o webhook no painel. Devolve `hub.challenge` (texto puro) somente quando `hub.mode=subscribe` ' +
      'e `hub.verify_token` confere com o token configurado no servidor. O token nunca é exibido nem registrado em log.',
  })
  @ApiQuery({ name: 'hub.mode', required: true, description: 'Sempre `subscribe`.' })
  @ApiQuery({ name: 'hub.verify_token', required: true, description: 'Token de verificação configurado no painel da Meta.' })
  @ApiQuery({ name: 'hub.challenge', required: true, description: 'Valor aleatório gerado pela Meta, devolvido no corpo.' })
  @ApiResponse({ status: 200, description: 'Token correto: corpo = `hub.challenge` (text/plain).' })
  @ApiResponse({ status: 400, description: 'Parâmetros ausentes ou inválidos.' })
  @ApiResponse({ status: 403, description: 'Token de verificação incorreto.' })
  @ApiResponse({ status: 404, description: 'Integração WhatsApp Cloud desabilitada (`WHATSAPP_CLOUD_ENABLED=false`).' })
  verify(
    @Query('hub.mode') mode: unknown,
    @Query('hub.verify_token') verifyToken: unknown,
    @Query('hub.challenge') challenge: unknown,
    @Res({ passthrough: true }) response: Response,
  ): string {
    const echoed = this.webhook.verifySubscription(mode, verifyToken, challenge);
    response.type('text/plain');
    return echoed;
  }

  @Post()
  @UseGuards(MetaSignatureGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recebe notificações do WhatsApp Cloud API (mensagens e status).',
    description:
      'Autenticação: assinatura `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com o App Secret da Meta). ' +
      'O tenant é resolvido no servidor a partir do `phone_number_id` configurado; nunca é lido do payload. ' +
      'Mensagens de texto viram INBOUND (idempotente pelo id da mensagem) e podem gerar a resposta automática de primeiro contato; ' +
      'callbacks sent/delivered/read/failed atualizam o status das mensagens enviadas, sem nunca regredir. ' +
      'Outros tipos de mensagem/evento são reconhecidos (200) e ignorados. Falha transitória → 503 (a Meta reenvia).',
  })
  @ApiHeader({ name: 'X-Hub-Signature-256', required: true, description: '`sha256=<hex>` do corpo bruto.' })
  @ApiResponse({ status: 200, description: 'Notificação aceita (processada ou ignorada).' })
  @ApiResponse({ status: 400, description: 'Corpo assinado que não é JSON.' })
  @ApiResponse({ status: 401, description: 'Assinatura ausente, malformada ou inválida.' })
  @ApiResponse({ status: 404, description: 'Integração WhatsApp Cloud desabilitada.' })
  @ApiResponse({ status: 413, description: 'Corpo acima de 3 MB.' })
  @ApiResponse({ status: 503, description: 'Falha transitória: a Meta deve reenviar a notificação.' })
  async receive(@Req() request: Request): Promise<{ received: true }> {
    // The body is the raw Buffer the signature was verified against (whatsapp-webhook.http.ts).
    await this.webhook.process(request.body as Buffer);
    return { received: true };
  }
}
