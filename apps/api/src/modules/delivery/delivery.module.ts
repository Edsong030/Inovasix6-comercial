import { Module } from '@nestjs/common';
import { OUTBOUND_CHANNEL_ADAPTERS, OutboundAdapterRegistry } from './outbound-adapter.registry';
import { OutboundDeliveryRepository } from './outbound-delivery.repository';
import { OutboundDispatcherService } from './outbound-dispatcher.service';
import { OutboundWorker } from './outbound-worker.service';

/**
 * Outbound delivery engine: takes OUTBOUND / PENDING messages (automatic or
 * from an agent) and hands them to a channel adapter.
 *
 * No adapter is provided here: a real provider integration contributes its
 * adapter through OUTBOUND_CHANNEL_ADAPTERS; until one does, messages of that
 * channel stay PENDING (and are reported), never falsely SENT. The worker only
 * runs when OUTBOUND_WORKER_ENABLED=true.
 */
@Module({
  providers: [
    { provide: OUTBOUND_CHANNEL_ADAPTERS, useValue: [] },
    OutboundAdapterRegistry,
    OutboundDeliveryRepository,
    OutboundDispatcherService,
    OutboundWorker,
  ],
  exports: [OutboundAdapterRegistry, OutboundDispatcherService, OutboundWorker],
})
export class DeliveryModule {}
