/**
 * Build script: reads openapi.json and generates tool-definitions.ts with Zod schemas
 * Run with: npx tsx scripts/generate.ts
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface OpenAPISpec {
  paths: Record<string, Record<string, any>>;
  components: {
    schemas: Record<string, any>;
    parameters: Record<string, any>;
    responses: Record<string, any>;
  };
}

// Manual tool name mapping for clean, intuitive names
const TOOL_NAME_MAP: Record<string, Record<string, string>> = {
  "/v3/symbols/{symbol}/series": { get: "get_symbol_series" },
  "/v3/symbols/{symbol}/history": { get: "get_symbol_history" },
  "/v3/symbols/{symbol}/info": { get: "get_symbol_info" },
  "/v3/symbols/{symbol}/session": { get: "get_symbol_session" },
  "/v3/symbols/{symbol}/contracts": { get: "get_symbol_contracts" },
  "/v3/symbols/quotes": { get: "get_quotes" },
  "/v3/symbols/search": { get: "search_symbols" },
  "/v3/symbols/{symbol}/fundamentals": { get: "get_symbol_fundamentals" },
  "/v3/symbols/{symbol}/fundamentals/series": {
    get: "get_fundamentals_series",
  },
  "/v3/symbols/fundamentals": { get: "get_fundamentals_meta" },
  "/v3/options/list": { get: "list_options" },
  "/v3/options/expiration": { get: "get_options_expiration" },
  "/v3/options/strike": { get: "get_options_strike" },
  "/v3/screeners/stock": {
    get: "get_stock_screener_params",
    post: "screen_stocks",
  },
  "/v3/screeners/etf": {
    get: "get_etf_screener_params",
    post: "screen_etfs",
  },
  "/v3/screeners/bond": {
    get: "get_bond_screener_params",
    post: "screen_bonds",
  },
  "/v3/screeners/crypto": {
    get: "get_crypto_screener_params",
    post: "screen_crypto",
  },
  "/v3/calendar/dividends": { get: "get_dividends" },
  "/v3/calendar/earnings": { get: "get_earnings" },
  "/v3/calendar/ipos": { get: "get_ipos" },
  "/v3/calendar/events": { get: "get_events" },
  "/v3/newsfeed": { get: "get_newsfeed" },
  "/v3/documents": { get: "get_documents" },
  "/v3/documents/{id}": { get: "get_document" },
};

// Skip RapidAPI-only endpoints
const SKIP_PATHS = new Set(["/v2/websocket-key"]);

// Workflow hints appended to tool descriptions to guide AI on next steps
const WORKFLOW_HINTS: Record<string, string> = {
  search_symbols:
    " → Returns {current_page: number, has_more: boolean, symbols: [{name: string, code: string, type: string, exchange: string, currency_code: string, country: string, description: string}]}. ALWAYS start here to find the correct symbol code unless you already know the correct symbol code. InsightSentry uses EXCHANGE:SYMBOL format (e.g., NASDAQ:AAPL) which differs from other platforms. Do NOT guess codes — search first. Use the returned code with get_quotes, get_symbol_series, get_symbol_info, or any other tool.",
  get_quotes:
    " → Returns {total_items: number, data: [{code: string, status?: string, last_price?: number, change?: number, change_percent?: number, volume?: number, bid?: number, ask?: number, bid_size?: number, ask_size?: number, market_cap?: number, open_price?: number, high_price?: number, low_price?: number, prev_close_price?: number, lp_time?: number, delay_seconds?: number, currency_code?: string, unit?: string}]}. For historical data use get_symbol_series. For company details use get_symbol_info.",
  get_symbol_series:
    " → Returns {code: string, bar_type: string, bar_end?: number, last_update: number, series: [{time: number, open?: number, high?: number, low?: number, close: number, volume?: number, type?: string}]}. With abbr=true: {code: string, bar_type: string, bar_end?: number, last_update: number, series_keys: string[], series: number[][]} — compact arrays for reduced LLM token usage. Not all bar types include the same fields (e.g., tick data may only have [time, type, close]) — always check series_keys. For intra-day historical data (if you need more than recent 30k bars) use get_symbol_history instead. For real-time streaming, read the insightsentry://docs/websocket resource.",
  get_symbol_history:
    " → Returns {code: string, bar_type: string, bar_end?: number, last_update: number, series: [{time: number, open?: number, high?: number, low?: number, close: number, volume?: number, type?: string}]}. With abbr=true: {code: string, bar_type: string, bar_end?: number, last_update: number, series_keys: string[], series: number[][]} — compact arrays for reduced LLM token usage. Not all bar types include the same fields (e.g., tick data may only have [time, type, close]) — always check series_keys. Supports second/minute/hour bars only (for daily/weekly/monthly, use get_symbol_series). Returns one month of data per call. Iterate start_date (YYYY-MM) for longer ranges. For recent data (up to 30k bars) use get_symbol_series instead.",
  get_symbol_info:
    " → Returns {code: string, type?: string, name?: string, exchange?: string, currency_code?: string, country_code?: string, sector?: string, industry?: string, description?: string, ceo?: string, website?: string, status?: string, delay_seconds?: number, change?: number, change_percent?: number, open_price?: number, low_price?: number, high_price?: number, prev_close_price?: number, volume?: number, average_volume?: number, market_cap?: number, total_shares_outstanding?: number, splits?: [{time: number, factor: number}], all_time_high?: number, all_time_high_day?: number, all_time_low?: number, all_time_low_day?: number, earnings_per_share_fq?: number, earnings_release_date?: number, earnings_release_next_date?: number, price_earnings_ttm?: number, dividends_yield?: number, beta_1_year?: number, option_info?: [{name: string, type: string, series: [{expiration_date: number, underlying: string, strikes: number[]}]}], has_backadjustment?: boolean, point_value?: number, ...}. Only 'code' is guaranteed — all other fields depend on the asset type. For fundamentals use get_symbol_fundamentals. For option chains use list_options.",
  get_symbol_fundamentals:
    " → Returns {code: string, data: [{id: string, name?: string, category?: string, group?: string, type?: string, period?: string, value?: number|string|array}], last_update: number}. The data array contains hundreds of fields. Use filter to access: data[category='Valuation'] to filter by category, $distinct(data.category) to list categories. If you're unsure which fields exist, call get_fundamentals_meta first. Present only the fields relevant to the user's question — do NOT dump the entire response. For historical fundamentals use get_fundamentals_series.",
  get_fundamentals_series:
    " → Returns {code: string, total_items: number, last_update: number, data: [{id: string, name: string, data: [{time: number, close: number}]}]} — max 5 indicator IDs per request. If you don't know the available IDs, call get_fundamentals_meta or get_symbol_fundamentals first — both return field objects with {id, name, category} that you can use here. Not all indicators are available for every symbol.",
  get_fundamentals_meta:
    " → Returns {last_update: number, base: [{id: string, name?: string, category?: string, group?: string, type?: string, period?: string}], fundamental_series: [{id: string, name: string}], technical_series: [{id: string, name: string}]}. No values — schema only. Use this to discover and search available fields when you're unsure which field IDs exist (e.g., find cash flow fields, balance sheet metrics, valuation ratios) by scanning names and categories. Then call get_symbol_fundamentals with a specific symbol and filter its response to only the IDs you identified here. Use fundamental_series/technical_series IDs with get_fundamentals_series for historical data.",
  get_symbol_contracts:
    " → Returns {base_code: string, contracts: [{code: string, settlement_date: string}]}. Use a specific contract code (e.g., CME_MINI:NQH2024) with get_symbol_history for deep history.",
  list_options:
    " → Returns {last_update: number, last_price?: number, codes: string[]}. Supports optional filters: expiration_min, expiration_max, type (call/put), range (strike % around last_price). last_price is included when range is provided. Next: use get_options_expiration (filter by date) or get_options_strike (filter by strike) to get chain with Greeks. To get last price and volume of specific option contracts, use get_quotes with the option codes (e.g., codes=OPRA:AAPL270617C230.0,OPRA:AAPL270617C260.0, up to 10 codes).",
  get_options_expiration:
    " → Returns {underlying_code: string, last_update: number, last_price?: number, data: [{code?: string, type: string, strike_price: number, expiration: number, ask_price: number, bid_price: number, delta: number, gamma: number, theta: number, vega: number, rho: number, implied_volatility: number, theoretical_price: number, bid_iv: number, ask_iv: number}]}. Provide expiration for exact date, or from/to for a date range. last_price is included when range is provided. To get last price and volume of option contracts, use get_quotes with the option codes (e.g., codes=OPRA:AAPL270617C230.0,OPRA:AAPL270617C260.0, up to 10). For historical option price data use get_symbol_series.",
  get_options_strike:
    " → Returns {underlying_code: string, last_update: number, last_price?: number, data: [{code?: string, type: string, strike_price: number, expiration: number, ask_price: number, bid_price: number, delta: number, gamma: number, theta: number, vega: number, rho: number, implied_volatility: number, theoretical_price: number, bid_iv: number, ask_iv: number}]}. Provide strike for exact match, or range for ±N% of current price (last_price included when range is used). To get last price and volume of option contracts, use get_quotes with the option codes (e.g., codes=OPRA:AAPL270617C230.0,OPRA:AAPL270617C260.0, up to 10). For historical option price data use get_symbol_series.",
  get_stock_screener_params:
    " → Returns {available_fields: string[], available_exchanges: string[], available_countries: string[], sortOrder: string[]}. All arrays are flat string arrays (field names, not objects). Next: use screen_stocks with these fields to filter the market.",
  get_etf_screener_params:
    " → Returns {available_fields: string[], available_exchanges: string[], available_countries: string[], sortOrder: string[]}. All arrays are flat string arrays (field names, not objects). Next: use screen_etfs with these fields.",
  get_bond_screener_params:
    " → Returns {available_fields: string[], available_exchanges: string[], available_countries: string[], sortOrder: string[]}. All arrays are flat string arrays (field names, not objects). Next: use screen_bonds with these fields.",
  get_crypto_screener_params:
    " → Returns {available_fields: string[], available_exchanges: string[], sortOrder: string[]}. All arrays are flat string arrays (field names, not objects). No country filter for crypto. Next: use screen_crypto with these fields.",
  screen_stocks:
    ' → Returns {hasNext: boolean, current_page: number, total_page: number, current_items: number, data: [{symbol_code: string, name: string, country: string, currency: string, delay_seconds: number, ...requested_fields}]}. WORKFLOW: 1) Call get_stock_screener_params to discover available fields, exchanges, countries. 2) POST with your chosen fields. Tip: Filter by exchanges (e.g., ["NYSE", "NASDAQ"]) to exclude OTC/penny stocks. Example: {{EXAMPLE}}. Returns up to 1000 results per page.',
  screen_etfs:
    " → Returns {hasNext: boolean, current_page: number, total_page: number, current_items: number, data: [{symbol_code: string, name: string, country: string, currency: string, delay_seconds: number, ...requested_fields}]}. WORKFLOW: 1) Call get_etf_screener_params to discover available fields. 2) POST with your chosen fields. Example: {{EXAMPLE}}.",
  screen_bonds:
    " → Returns {hasNext: boolean, current_page: number, total_page: number, current_items: number, data: [{symbol_code: string, name: string, country: string, currency: string, delay_seconds: number, ...requested_fields}]}. WORKFLOW: 1) Call get_bond_screener_params to discover available fields. 2) POST with your chosen fields. Example: {{EXAMPLE}}.",
  screen_crypto:
    " → Returns {hasNext: boolean, current_page: number, total_page: number, current_items: number, data: [{symbol_code: string, name: string, currency: string, delay_seconds: number, ...requested_fields}]}. WORKFLOW: 1) Call get_crypto_screener_params to discover available fields. 2) POST with your chosen fields. Note: country filtering NOT supported for crypto. Example: {{EXAMPLE}}.",
  get_dividends:
    " → Returns {total_count: number, range: string, last_update: number, data: [{code: string, name: string, country: string, currency_code: string, market_cap: number, dividends_yield: number, dividend_ex_date_recent: number, dividend_ex_date_upcoming: number, dividend_payment_date_recent: number, dividend_payment_date_upcoming: number, dividend_amount_recent: number, dividend_amount_upcoming: number}]}. Default: current week. Use 'w' to look ahead (w=2 for next week, w=4 for a month out). Filter by country with 'c' (e.g., 'US'). Filter by symbol with 'code' (e.g., 'NASDAQ:AAPL').",
  get_earnings:
    " → Returns {total_count: number, range: string, last_update: number, data: [{code: string, name: string, country: string, currency_code: string, market_cap: number, earnings_release_date: number, earnings_release_next_date: number, earnings_per_share_fq: number, earnings_per_share_forecast_fq: number, earnings_per_share_forecast_next_fq: number, eps_surprise_fq: number, eps_surprise_percent_fq: number, revenue_fq: number, revenue_forecast_fq: number, revenue_forecast_next_fq: number, revenue_surprise_fq: number, revenue_surprise_percent_fq: number}]}. Default: current week. Use 'w' to look ahead. Filter by country with 'c'. Filter by symbol with 'code' (e.g., 'NASDAQ:AAPL').",
  get_ipos:
    " → Returns {total_count: number, range: string, last_update: number, data: [{code: string, name: string, country: string, currency: string, status: string, offer_time: number, offer_price: number, offered_shares: number, deal_amount: number, price_range: string, market_cap: number}]}. Default: current week. Use 'w' to look ahead. Filter by country with 'c'. Filter by symbol with 'code' (e.g., 'NASDAQ:AAPL').",
  get_events:
    " → Returns {total_count: number, range: string, last_update: number, data: [{title?: string, country?: string, type?: string, currency?: string, importance?: string, date?: string, source_url?: string}]}. Default: current week. Use 'w' to look ahead. Filter by country with 'c'.",
  get_newsfeed:
    " → Returns {last_update: number, total_items: number, current_items: number, page: number, has_next: boolean, data: [{title?: string, content?: string, link?: string, published_at: number, related_symbols?: string[]}]}.",
  get_documents:
    " → Returns [{id: string, title: string, category: string, reported_time: number, is_available: boolean, is_pdf: boolean, fiscal_period?: string, fiscal_year?: number, form?: string}]. Use the id field with get_document to read content.",
  get_document:
    " → Returns {title: string, published_at: number, content: string} for non-PDF documents. For PDF documents, returns binary data by default; use text=true to get extracted text as {title: string, published_at: number, content: string} instead. **Always use text=true** so you can read the content. Get document IDs from get_documents first.",
};

function resolveRef(spec: OpenAPISpec, ref: string): any {
  const path = ref.replace("#/", "").split("/");
  let current: any = spec;
  for (const segment of path) {
    current = current[segment];
    if (!current) return {};
  }
  return current;
}

function resolveDeep(spec: OpenAPISpec, obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.$ref) {
    const resolved = resolveRef(spec, obj.$ref);
    return resolveDeep(spec, resolved);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveDeep(spec, item));
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveDeep(spec, value);
  }
  return result;
}

function escStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * Convert an OpenAPI parameter schema to a Zod expression string.
 */
