import { Injectable } from '@nestjs/common';
import { MessageDirection } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ADVANCES_FROM, META_STATUS_TARGET, failureCode } from './whatsapp-status.policy';
import type { MetaStatus } from './whatsapp-webhook.parser';

/**
 * updated:   the message moved forward
 * noop:      the message exists but is already at (or past) that status: a duplicate or an out-of-order callback
 * unmatched: no outbound message of THIS tenant has that provider id
 */
export type StatusOutcome = 'updated' | 'noop' | 'unmatched';

/**
 * Applies a Meta delivery callback to the outbound Message it is about.
 *
 * The message is found by (tenant, externalId = the wamid the dispatcher stored
 * when Meta accepted it). The tenant is the one the phone_number_id resolved to,
 * so a callback can only ever touch a message of that tenant, and a wamid that
 * belongs to another tenant is simply "unmatched". Only OUTBOUND messages are
 * eligible: an inbound message id can never be moved by a callback.
 *
 * The advance is ONE conditional UPDATE (status in the allowed origin set, see
 * whatsapp-status.policy), so concurrent or repeated callbacks cannot regress a
 * status, and the same callback twice writes nothing the second time.
 *
 * Known limit: Meta may send `delivered` before the dispatcher has stored the
 * wamid of that very message (a millisecond window right after the send). That
 * callback is 'unmatched' and is not retried; the message stays SENT.
 */
@Injectable()
export class WhatsAppStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(input: { tenantId: string; messageId: string; status: MetaStatus; errorCode: string | null }): Promise<StatusOutcome> {
    const { tenantId, messageId, status } = input;

    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const from = ADVANCES_FROM[status];
      if (from.length > 0) {
        const advanced = await tx.message.updateMany({
          where: { tenantId, externalId: messageId, direction: MessageDirection.OUTBOUND, status: { in: [...from] } },
          data: {
            status: META_STATUS_TARGET[status],
            ...(status === 'failed' ? { lastErrorCode: failureCode(input.errorCode) } : {}),
          },
        });
        if (advanced.count > 0) return 'updated';
      }

      const existing = await tx.message.findFirst({
        where: { tenantId, externalId: messageId, direction: MessageDirection.OUTBOUND },
        select: { id: true },
      });
      // Found but not advanced: `sent` confirming what the dispatcher already recorded, a repeat, or a late callback.
      return existing ? 'noop' : 'unmatched';
    });
  }
}
