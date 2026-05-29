const BASE_URL = "https://api.insightsentry.com";
const DEFAULT_RETRY_DELAYS_MS = [500, 1000] as const;
const HISTORY_RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const HISTORY_CONCURRENCY_MAX_RETRIES = 5;
const RETRY_AFTER_MAX_RETRIES = 5;
const RETRYABLE_TERMINAL_STATUSES = new Set([408, 429]);

// Symbol code must be EXCHANGE:SYMBOL format (e.g., NASDAQ:AAPL)
const SYMBOL_CODE_PATTERN = /^[A-Z0-9_./-]+:[A-Z0-9_./!-]+$/;

// Parameter names that expect a symbol code
const SYMBOL_PARAM_NAMES = new Set(["symbol", "code", "codes"]);

export class ApiError extends Error {
  readonly status: number;
  readonly apiMessage: string;
  readonly body: unknown;
  readonly retryAfterMs: number | null;

  constructor(
    status: number,
    apiMessage: string,
    body: unknown = null,
    retryAfterMs: number | null = null,
  ) {
    super(`API error (${status}): ${apiMessage}`);
    this.name = "ApiError";
    this.status = status;
    this.apiMessage = apiMessage;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.status >= 500 && this.status <= 599;
  }

  get terminal(): boolean {
    return (
      this.status >= 400 && this.status <= 499 && !RETRYABLE_TERMINAL_STATUSES.has(this.status)
    );
  }
}

export interface ApiClientOptions {
  retryDelaysMs?: readonly number[];
  historyRateLimitRetryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: ApiRetryEvent) => void;
}

export interface ApiRetryEvent {
  status: number;
  delayMs: number;
  attempt: number;
  pathTemplate: string;
  reason: string;
}

function validateSymbolParams(params: Record<string, any>): string | null {
  for (const [key, value] of Object.entries(params)) {
    if (!SYMBOL_PARAM_NAMES.has(key) || !value) continue;
    const codes = key === "codes" ? String(value).split(",") : [String(value)];
    for (const code of codes) {
      const trimmed = code.trim();
      if (!SYMBOL_CODE_PATTERN.test(trimmed)) {
        return (
          `Invalid symbol code "${trimmed}". InsightSentry uses EXCHANGE:SYMBOL format (e.g., NASDAQ:AAPL, NYSE:TSLA, BINANCE:BTCUSDT, CME_MINI:NQ1!). ` +
          `Use the search_symbols tool to find the correct symbol code for any asset. ` +
          `Example: search_symbols({ query: "${trimmed}" })`
        );
      }
    }
  }
  return null;
}