function schemaToZod(schema: any, description?: string): string {
  let zod: string;

  if (schema.enum && schema.enum.length <= 30) {
    // z.enum([...])
    const values = schema.enum.map((v: any) => escStr(String(v))).join(", ");
    zod = `z.enum([${values}])`;
  } else if (schema.type === "integer" || schema.type === "number") {
    zod = `z.number()`;
    if (schema.type === "integer") zod += `.int()`;
    if (schema.minimum !== undefined) zod += `.min(${schema.minimum})`;
    if (schema.maximum !== undefined) zod += `.max(${schema.maximum})`;
  } else if (schema.type === "boolean") {
    zod = `z.boolean()`;
  } else if (schema.type === "array") {
    const itemsZod = schema.items
      ? schemaToZod(schema.items)
      : "z.any()";
    zod = `z.array(${itemsZod})`;
  } else {
    // Default: string (most query params are strings)
    zod = `z.string()`;
  }

  // Add description
  let desc =
    description ||
    schema.description ||
    "";
  // Add format hints for date fields only when description doesn't already explain the format
  if (schema.format === "date" && !desc.toLowerCase().includes("format")) {
    desc += desc ? ` (format: ${schema.example || "YYYY-MM-DD"})` : `Format: ${schema.example || "YYYY-MM-DD"}`;
  }
  // For large enums, include a note about supported values
  if (schema.enum && schema.enum.length > 30) {
    const enumNote = `Supports ${schema.enum.length} values including: ${schema.enum.slice(0, 10).join(", ")}, ...`;
    const fullDesc = desc ? `${desc} (${enumNote})` : enumNote;
    zod += `.describe(${escStr(fullDesc)})`;
  } else if (desc) {
    zod += `.describe(${escStr(desc)})`;
  }

  return zod;
}

