import { rateLimit4perSec } from "../lib/rateLimit.js";

export type MantraRequestStats = {
  requestStarts: number;
  retries: number;
  responses429: number;
};

type RetryOptions = {
  fetchImpl?: typeof fetch;
  schedule?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

const stats: MantraRequestStats = {
  requestStarts: 0,
  retries: 0,
  responses429: 0,
};

export function resetMantraRequestStats(): void {
  stats.requestStarts = 0;
  stats.retries = 0;
  stats.responses429 = 0;
}

export function getMantraRequestStats(): MantraRequestStats {
  return { ...stats };
}

export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export async function mantraFetchWithRetry(
  input: string | URL,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const schedule = options.schedule ?? rateLimit4perSec;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await schedule();
    stats.requestStarts++;
    try {
      const response = await fetchImpl(input, init);
      const retryable = response.status === 429 || response.status >= 500;
      if (response.status === 429) stats.responses429++;
      if (!retryable || attempt === maxAttempts) return response;

      stats.retries++;
      await response.arrayBuffer();
      const delay =
        retryAfterMs(response.headers.get("retry-after")) ??
        Math.min(30_000, 1000 * 2 ** (attempt - 1));
      await sleep(delay);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const cause = (error as { cause?: { code?: string } })?.cause?.code ?? "";
      const retryable =
        /timeout|aborted|ECONNRESET|ECONNREFUSED|UND_ERR|fetch failed/i.test(
          `${message} ${cause}`,
        );
      if (!retryable || attempt === maxAttempts) throw error;
      stats.retries++;
      await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
