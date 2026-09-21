/**
 * Settings of the outbound delivery engine (see modules/delivery).
 *
 * The RETRY POLICY (attempt limit and backoff) is deliberately NOT tunable by
 * env: it is a product decision (5 attempts, 1 min / 5 min / 15 min / 1 h) that
 * lives in delivery-policy.ts. Only operational knobs are configurable here.
 */

export interface OutboundDeliverySettings {
  /** The polling worker runs only when true. Off by default (and in tests). */
  workerEnabled: boolean;
  /** Pause between polls when there was nothing to do. */
  pollIntervalMs: number;
  /** Messages claimed per tenant per poll; they are sent concurrently. */
  batchSize: number;
  /** How long a claimed message stays reserved for the claiming worker. */
  leaseMs: number;
  /** Hard limit for one adapter.send(); must stay below leaseMs. */
  sendTimeoutMs: number;
}

export const DEFAULT_OUTBOUND_DELIVERY_SETTINGS: OutboundDeliverySettings = {
  workerEnabled: false,
  pollIntervalMs: 2_000,
  batchSize: 10,
  leaseMs: 60_000,
  sendTimeoutMs: 15_000,
};

export const OUTBOUND_POLL_INTERVAL_LIMITS = { min: 200, max: 3_600_000 } as const;
export const OUTBOUND_BATCH_SIZE_LIMITS = { min: 1, max: 50 } as const;
export const OUTBOUND_LEASE_LIMITS = { min: 5_000, max: 600_000 } as const;
export const OUTBOUND_SEND_TIMEOUT_LIMITS = { min: 1_000, max: 120_000 } as const;
