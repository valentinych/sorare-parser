/** Global Mantra-safe scheduler: serialized request starts with a 260ms gap. */

export const REQUEST_START_GAP_MS = 260;

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

export const rateLimit4perSec = createRequestStartScheduler();
