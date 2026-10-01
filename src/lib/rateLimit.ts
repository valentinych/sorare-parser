/** MantraFootball: serialized starts, ≥260ms gap (≤4 req/s). Do not use for FotMob. */

export const REQUEST_START_GAP_MS = 260;
/** FotMob: 40 req/s → 25ms between starts. Never share with Mantra. */
export const FOTMOB_REQUEST_START_GAP_MS = 25;

export type SchedulerClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export function createRequestStartScheduler(
  minGapMs = REQUEST_START_GAP_MS,
  clock: SchedulerClock = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): () => Promise<void> {
  let lastIssued: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  return async () => {
    const previous = chain;
    let release!: () => void;
    chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (lastIssued != null) {
        const waitMs = minGapMs - (clock.now() - lastIssued);
        if (waitMs > 0) await clock.sleep(waitMs);
      }
      lastIssued = clock.now();
    } finally {
      release();
    }
  };
}

/** MantraFootball only. */
export const rateLimit4perSec = createRequestStartScheduler(REQUEST_START_GAP_MS);
/** FotMob only (40 req/s). */
export const rateLimitFotmob = createRequestStartScheduler(FOTMOB_REQUEST_START_GAP_MS);
