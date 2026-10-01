export interface RequestLimiterOptions {
  requestsPerMinute: number;
  maxRetries?: number;
  fallbackRetryMs?: number;
  /** Waits before each retry of a gateway/network failure (default 5s, 15s, 45s, 90s, 180s). */
  serverErrorBackoffMs?: number[];
  onRateLimit?: (waitMs: number, attempt: number) => void;
  onServerError?: (status: number | string, waitMs: number, attempt: number) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

type ApiError = Error & {
  status?: number;
  code?: string;
  retryAfter?: string | number;
  data?: { retryAfter?: string | number; retry_after?: string | number };
};

function retryDelay(error: ApiError, fallbackMs: number): number {
  const raw = error.retryAfter ?? error.data?.retryAfter ?? error.data?.retry_after;
  if (raw === undefined) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(String(raw));
  return Number.isNaN(date) ? fallbackMs : Math.max(0, date - Date.now());
}

/** A single shared queue that spaces every API attempt and retries explicit 429 responses. */
export class RequestLimiter {
  private readonly intervalMs: number;
  private readonly maxRetries: number;
  private readonly fallbackRetryMs: number;
  private readonly serverErrorBackoffMs: number[];
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly options: RequestLimiterOptions) {
    if (!Number.isFinite(options.requestsPerMinute) || options.requestsPerMinute <= 0) {
      throw new Error("Requests per minute must be greater than zero");
    }
    this.intervalMs = 60_000 / options.requestsPerMinute;
    this.maxRetries = options.maxRetries ?? 5;
    this.fallbackRetryMs = options.fallbackRetryMs ?? 60_000;
    this.serverErrorBackoffMs = options.serverErrorBackoffMs ?? [5_000, 15_000, 45_000, 90_000, 180_000];
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Queues an API call. Rate limits (429) are always retried. Gateway errors (502/503/504) and
   * network resets are retried only when `safeToRepeat` is set, because repeating a create
   * could make a duplicate if the first attempt actually reached the server.
   */
  schedule<T>(operation: () => Promise<T>, safeToRepeat = false): Promise<T> {
    const result = this.queue.then(() => this.execute(operation, safeToRepeat));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute<T>(operation: () => Promise<T>, safeToRepeat: boolean): Promise<T> {
    let serverAttempts = 0;
    for (let attempt = 0; ; attempt += 1) {
      const spacingWait = Math.max(0, this.nextRequestAt - this.now());
      if (spacingWait > 0) await this.sleep(spacingWait);
      this.nextRequestAt = this.now() + this.intervalMs;

      try {
        return await operation();
      } catch (cause) {
        const error = cause as ApiError;
        const transient = [502, 503, 504].includes(error.status ?? 0)
          || ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"].includes(error.code ?? "");
        if (safeToRepeat && transient && serverAttempts < this.serverErrorBackoffMs.length) {
          const waitMs = this.serverErrorBackoffMs[serverAttempts]!;
          serverAttempts += 1;
          this.options.onServerError?.(error.status ?? error.code ?? "network", waitMs, serverAttempts);
          await this.sleep(waitMs);
          this.nextRequestAt = Math.max(this.nextRequestAt, this.now());
          continue;
        }
        if (error.status !== 429 || attempt >= this.maxRetries) throw cause;
        const waitMs = retryDelay(error, this.fallbackRetryMs);
        this.options.onRateLimit?.(waitMs, attempt + 1);
        await this.sleep(waitMs);
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now());
      }
    }
  }
}
