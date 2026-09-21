import { Logger } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import type { AppConfigService } from '../../config/app-config.service';
import { FakeOutboundChannelAdapter } from './fake-outbound-channel.adapter';
import { OutboundAdapterRegistry } from './outbound-adapter.registry';
import type { CycleResult, OutboundDispatcherService } from './outbound-dispatcher.service';
import { OUTBOUND_BUSY_DELAY_MS, OutboundWorker } from './outbound-worker.service';

const idle = (overrides: Partial<CycleResult> = {}): CycleResult => ({
  tenants: 0,
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  leaseLost: 0,
  exhausted: 0,
  finalizeErrors: 0,
  nextCursor: null,
  ...overrides,
});

describe('OutboundWorker', () => {
  const logs: { level: string; payload: any }[] = [];
  let dispatchCycle: jest.Mock;
  let settings: { workerEnabled: boolean; pollIntervalMs: number; batchSize: number; leaseMs: number; sendTimeoutMs: number };
  let worker: OutboundWorker;

  const build = (adapters = [new FakeOutboundChannelAdapter(ConversationChannel.WHATSAPP)]) => {
    worker = new OutboundWorker(
      { dispatchCycle } as unknown as OutboundDispatcherService,
      new OutboundAdapterRegistry(adapters),
      { get outboundDelivery() { return settings; } } as unknown as AppConfigService,
    );
  };
  const events = (name: string) => logs.filter((l) => l.payload?.event === name).map((l) => l.payload);

  beforeEach(() => {
    jest.useFakeTimers();
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => void logs.push({ level, payload: args[0] }));
    }
    dispatchCycle = jest.fn().mockResolvedValue(idle());
    settings = { workerEnabled: true, pollIntervalMs: 1000, batchSize: 10, leaseMs: 60_000, sendTimeoutMs: 15_000 };
    build();
  });

  afterEach(async () => {
    // fake timers do not advance by themselves: let a poll in flight finish so stop() can return
    const stopping = worker.stop();
    await jest.advanceTimersByTimeAsync(60_000);
    await stopping;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('when it may run', () => {
    it('creates no timer and does no work just by being constructed (nothing starts at import/boot of the module)', async () => {
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(dispatchCycle).not.toHaveBeenCalled();
      expect(worker.isRunning).toBe(false);
    });

    it('is OFF by default: bootstrap with OUTBOUND_WORKER_ENABLED=false starts nothing', async () => {
      settings.workerEnabled = false;

      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(worker.isRunning).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      expect(dispatchCycle).not.toHaveBeenCalled();
    });

    it('bootstrap with the worker enabled starts polling', async () => {
      worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      expect(worker.isRunning).toBe(true);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
    });

    it('start() twice runs ONE loop', async () => {
      worker.start();
      worker.start();
      await jest.advanceTimersByTimeAsync(3_500);

      // t=0, 1000, 2000, 3000
      expect(dispatchCycle).toHaveBeenCalledTimes(4);
    });

    it('says so when it starts with no adapter registered (every message would stay PENDING)', () => {
      build([]);
      worker.start();

      expect(events('outbound.worker.no_adapters')).toHaveLength(1);
      expect(events('outbound.worker.started')[0]).toMatchObject({ adapterChannels: [], pollIntervalMs: 1000 });
    });
  });

  describe('polling', () => {
    it('waits the configured interval between polls when idle: no busy-loop', async () => {
      worker.start();

      await jest.advanceTimersByTimeAsync(0);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(999);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(dispatchCycle).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(dispatchCycle).toHaveBeenCalledTimes(12);
    });

    it('polls again quickly (short delay, never zero) while there was work', async () => {
      dispatchCycle.mockResolvedValueOnce(idle({ claimed: 3, sent: 3 })).mockResolvedValue(idle());
      worker.start();

      await jest.advanceTimersByTimeAsync(0);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(OUTBOUND_BUSY_DELAY_MS - 1);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(dispatchCycle).toHaveBeenCalledTimes(2);
      // and then back to the normal pace
      await jest.advanceTimersByTimeAsync(500);
      expect(dispatchCycle).toHaveBeenCalledTimes(2);
    });

    it('passes the cursor of a full page to the next poll, and starts over after the last page', async () => {
      dispatchCycle.mockResolvedValueOnce(idle({ nextCursor: 'tenant-50' })).mockResolvedValueOnce(idle({ nextCursor: null })).mockResolvedValue(idle());
      worker.start();

      // page 1 (busy: more pages) -> page 2 (last, nothing to do: normal interval) -> start over
      await jest.advanceTimersByTimeAsync(OUTBOUND_BUSY_DELAY_MS + settings.pollIntervalMs);

      expect(dispatchCycle.mock.calls[0][0]).toBeNull();
      expect(dispatchCycle.mock.calls[1][0]).toBe('tenant-50');
      expect(dispatchCycle.mock.calls[2][0]).toBeNull();
    });

    it('never runs two polls at once, however slow the provider is', async () => {
      let active = 0;
      let peak = 0;
      dispatchCycle.mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        active -= 1;
        return idle();
      });
      worker.start();

      await jest.advanceTimersByTimeAsync(30_000);

      expect(peak).toBe(1);
      expect(dispatchCycle.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('survives a failing poll: logs its name/code (never its message) and carries on at the normal pace', async () => {
      dispatchCycle
        .mockRejectedValueOnce(Object.assign(new Error('could not reach db at 10.0.0.1 password=hunter2'), { name: 'PrismaClientInitializationError', code: 'P1001' }))
        .mockResolvedValue(idle());
      worker.start();

      await jest.advanceTimersByTimeAsync(0);
      expect(events('outbound.worker.cycle_error')).toEqual([{ event: 'outbound.worker.cycle_error', errorName: 'PrismaClientInitializationError', code: 'P1001' }]);
      expect(JSON.stringify(logs)).not.toMatch(/hunter2|10\.0\.0\.1/);
      expect(worker.isRunning).toBe(true);

      // not retried in a tight loop: the next poll is a full interval away
      await jest.advanceTimersByTimeAsync(999);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(dispatchCycle).toHaveBeenCalledTimes(2);
    });

    it('its timer is unref\'d: it can never keep the process alive on its own', async () => {
      worker.start();

      const timer = (worker as unknown as { timer: NodeJS.Timeout }).timer;
      expect(timer.hasRef()).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('stop() cancels the pending timer: no poll happens afterwards', async () => {
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);

      await worker.stop();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(dispatchCycle).toHaveBeenCalledTimes(1);
      expect(worker.isRunning).toBe(false);
      expect(events('outbound.worker.stopped')).toHaveLength(1);
    });

    it('waits for the poll in flight to finish before resolving, and does not schedule another', async () => {
      let finish!: () => void;
      dispatchCycle.mockImplementationOnce(() => new Promise<CycleResult>((resolve) => (finish = () => resolve(idle({ claimed: 1 })))));
      worker.start();
      await jest.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = worker.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);

      finish();
      await stopping;
      expect(stopped).toBe(true);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(dispatchCycle).toHaveBeenCalledTimes(1);
    });

    it('does not wait forever for a hung poll: gives up after the send timeout plus a short grace', async () => {
      dispatchCycle.mockImplementationOnce(() => new Promise<CycleResult>(() => undefined));
      worker.start();
      await jest.advanceTimersByTimeAsync(0);

      let stopped = false;
      void worker.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(settings.sendTimeoutMs + 4_999);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
    });

    it('onModuleDestroy (Nest shutdown) stops it, and stopping twice is harmless', async () => {
      worker.start();
      await jest.advanceTimersByTimeAsync(0);

      await worker.onModuleDestroy();
      await worker.stop();

      expect(worker.isRunning).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      expect(events('outbound.worker.stopped')).toHaveLength(1);
    });

    it('can be started again after a stop', async () => {
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      await worker.stop();

      worker.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(dispatchCycle).toHaveBeenCalledTimes(2);
    });
  });
});
