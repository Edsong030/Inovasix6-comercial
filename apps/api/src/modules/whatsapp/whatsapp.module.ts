import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { ConversationsModule } from '../conversations/conversations.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { OutboundAdapterRegistry } from '../delivery/outbound-adapter.registry';
import { WhatsAppCloudAdapter } from './outbound/whatsapp-cloud.adapter';
import { WhatsAppAccountResolver } from './whatsapp-account.resolver';
import { WhatsAppWebhookController } from './webhook/whatsapp-webhook.controller';
import { MetaSignatureGuard, WhatsAppEnabledGuard } from './webhook/whatsapp-webhook.guards';
import { WhatsAppStatusService } from './webhook/whatsapp-status.service';
import { WhatsAppWebhookService } from './webhook/whatsapp-webhook.service';

/**
 * WhatsApp Cloud API: the inbound webhook and the outbound adapter.
 *
 * Everything is behind WHATSAPP_CLOUD_ENABLED (false by default): while it is
 * off the webhook answers 404 and NO adapter is registered, so the delivery
 * engine leaves WHATSAPP messages PENDING exactly as before this module existed
 * and nothing can call Meta by accident. Other channels are untouched.
 *
 * The adapter is added to the delivery engine's registry here (onModuleInit,
 * which runs before the worker starts in onApplicationBootstrap), only when the
 * integration is enabled.
 */
@Module({
  imports: [ConversationsModule, DeliveryModule],
  controllers: [WhatsAppWebhookController],
  providers: [WhatsAppAccountResolver, WhatsAppStatusService, WhatsAppWebhookService, WhatsAppCloudAdapter, WhatsAppEnabledGuard, MetaSignatureGuard],
  exports: [WhatsAppAccountResolver, WhatsAppCloudAdapter],
})
export class WhatsappModule implements OnModuleInit {
  private readonly logger = new Logger(WhatsappModule.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly registry: OutboundAdapterRegistry,
    private readonly adapter: WhatsAppCloudAdapter,
  ) {}

  onModuleInit(): void {
    const settings = this.config.whatsappCloud;
    if (!settings.enabled) return;
    this.registry.register(this.adapter);
    this.logger.log({
      event: 'whatsapp.enabled',
      graphApiVersion: settings.graphApiVersion,
      graphApiBaseUrl: settings.graphApiBaseUrl,
      accounts: settings.accounts.length,
    });
  }
}
