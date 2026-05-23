const BASE_URL = "https://api.insightsentry.com";
const HISTORY_PLAN_NAMES = new Set(["ultra", "mega", "enterprise"]);
const DEFAULT_RETRY_DELAYS_MS = [500, 1000] as const;
const HISTORY_RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const HISTORY_CONCURRENCY_MAX_RETRIES = 5;
const RETRYABLE_TERMINAL_STATUSES = new Set([408, 429]);

// Symbol code must be EXCHANGE:SYMBOL format (e.g., NASDAQ:AAPL)
const SYMBOL_CODE_PATTERN = /^[A-Z0-9_./-]+:[A-Z0-9_./!-]+$/;

// Parameter names that expect a symbol code
const SYMBOL_PARAM_NAMES = new Set(["symbol", "code", "codes"]);

export class ApiError extends Error {
  readonly status: number;
  readonly apiMessage: string;

  constructor(status: number, apiMessage: string) {
    super(`API error (${status}): ${apiMessage}`);
    this.name = "ApiError";
    this.status = status;
    this.apiMessage = apiMessage;
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
}

export interface ApiPlanEntitlementError {
  key: string;
  error: string;
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

function decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function validateApiPlanEntitlements(
  apiKey: string,
  pathTemplate: string,
): ApiPlanEntitlementError | null {
  if (isHistoryEndpoint(pathTemplate)) {
    const payload = decodeJwtPayload(apiKey);
    const plan = typeof payload?.plan === "string" ? payload.plan.trim().toLowerCase() : "";
    if (HISTORY_PLAN_NAMES.has(plan)) return null;

    return {
      key: "plan",
      error:
        "The /history endpoint requires an Ultra, Mega, or Enterprise plan. Use get_symbol_series for recent data or upgrade your InsightSentry plan for deep historical access.",
    };
  }

  return null;
}

export function isTerminalApiError(error: unknown): boolean {
  if (error instanceof ApiError) return error.terminal;
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(/API error \((\d{3})\):/.exec(message)?.[1]);
  return status >= 400 && status <= 499 && !RETRYABLE_TERMINAL_STATUSES.has(status);
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  let errorMessage: string;
  try {
    const errorJson = JSON.parse(text);
    errorMessage = errorJson.message || errorJson.error || JSON.stringify(errorJson);
  } catch {
    errorMessage = text || `HTTP ${response.status} ${response.statusText}`;
  }
  return new ApiError(response.status, errorMessage);
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

  constructor(apiKey: string, options: ApiClientOptions = {}) {
    this.apiKey = apiKey;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.historyRateLimitRetryDelayMs =
      options.historyRateLimitRetryDelayMs ?? HISTORY_RATE_LIMIT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? sleep;
  }

  async request(method: string, pathTemplate: string, params: Record<string, any>): Promise<any> {
    // Validate symbol codes before making the request
    const symbolError = validateSymbolParams(params);
    if (symbolError) {
      throw new Error(symbolError);
    }
    const planError = validateApiPlanEntitlements(this.apiKey, pathTemplate);
    if (planError) throw new Error(planError.error);

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
      await this.sleep(this.historyRateLimitRetryDelayMs * 2 ** attempt);
      return true;
    }
    if (
      attempt === 0 &&
      isHistoryEndpoint(pathTemplate) &&
      error.status === 429 &&
      isRetryableHistoryRateLimitMessage(error.apiMessage)
    ) {
      await this.waitForHistoryRateLimitPause();
      return true;
    }
    return false;
  }

  private async waitForHistoryRateLimitPause(): Promise<void> {
    if (!this.historyRateLimitPause) {
      const pause = this.sleep(this.historyRateLimitRetryDelayMs).finally(() => {
        if (this.historyRateLimitPause === pause) {
          this.historyRateLimitPause = null;
        }
      });
      this.historyRateLimitPause = pause;
    }
    await this.historyRateLimitPause;
  }
}