// Override descriptions for specific params to align with documentation
// (docs are more detailed and accurate than the OpenAPI spec descriptions)
// Per-tool param description overrides (toolName -> paramName -> description)
const TOOL_PARAM_OVERRIDES: Record<string, Record<string, string>> = {
  screen_etfs: {
    fields:
      "Array of field names to include in the response (1-10 fields). Discover available fields by calling get_etf_screener_params first. Field names are case-insensitive.",
  },
  screen_bonds: {
    fields:
      "Array of field names to include in the response (1-10 fields). Discover available fields by calling get_bond_screener_params first. Field names are case-insensitive.",
  },
  screen_crypto: {
    fields:
      "Array of field names to include in the response (1-10 fields). Discover available fields by calling get_crypto_screener_params first. Field names are case-insensitive.",
  },
};

const PARAM_DESCRIPTION_OVERRIDES: Record<string, string> = {
  // Screener POST body params — aligned with /docs/screener
  "fields":
    "Array of field names to include in the response (1-10 fields). Discover available fields by calling the GET screener params tool first (e.g., get_stock_screener_params). Field names are case-insensitive.",
  "sortBy":
    'Field name to sort results by. Must be one of the requested fields or "name". Default: "name".',
  "sortOrder":
    'Sort order: "asc" (ascending) or "desc" (descending). Default: "asc".',
  "exchanges":
    'Array of exchange names to filter by (e.g., ["NYSE", "NASDAQ"]). Discover available exchanges via the GET screener params tool.',
  "countries":
    'Array of country codes to filter by (e.g., ["US", "CA"]). Not available for crypto screener. Discover available countries via the GET screener params tool.',
  "ignore_invalid":
    "If true, invalid fields, exchanges, or countries are silently filtered out instead of returning an error. Useful when you're unsure if a field exists.",
};

