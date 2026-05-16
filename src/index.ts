import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "./api-client.js";
import { flexibleInputSchema } from "./arg-coercion.js";
import { getAuthStatus, getWhoami } from "./auth-status.js";
import { renderChart } from "./chart.js";
import { getVersionCacheLocation, resolveApiKeyWithSource } from "./config.js";
import { downloadHistorySchema } from "./download-history-schema.js";
import { downloadHistory } from "./history.js";
import { PACKAGE_JSON } from "./package-info.js";
import { docResources, fetchDocResourceContent } from "./resources.js";
import { validateSymbolLikeArgs } from "./symbol-validation.js";
import { toolDefinitions } from "./tool-definitions.js";
import { runApiTool } from "./tool-runner.js";
import {
  fetchLatestPackageVersion,
  formatUpgradeNotice,
  formatVersionStatus,
  getVersionStatus,
} from "./version-status.js";

const INSTRUCTIONS = `You are connected to the InsightSentry financial data API. You have access to real-time and historical market data for equities, futures, options, crypto, forex, and more.

## IMPORTANT: Symbol Code Format
InsightSentry uses EXCHANGE:SYMBOL format for all symbol codes. This is NOT the same as ticker symbols used by brokers or Google Finance.

**Use \`search_symbols\` first** to find the correct code before calling any other tool. Do NOT guess symbol codes.

Examples of correct codes:
- NASDAQ:AAPL (not just "AAPL")
- NYSE:TSLA (not "TSLA")
- BINANCE:BTCUSDT (not "BTC" or "BTCUSD")
- CME_MINI:NQ1! (not "NQ" or "/NQ")
- COMEX:GCH2026 (not "GC26" or "GOLD")

If you're unsure about a symbol code, search for it: \`search_symbols({ query: "apple" })\`

## Common Workflows

### "Am I logged in?" / "Is InsightSentry configured?"
Call \`whoami\` to check whether this MCP server has an InsightSentry API key configured. It parses the local JWT and returns the logged-in user's email/uuid without calling the external API.

### "Get me data on a stock/crypto/asset"
1. \`search_symbols\` — **Always start here.** Find the correct EXCHANGE:SYMBOL code.
2. Then use any combination of:
   - \`get_quotes\` — Last price, change, bid/ask, volume, market status, market cap (up to 10 symbols at once)
   - \`get_symbol_series\` — OHLCV bars (tick/second/minute/hour/day/week/month, up to 30k bars, with real-time long_poll option). Use \`filter\` to compute aggregates or extract specific bars instead of consuming all data.
   - \`get_symbol_info\` — Metadata: sector, industry, market cap, P/E, dividends, splits, option chains. Response is large — use \`filter: "$keys($)"\` to discover fields, then pick only what's needed.
   - \`get_symbol_fundamentals\` — Deep fundamentals: valuation, profitability, balance sheet, income statement. Returns hundreds of fields — use \`filter\` to list categories or grab specific ones (see examples below).

### "Screen/filter the market"
1. \`get_stock_screener_params\` (or etf/bond/crypto) — Discover available fields, exchanges, countries
2. \`screen_stocks\` (or etf/bond/crypto) — POST with fields, sorting. Returns up to 1000 results/page — use \`filter\` to narrow results, compute aggregates, or extract only matching rows (see Screener Recipes below).

### "Options analysis"
1. \`search_symbols\` — Find the underlying
2. \`get_options_contracts\` — Get available option contract metadata and codes. Narrow with API params: \`type\` (call/put), \`strike\`, \`range\` (strike ±N% of price), \`expiration\`, or \`from\`/\`to\` (expiration date range). If the response includes \`next_token\`, request the next page with the same filters plus \`next_token\`.
3. \`get_options_snapshot\` — Get latest option daily/previous bars, bid/ask, and latest trade rows. Use \`strike\`, \`range\`, \`expiration\`, \`from\`, or \`to\` to narrow results. If the response includes \`next_token\`, request the next page with the same filters plus \`next_token\`. If no strike, range, expiration, from, or to selector is provided, the API applies \`range=1000\` internally.
4. \`get_options_quotes\` — Get option quote rows with bid/ask and Greeks (delta, gamma, theta, vega, IV). Use \`strike\`, \`range\`, \`expiration\`, \`from\`, or \`to\` to narrow results. If no strike, range, expiration, from, or to selector is provided, the API applies \`range=1000\` internally. Use \`sortBy\`/\`sort\` to narrow at the API level, then \`filter\` to refine by Greeks.
5. \`get_quotes\` — Latest trade price, volume, and top-of-book quote data for specific option codes (use the OPRA:... or futures option code)
6. \`get_symbol_series\` — Historical option price data (Only available for OPRA)

### "What's happening in the market?"
- \`get_newsfeed\` — Latest financial news (filter by keywords). Use \`filter\` to limit results (e.g., first N headlines with title+date only).
- \`get_earnings\` — Upcoming/recent earnings
- \`get_dividends\` — Dividend calendar
- \`get_ipos\` — IPO calendar
- \`get_events\` — Economic events calendar

### "Deep historical / futures data"
- \`get_symbol_history\` — 20+ years of data (requires start_date: YYYY-MM-DD for second bars returns one day, YYYY-MM for minute/hour bars returns one month)
- \`download_history\` — Ranged history downloader that saves JSON/CSV files locally, expands second bars into daily /history requests, minute/hour into monthly /history requests, uses /series for day/week/month, and auto-expands continuous futures ending in 1! or 2! through contracts for second/minute/hour.
- \`get_symbol_contracts\` — List futures contracts with settlement dates
- For extensive futures history, use specific contract codes (e.g., CME_MINI:NQH2024), not continuous (CME_MINI:NQ1!)

### "Fundamental analysis" (e.g., "What's Apple's free cash flow?", "Show me Tesla's balance sheet")
1. \`get_fundamentals_meta\` — Call with \`filter\` to discover fields: \`filter: "base[$contains($lowercase(name), \\"cash flow\\")].{ \\"id\\": id, \\"name\\": name }"\` or \`filter: "$distinct(base.category)"\`. Lightweight, no symbol needed. Skip if you already know the field IDs.
2. \`get_symbol_fundamentals\` — Returns {code, data: [...hundreds of fields...], last_update}. **Always use \`filter\`** to extract only what's needed: \`filter: "data[category='Statistics'].{ \\"id\\": id, \\"name\\": name, \\"value\\": value }"\`. Never return the full response.
3. (Optional) \`get_fundamentals_series\` — For historical trends of specific indicators (max 5 IDs per request).

### "SEC filings and transcripts"
1. \`get_documents\` — List available filings for a symbol. Use \`filter\` to narrow by form type (e.g., \`filter: "$[form=\\"10-K\\" or form=\\"10-Q\\"]"\`).
2. \`get_document\` — Read a specific document's content

### "Help the user build an app with our API"
Read the documentation resources for endpoint details and examples:
- \`insightsentry://docs\` — Documentation index with all current guides
- \`insightsentry://docs/parameters\` — Common parameters for prices, sessions, currencies, and bar types
- \`insightsentry://docs/ws\` — WebSocket connection, authentication, subscriptions, data formats, Python/JS examples
- \`insightsentry://docs/mcp\` — CLI and MCP setup
- \`insightsentry://docs/screener\` — Screener field discovery and filtering patterns
- \`insightsentry://docs/options\` — Option chains, Greeks, code format explained
- \`insightsentry://docs/organization\` — Organization member and subscription management
- \`insightsentry://docs/archive\` — History endpoints: bar types, params, concurrency limits, history vs series
- \`insightsentry://docs/futures-history\` — Futures contract month logic
- \`insightsentry://docs/scalability\` — Scaling approaches and volume discounts
- \`insightsentry://docs/enterprise\` — Enterprise data package options

## Key Concepts
- **Symbol format**: Always \`EXCHANGE:SYMBOL\` (e.g., NASDAQ:AAPL, BINANCE:BTCUSDT, CME_MINI:NQ1!)
- **Option codes**: \`OPRA:AAPL260417P325.0\` = OPRA exchange, AAPL, expires 2026-04-17, Put, $325 strike
- **Screeners**: First GET to discover fields, then POST to filter. Fields are case-insensitive.
- **Time series**: \`bar_type\` (tick/second/minute/hour/day/week/month) + \`bar_interval\` (1-1440). Use \`dp\` to control data points (default 3000, max 30000). Use \`filter\` to compute aggregates or extract specific fields from the series (e.g., \`series.close\`).
- **WebSocket**: For real-time streaming, read the websocket resource. Two endpoints: /live (market data) and /newsfeed (news).

## Handling Large Responses — Use \`filter\` (JSONata)
API responses can be large (e.g., 30k bars of time series, hundreds of fundamental fields, full screener pages). **Every tool supports an optional \`filter\` parameter** that accepts a [JSONata](https://jsonata.org) expression. The filter is applied server-side before the response reaches you, so you only receive the data you need.

**Always use \`filter\` when you don't need the full response.** Only omit it when the user explicitly asks for raw data or when debugging.

Examples:
- \`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 2000, filter: "{ "code": code, "avg_close": $average(series.close), "max_high": $max(series.high), "min_low": $min(series.low) }" })\` — compute aggregates server-side instead of consuming all bars
- \`get_symbol_fundamentals({ symbol: "NASDAQ:AAPL", filter: "$distinct(data.category)" })\` — list available categories first
- \`get_symbol_fundamentals({ symbol: "NASDAQ:AAPL", filter: "data.{ "id": id, "name": name }" })\` — list all field id+name pairs (without values, lightweight overview)
- \`get_symbol_fundamentals({ symbol: "NASDAQ:AAPL", filter: "data[category='Statistics'].{ "id": id, "name": name, "value": value }" })\` — then grab specific category with values
- \`screen_stocks({ fields: ["close", "volume", "market_cap"], filter: "$sum(data[market_cap != null].market_cap)" })\` — aggregate instead of listing rows (filter nulls first, as some rows may lack a field)
- \`get_stock_screener_params({ filter: "available_fields[$contains($, \\"volume\\")]" })\` — search screener fields by keyword (available_fields is a flat string array, not objects)
- \`get_symbol_info({ symbol: "NASDAQ:AAPL", filter: "$keys($)" })\` — list all available fields first
- \`get_symbol_info({ symbol: "NASDAQ:AAPL", filter: "{ "sector": sector, "industry": industry, "market_cap": market_cap, "ceo": ceo }" })\` — then pick specific fields
- \`get_newsfeed({ keywords: "tesla", filter: "data[[0..2]].{ "title": title, "published_at": published_at }" })\` — first 3 headlines only
- \`get_fundamentals_meta({ filter: "base[$contains($lowercase(name), "cash flow")].{ "id": id, "name": name, "period": period }" })\` — search available fields by keyword
- \`get_fundamentals_meta({ filter: "$distinct(base.category)" })\` — list all available categories
- \`get_fundamentals_meta({ filter: "$distinct(base.group)" })\` — list all available groups
- \`get_fundamentals_meta({ filter: "fundamental_series[$contains($lowercase(name), "cash") or $contains($lowercase(name), "income")].id" })\` — find series IDs for use with get_fundamentals_series
- \`get_options_quotes({ code: "NASDAQ:AAPL", expiration: "2026-06-17", range: 10, type: "call", filter: "data[$abs(delta) >= 0.4 and $abs(delta) <= 0.6].{ "code": code, "strike": strike_price, "delta": delta, "iv": implied_volatility }" })\` — API narrows to ±10% strikes + calls, then filter refines by delta
- \`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 300, filter: "{ "code": code, "period_return_pct": $round((series[-1].close - series[0].open) / series[0].open * 100, 2), "total_volume": $sum(series.volume) }" })\` — compute period return and total volume
- \`screen_stocks({ fields: ["close", "volume", "market_cap", "change_percent"], filter: "data[change_percent][change_percent > 0].{ "name": name, "change_percent": change_percent }" })\` — only gainers (first predicate filters out nulls)
- \`get_documents({ code: "NASDAQ:AAPL", filter: "$[form="10-K" or form="10-Q"].{ "id": id, "title": title, "form": form }" })\` — only SEC filings (10-K/10-Q)

Also prefer API-level filtering when available (screener field selection, option \`type\`/\`range\` filters), then combine it with \`filter\` when you need additional shaping.

### Screener Recipes
Screener fields are limited to 10 per request — pick the most relevant ones and use \`filter\` to narrow and reshape results.

**Value screen** — low P/E, cheap on cash flow:
\`screen_stocks({ fields: ["close", "market_cap", "price_earnings_ttm", "price_free_cash_flow_ttm", "dividends_yield", "enterprise_value_ebitda_ttm"], exchanges: ["NYSE", "NASDAQ"], sortBy: "market_cap", sortOrder: "desc", filter: "data[price_earnings_ttm][price_free_cash_flow_ttm][price_earnings_ttm > 0 and price_earnings_ttm < 15 and price_free_cash_flow_ttm < 10].{ "name": name, "code": symbol_code, "pe": price_earnings_ttm, "p_fcf": price_free_cash_flow_ttm, "div_yield": dividends_yield, "ev_ebitda": enterprise_value_ebitda_ttm }" })\`

**Momentum screen** — strong 3-month performance + unusual volume:
\`screen_stocks({ fields: ["close", "market_cap", "change_percent_1W", "performance_3_month", "relative_volume_intraday", "average_volume_30d"], exchanges: ["NYSE", "NASDAQ"], sortBy: "performance_3_month", sortOrder: "desc", filter: "data[performance_3_month][relative_volume_intraday][performance_3_month > 20 and relative_volume_intraday > 1.5].{ "name": name, "code": symbol_code, "perf_3m": performance_3_month, "chg_1w": change_percent_1W, "rvol": relative_volume_intraday }" })\`

**Quality screen** — high ROIC, low leverage, strong margins:
\`screen_stocks({ fields: ["close", "market_cap", "return_on_invested_capital_fq", "debt_to_equity_fq", "operating_margin_ttm", "free_cash_flow_margin_ttm", "gross_margin_ttm"], exchanges: ["NYSE", "NASDAQ"], sortBy: "market_cap", sortOrder: "desc", filter: "data[return_on_invested_capital_fq][debt_to_equity_fq][operating_margin_ttm][return_on_invested_capital_fq > 20 and debt_to_equity_fq < 1 and operating_margin_ttm > 25].{ "name": name, "code": symbol_code, "roic": return_on_invested_capital_fq, "d_e": debt_to_equity_fq, "op_margin": operating_margin_ttm, "fcf_margin": free_cash_flow_margin_ttm }" })\`

**Volatility + volume spike** — unusual activity detection:
\`screen_stocks({ fields: ["close", "market_cap", "volatility_week", "volatility_month", "relative_volume_intraday", "gap", "change_percent"], exchanges: ["NYSE", "NASDAQ"], sortBy: "relative_volume_intraday", sortOrder: "desc", filter: "data[relative_volume_intraday][volatility_week][relative_volume_intraday > 2 and volatility_week > 3].{ "name": name, "code": symbol_code, "vol_w": volatility_week, "rvol": relative_volume_intraday, "gap": gap, "chg": change_percent }" })\`

## Charting with \`render_chart\`

Use \`render_chart\` to visualize data as PNG images. It accepts a full [Chart.js](https://www.chartjs.org/docs/) configuration as a JSON string. Combine with \`get_symbol_series\` or \`get_symbol_history\` using \`filter\` to extract chart-ready arrays.

### Series response format
\`get_symbol_series\` and \`get_symbol_history\` return:
\`\`\`json
{ "code": "NASDAQ:AAPL", "bar_type": "1d", "series": [{ "time": 1733432340, "open": 242.89, "high": 243.09, "low": 242.82, "close": 243.08, "volume": 533779 }, ...] }
\`\`\`
Use \`filter\` to extract parallel arrays for charting — e.g., \`filter: "{ "labels": series.$fromMillis(time * 1000, "[M01]/[D01]"), "close": series.close }"\`.

### Example: Line chart — daily closing prices
Step 1: Fetch data with filter to extract labels and values:
\`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 30, filter: "{ "labels": series.$fromMillis(time * 1000, "[M01]/[D01]"), "close": series.close }" })\`
→ returns \`{ "labels": ["03/01", "03/02", ...], "close": [242.5, 243.1, ...] }\`

Step 2: Pass to render_chart:
\`render_chart({ config: "{ "type": "line", "data": { "labels": ["03/01", "03/02", ...], "datasets": [{ "label": "AAPL Close", "data": [242.5, 243.1, ...], "borderColor": "rgb(59,130,246)", "fill": false, "pointRadius": 0 }] }, "options": { "plugins": { "title": { "display": true, "text": "AAPL Daily Close (30 days)" } } } }" })\`

### Example: Bar chart — daily volume
\`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 30, filter: "{ "labels": series.$fromMillis(time * 1000, "[M01]/[D01]"), "volume": series.volume }" })\`
\`render_chart({ config: "{ "type": "bar", "data": { "labels": [...], "datasets": [{ "label": "Volume", "data": [...], "backgroundColor": "rgba(59,130,246,0.5)" }] }, "options": { "plugins": { "title": { "display": true, "text": "AAPL Daily Volume" } } } }" })\`

### Example: Multi-line — comparing two symbols
Fetch both series (can be parallel), then combine into one chart:
\`render_chart({ config: "{ "type": "line", "data": { "labels": [...dates...], "datasets": [{ "label": "AAPL", "data": [...], "borderColor": "rgb(59,130,246)", "pointRadius": 0 }, { "label": "MSFT", "data": [...], "borderColor": "rgb(239,68,68)", "pointRadius": 0 }] }, "options": { "plugins": { "title": { "display": true, "text": "AAPL vs MSFT" } } } }" })\`

### Example: Candlestick-style OHLC using floating bars
Chart.js doesn't have a native candlestick type, but you can approximate with floating bar charts:
\`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 20, filter: "{ "labels": series.$fromMillis(time * 1000, "[M01]/[D01]"), "open": series.open, "close": series.close, "high": series.high, "low": series.low }" })\`
Use the \`open\` and \`close\` arrays as \`[low, high]\` pairs in a floating bar dataset, with color conditional on open vs close.

### Example: Intraday chart from history
\`get_symbol_history({ symbol: "NASDAQ:AAPL", bar_type: "minute", bar_interval: 5, start_date: "2026-03", filter: "{ "labels": series.$fromMillis(time * 1000, "[H01]:[m01]"), "close": series.close }" })\`
Then pass labels and close arrays to \`render_chart\` as a line chart.

### Tips
- Use \`filter\` with \`$fromMillis(time * 1000, "[pattern]")\` to format Unix timestamps as readable labels. The \`time\` field is in seconds — multiply by 1000 for milliseconds.
- Set \`pointRadius: 0\` on line charts with many data points for cleaner output.
- For large datasets (hundreds of points), use \`dp\` to limit data points or increase chart \`width\`.
- Supported chart types: line, bar, pie, doughnut, radar, polarArea, bubble, scatter.
- Default dimensions: 800×400px. Use \`width\`/\`height\` params to customize (200–2000px).
`;