function isHistoryEndpoint(pathTemplate: string): boolean {
  return /\/history(?:[/?#]|$)/.test(pathTemplate);
}

export function isTerminalApiError(error: unknown): boolean {
  if (error instanceof ApiError) return error.terminal;
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(/API error \((\d{3})\):/.exec(message)?.[1]);
  return status >= 400 && status <= 499 && !RETRYABLE_TERMINAL_STATUSES.has(status);
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  let errorMessage: string;
  let body: unknown = null;
  try {
    const errorJson = JSON.parse(text);
    body = errorJson;
    errorMessage = errorJson.message || errorJson.error || JSON.stringify(errorJson);
  } catch {
    errorMessage = text || `HTTP ${response.status} ${response.statusText}`;
    body = text || null;
  }
  return new ApiError(response.status, errorMessage, body, retryAfterMs);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableHistoryRateLimitMessage(message: string): boolean {
  return message === "Rate limit exceeded";
}

function isHistoryConcurrencyMessage(message: string): boolean {
  return (
    message.includes("maximum number of concurrent history requests") ||
    message.includes("too many pending history requests queued")
  );
}

export class ApiClient {
  private apiKey: string;
  private retryDelaysMs: readonly number[];
  private historyRateLimitRetryDelayMs: number;
  private historyRateLimitPause: Promise<void> | null = null;
  private sleep: (delayMs: number) => Promise<void>;
  private onRetry?: (event: ApiRetryEvent) => void;

  constructor(apiKey: string, options: ApiClientOptions = {}) {
    this.apiKey = apiKey;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.historyRateLimitRetryDelayMs =
      options.historyRateLimitRetryDelayMs ?? HISTORY_RATE_LIMIT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? sleep;
    this.onRetry = options.onRetry;
  }

  async request(method: string, pathTemplate: string, params: Record<string, any>): Promise<any> {
    // Validate symbol codes before making the request
    const symbolError = validateSymbolParams(params);
    if (symbolError) {
      throw new Error(symbolError);
    }
    // Separate path params from query/body params
    const pathParamNames = [...pathTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

    let path = pathTemplate;
    const remaining: Record<string, any> = {};

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (pathParamNames.includes(key)) {
        path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
      } else {
        remaining[key] = value;
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    let url = `${BASE_URL}${path}`;
    const init: RequestInit = { method, headers };

    if (method === "GET") {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(remaining)) {
        if (value !== undefined && value !== null) {
          searchParams.set(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    } else {
      init.body = JSON.stringify(remaining);
    }

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        const retryDelay = this.retryDelaysMs[attempt];
        if (retryDelay !== undefined) {
          await this.sleep(retryDelay);
          continue;
        }
        throw error;
      }

      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          return response.json();
        }
        return response.text();
      }

      const error = await apiErrorFromResponse(response);
      if (await this.waitForRetry(error, pathTemplate, attempt)) {
        continue;
      }
      throw error;
    }
  }

  private async waitForRetry(
    error: ApiError,
    pathTemplate: string,
    attempt: number,
  ): Promise<boolean> {
    const retryDelay = this.retryDelaysMs[attempt];
    if (error.status === 429 && error.retryAfterMs !== null && attempt < RETRY_AFTER_MAX_RETRIES) {
      await this.sleepWithRetryNotice(
        error,
        pathTemplate,
        attempt,
        error.retryAfterMs,
        "rate limited",
      );
      return true;
    }
    if (error.retryable && retryDelay !== undefined) {
      await this.sleep(retryDelay);
      return true;
    }
    if (isHistoryEndpoint(pathTemplate) && error.status === 408 && retryDelay !== undefined) {
      await this.sleep(retryDelay);
      return true;
    }
    if (
      isHistoryEndpoint(pathTemplate) &&
      error.status === 429 &&
      isHistoryConcurrencyMessage(error.apiMessage) &&
      attempt < HISTORY_CONCURRENCY_MAX_RETRIES
    ) {
      await this.sleepWithRetryNotice(
        error,
        pathTemplate,
        attempt,
        this.historyRateLimitRetryDelayMs * 2 ** attempt,
        "history concurrency limit",
      );
      return true;
    }
    if (
      attempt === 0 &&
      isHistoryEndpoint(pathTemplate) &&
      error.status === 429 &&
      isRetryableHistoryRateLimitMessage(error.apiMessage)
    ) {
      await this.waitForHistoryRateLimitPause(error, pathTemplate, attempt);
      return true;
    }
    return false;
  }

  private async waitForHistoryRateLimitPause(
    error: ApiError,
    pathTemplate: string,
    attempt: number,
  ): Promise<void> {
    if (!this.historyRateLimitPause) {
      const pause = this.sleepWithRetryNotice(
        error,
        pathTemplate,
        attempt,
        this.historyRateLimitRetryDelayMs,
        "history rate limit",
      ).finally(() => {
        if (this.historyRateLimitPause === pause) {
          this.historyRateLimitPause = null;
        }
      });
      this.historyRateLimitPause = pause;
    }
    await this.historyRateLimitPause;
  }

  private async sleepWithRetryNotice(
    error: ApiError,
    pathTemplate: string,
    attempt: number,
    delayMs: number,
    reason: string,
  ): Promise<void> {
    this.onRetry?.({
      status: error.status,
      delayMs,
      attempt,
      pathTemplate,
      reason,
    });
    await this.sleep(delayMs);
  }
}