interface ParamInfo {
  name: string;
  zodExpr: string;
  required: boolean;
}

function collectParams(
  spec: OpenAPISpec,
  pathParams: any[],
  operation: any,
  toolName?: string,
): ParamInfo[] {
  const params: ParamInfo[] = [];
  const seen = new Set<string>();

  const allParams = [...(pathParams || []), ...(operation.parameters || [])];

  for (const rawParam of allParams) {
    const param = resolveDeep(spec, rawParam);
    if (!param.name || seen.has(param.name)) continue;
    seen.add(param.name);

    const zodExpr = schemaToZod(param.schema || {}, param.description);
    params.push({
      name: param.name,
      zodExpr,
      required: !!param.required,
    });
  }

  // Handle request body (for POST screener endpoints)
  if (operation.requestBody) {
    const body = resolveDeep(spec, operation.requestBody);
    const jsonContent = body?.content?.["application/json"];
    if (jsonContent?.schema) {
      let bodySchema = jsonContent.schema;
      // Handle allOf
      if (bodySchema.allOf) {
        const merged: Record<string, any> = {
          properties: {},
          required: [] as string[],
        };
        for (const part of bodySchema.allOf) {
          if (part.properties) Object.assign(merged.properties, part.properties);
          if (part.required) merged.required.push(...part.required);
        }
        bodySchema = merged;
      }
      if (bodySchema.properties) {
        const bodyRequired = new Set(bodySchema.required || []);
        for (const [name, propSchema] of Object.entries<any>(
          bodySchema.properties,
        )) {
          if (seen.has(name)) continue;
          seen.add(name);
          // Use tool-specific override, then global override, then OpenAPI description
          const desc = (toolName && TOOL_PARAM_OVERRIDES[toolName]?.[name]) || PARAM_DESCRIPTION_OVERRIDES[name] || propSchema.description;
          const zodExpr = schemaToZod(propSchema, desc);
          params.push({
            name,
            zodExpr,
            required: bodyRequired.has(name),
          });
        }
      }
    }
  }

  return params;
}