const { apiKey } = resolveApiKeyWithSource();

let client: ApiClient | null = null;
let apiKeyError: string | null = null;
const authStatus = getAuthStatus();

if (!apiKey) {
  apiKeyError =
    "No InsightSentry API key found. Set INSIGHTSENTRY_API_KEY or run `insight login --key <your-api-key>`. Get your API key from https://insightsentry.com/dashboard";
} else if (!authStatus.key_format_valid) {
  apiKeyError =
    "InsightSentry API key is not a valid API key. InsightSentry API keys are JWT tokens. Get your API key from https://insightsentry.com/dashboard";
} else if (authStatus.expired) {
  apiKeyError =
    "InsightSentry API key is expired. Get a new API key from https://insightsentry.com/dashboard";
} else {
  client = new ApiClient(apiKey);
}

const server = new McpServer(
  { name: "insightsentry", version: PACKAGE_JSON.version },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  "whoami",
  {
    description:
      "Print the logged-in InsightSentry user's email/uuid by parsing the configured API key JWT locally. This does not call the external API.",
    inputSchema: {},
  },
  async () => {
    const result = getWhoami();
    if (!result.ok || !result.identity) {
      return {
        content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    const identity = result.identity;
    return {
      content: [{ type: "text" as const, text: identity }],
    };
  },
);

server.registerTool(
  "version_status",
  {
    description:
      "Check the installed InsightSentry CLI/MCP package version against the latest npm version and show the upgrade command when one is available.",
    inputSchema: {},
  },
  async () => {
    const status = await getCachedVersionStatus();
    return {
      content: [{ type: "text" as const, text: formatVersionStatus(status) }],
      isError: status.latestVersion ? undefined : true,
    };
  },
);

// Register all API tools with Zod schemas for type-safe parameter validation
for (const tool of toolDefinitions) {
  const schema = {
    ...flexibleInputSchema(tool.schema),
    filter: z
      .string()
      .describe(
        "(Optional) JSONata expression to filter/transform the API response server-side before it reaches you. Use this to extract only the fields or rows you need, reducing token usage. See https://jsonata.org for syntax.",
      )
      .optional(),
    store: z
      .enum(["none", "json", "csv"])
      .default("none")
      .optional()
      .describe(
        "Store the response locally instead of returning it. Default is none. csv is only supported for get_symbol_series.",
      ),
    output_file: z.string().optional().describe("File path for stored response."),
    output_dir: z
      .string()
      .optional()
      .describe("Directory for stored response when output_file is not set."),
  };

  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: schema },
    async (args: Record<string, any>) => {
      if (!client) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${apiKeyError}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const output = await runApiTool({
          toolName: tool.name,
          method: tool.method,
          pathTemplate: tool.pathTemplate,
          args,
          request: (method, pathTemplate, params) => client.request(method, pathTemplate, params),
        });

        const content = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        return {
          content: await withUpgradeNotice([{ type: "text" as const, text: content }]),
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );
}

// Register ranged history downloader tool
server.registerTool(
  "download_history",
  {
    description:
      "Download historical data over a from/to date range and save files locally as JSON, CSV, or both. second bars create one /history request per day, minute/hour bars create one /history request per month, and day/week/month bars use one /series request with dp=30000 and date filtering. Continuous futures ending in 1! or 2! are detected automatically and expanded to specific contract codes for second/minute/hour. Shows progress in the final summary and supports concurrency 1-10, default 5.",
    inputSchema: flexibleInputSchema(downloadHistorySchema),
  },
  async (args: any) => {
    if (!client) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${apiKeyError}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const symbolValidationError = validateSymbolLikeArgs(args);
      if (symbolValidationError) {
        throw new Error(`Invalid ${symbolValidationError.key}: ${symbolValidationError.error}`);
      }
      const activeClient = client;
      const progress: string[] = [];
      const result = await downloadHistory(args, {
        request: (method, path, params) => activeClient.request(method, path, params),
        onProgress: (event) => {
          progress.push(
            `[${event.completed}/${event.total}] ${event.status} ${event.symbol} ${event.start_date}`,
          );
        },
      });
      return {
        content: await withUpgradeNotice([
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, progress }, null, 2),
          },
        ]),
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  },
);

