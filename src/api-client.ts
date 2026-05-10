const BASE_URL = "https://api.insightsentry.com";
const HISTORY_PLAN_NAMES = new Set(["ultra", "mega", "enterprise"]);

// Symbol code must be EXCHANGE:SYMBOL format (e.g., NASDAQ:AAPL)
const SYMBOL_CODE_PATTERN = /^[A-Z0-9_./-]+:[A-Z0-9_./!-]+$/;

// Parameter names that expect a symbol code
const SYMBOL_PARAM_NAMES = new Set(["symbol", "code", "codes"]);

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

function validateHistoryPlan(apiKey: string, pathTemplate: string): void {
  if (!isHistoryEndpoint(pathTemplate)) return;

  const payload = decodeJwtPayload(apiKey);
  const plan = typeof payload?.plan === "string" ? payload.plan.trim().toLowerCase() : "";
  if (HISTORY_PLAN_NAMES.has(plan)) return;

  throw new Error(
    "The /history endpoint requires an Ultra, Mega, or Enterprise plan. Use get_symbol_series for recent data or upgrade your InsightSentry plan for deep historical access.",
  );
}

export class ApiClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async request(method: string, pathTemplate: string, params: Record<string, any>): Promise<any> {
    // Validate symbol codes before making the request
    const symbolError = validateSymbolParams(params);
    if (symbolError) {
      throw new Error(symbolError);
    }
    validateHistoryPlan(this.apiKey, pathTemplate);

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

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(text);
        errorMessage = errorJson.message || errorJson.error || JSON.stringify(errorJson);
      } catch {
        errorMessage = text || `HTTP ${response.status} ${response.statusText}`;
      }
      throw new Error(`API error (${response.status}): ${errorMessage}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }
}
