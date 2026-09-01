/**
 * Minimal FIFO task queue with concurrency + optional start gap (rate limit).
 * Used by Live data-poll / compute workers — not a distributed job system.
 */

export type TaskQueueOptions = {
  concurrency?: number;
  /** Min ms between task starts. */
  minStartGapMs?: number;
  name?: string;
};

export type TaskQueue = {
  name: string;
  size: () => number;
  running: () => number;
  enqueue: <T>(id: string, run: () => Promise<T> | T) => Promise<T>;
  idle: () => Promise<void>;
};

export function createTaskQueue(options: TaskQueueOptions = {}): TaskQueue {
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const minStartGapMs = Math.max(0, options.minStartGapMs ?? 0);
  const name = options.name ?? "queue";

  type Job = {
    id: string;
    run: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };

  const pending: Job[] = [];
  let active = 0;
  let lastStart = 0;
  /** Serializes start-gap waits only — runs may overlap up to `concurrency`. */
  let gapChain: Promise<void> = Promise.resolve();

  const waitGap = (): Promise<void> => {
    if (minStartGapMs <= 0) return Promise.resolve();
    const wait = gapChain.then(async () => {
      const delay = lastStart > 0 ? minStartGapMs - (Date.now() - lastStart) : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      lastStart = Date.now();
    });
    gapChain = wait.then(
      () => undefined,
      () => undefined,
    );
    return wait;
  };

  const kick = (): void => {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift()!;
      active += 1;
      void (async () => {
        try {
          await waitGap();
          const value = await job.run();
          job.resolve(value);
        } catch (err) {
          job.reject(err);
        } finally {
          active -= 1;
          kick();
        }
      })();
    }
  };

  return {
    name,
    size: () => pending.length,
    running: () => active,
    enqueue: <T>(id: string, run: () => Promise<T> | T) =>
      new Promise<T>((resolve, reject) => {
        pending.push({
          id,
          run: async () => run(),
          resolve: (v) => resolve(v as T),
          reject,
        });
        kick();
      }),
    idle: () =>
      new Promise<void>((resolve) => {
        const tick = () => {
          if (active === 0 && pending.length === 0) resolve();
          else setTimeout(tick, 25);
        };
        tick();
      }),
  };
}
