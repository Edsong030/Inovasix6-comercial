import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import type { WhatsAppCloudAccount } from '../../config/whatsapp-cloud';

/**
 * Which tenant owns which WhatsApp number, and the credential to send from it.
 *
 * This is the ONLY place a webhook's phone_number_id becomes a tenant. The
 * answer comes from server-side configuration, never from a request field: a
 * phone_number_id that is not configured resolves to nothing, so an event for
 * an unknown number can never land in some other tenant.
 *
 * Today the source is WHATSAPP_CLOUD_ACCOUNTS (see config/whatsapp-cloud.ts for
 * why that is enough for now and where it stops scaling). Callers depend on
 * this class, not on the env variable, so an encrypted per-tenant table can
 * replace the source without touching the webhook or the adapter.
 */
@Injectable()
export class WhatsAppAccountResolver {
  constructor(private readonly config: AppConfigService) {}

  /** The account that owns this Meta phone_number_id, or undefined when it is not configured. */
  byPhoneNumberId(phoneNumberId: string): WhatsAppCloudAccount | undefined {
    return this.config.whatsappCloud.accounts.find((account) => account.phoneNumberId === phoneNumberId);
  }

  /** The account a tenant sends from, or undefined when the tenant has no WhatsApp configured. */
  byTenant(tenantId: string): WhatsAppCloudAccount | undefined {
    return this.config.whatsappCloud.accounts.find((account) => account.tenantId === tenantId);
  }
}