async function generate(): Promise<void> {
  const response = await fetch("https://insightsentry.com/openapi.json");
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`);
  }
  const spec: OpenAPISpec = await response.json() as OpenAPISpec;

  const toolEntries: string[] = [];
  const toolNames: string[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (SKIP_PATHS.has(path)) continue;

    const pathParams = pathItem.parameters || [];

    for (const method of ["get", "post"] as const) {
      const operation = pathItem[method];
      if (!operation) continue;

      const toolName = TOOL_NAME_MAP[path]?.[method];
      if (!toolName) {
        console.warn(
          `No tool name mapping for ${method.toUpperCase()} ${path}, skipping`,
        );
        continue;
      }

      const baseDesc = [operation.summary, operation.description]
        .filter(Boolean)
        .join(". ");
      let hint = WORKFLOW_HINTS[toolName] || "";

      // Inject request body example from OpenAPI spec if {{EXAMPLE}} placeholder exists
      if (hint.includes("{{EXAMPLE}}")) {
        const bodyExample = operation.requestBody?.content?.["application/json"]?.example;
        const exampleStr = bodyExample ? JSON.stringify(bodyExample) : "{}";
        hint = hint.replace("{{EXAMPLE}}", exampleStr);
      }

      const description = baseDesc + hint;

      const params = collectParams(spec, pathParams, operation, toolName);

      // Build Zod shape entries
      const shapeLines = params.map((p) => {
        const expr = p.required ? p.zodExpr : `${p.zodExpr}.optional()`;
        return `    ${p.name}: ${expr},`;
      });

      const shapeCode =
        shapeLines.length > 0
          ? `{\n${shapeLines.join("\n")}\n  }`
          : "{}";

      toolEntries.push(`  {
    name: ${escStr(toolName)},
    description: ${escStr(description)},
    method: ${escStr(method.toUpperCase())},
    pathTemplate: ${escStr(path)},
    schema: ${shapeCode},
  }`);
      toolNames.push(toolName);
    }
  }

  const output = `// AUTO-GENERATED by scripts/generate.ts — do not edit manually
// Source: https://insightsentry.com/openapi.json
import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  method: string;
  pathTemplate: string;
  schema: Record<string, z.ZodTypeAny>;
}

export const toolDefinitions: ToolDefinition[] = [
${toolEntries.join(",\n")}
];
`;

  const outPath = resolve(__dirname, "../src/tool-definitions.ts");
  writeFileSync(outPath, output, "utf-8");
  console.log(
    `Generated ${toolNames.length} tool definitions → src/tool-definitions.ts`,
  );
  for (const name of toolNames) {
    console.log(`  ${name}`);
  }
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