// Register chart rendering tool
server.registerTool(
  "render_chart",
  {
    description:
      "Render a Chart.js chart and return the PNG image. Accepts a full Chart.js configuration object (type, data, options). Supports all Chart.js chart types: line, bar, pie, doughnut, radar, polarArea, bubble, scatter. Use this after fetching market data to visualize trends, comparisons, or distributions.",
    inputSchema: {
      config: z
        .string()
        .describe(
          'Chart.js configuration as a JSON string. Must include "type" and "data" fields. Example: {"type":"line","data":{"labels":["Jan","Feb"],"datasets":[{"label":"Price","data":[100,105]}]},"options":{}}',
        ),
      width: z
        .number()
        .int()
        .min(200)
        .max(2000)
        .default(800)
        .describe("Chart width in pixels (default: 800)")
        .optional(),
      height: z
        .number()
        .int()
        .min(200)
        .max(2000)
        .default(400)
        .describe("Chart height in pixels (default: 400)")
        .optional(),
    },
  },
  async (args: { config: string; width?: number; height?: number }) => {
    try {
      const config = JSON.parse(args.config);
      if (!config.type || !config.data) {
        return {
          content: [
            {
              type: "text" as const,
              text: 'Error: Chart config must include "type" and "data" fields.',
            },
          ],
          isError: true,
        };
      }
      const { base64, filePath } = await renderChart(config, args.width, args.height);
      return {
        content: await withUpgradeNotice([
          {
            type: "image" as const,
            data: base64,
            mimeType: "image/png",
          },
          {
            type: "text" as const,
            text: `Chart saved to: ${filePath}`,
          },
        ]),
      };
    } catch (error: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  },
);

// Register documentation resources
for (const doc of docResources) {
  server.registerResource(
    doc.name,
    doc.uri,
    { mimeType: doc.mimeType, description: doc.description },
    async () => ({
      contents: [
        {
          uri: doc.uri,
          mimeType: doc.mimeType,
          text: await fetchDocResourceContent(doc),
        },
      ],
    }),
  );
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

async function withUpgradeNotice(content: ToolContent[]): Promise<ToolContent[]> {
  const status = await getCachedVersionStatus();
  const notice = formatUpgradeNotice(status);
  if (notice) content.push({ type: "text", text: notice });
  return content;
}

async function getCachedVersionStatus() {
  return getVersionStatus(PACKAGE_JSON, fetchLatestPackageVersion, {
    cachePath: getVersionCacheLocation(),
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
