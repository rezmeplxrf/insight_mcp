import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import jsonata from "jsonata";
import { ApiClient } from "./api-client.js";
import { toolDefinitions } from "./tool-definitions.js";
import { docResources } from "./resources.js";
import { renderChart } from "./chart.js";

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
2. \`list_options\` — Get available option contracts. Narrow with API params: \`type\` (call/put), \`range\` (strike ±N% of price), \`expiration_min\`/\`expiration_max\` (date range).
3. \`get_options_expiration\` or \`get_options_strike\` — Get chain with Greeks (delta, gamma, theta, vega, IV). API params: \`range\`, \`type\`, \`from\`/\`to\` (date range), \`sortBy\` (delta, implied_volatility, strike_price, etc.), \`sort\` (asc/desc). Use these to narrow at the API level, then \`filter\` to refine by Greeks (e.g., delta range, IV threshold).
4. \`get_quotes\` — Real-time option quotes (use the OPRA:... or Futures option code)
5. \`get_symbol_series\` — Historical option price data (Only available for OPRA)

### "What's happening in the market?"
- \`get_newsfeed\` — Latest financial news (filter by keywords). Use \`filter\` to limit results (e.g., first N headlines with title+date only).
- \`get_earnings\` — Upcoming/recent earnings
- \`get_dividends\` — Dividend calendar
- \`get_ipos\` — IPO calendar
- \`get_events\` — Economic events calendar

### "Deep historical / futures data"
- \`get_symbol_history\` — 20+ years of data (requires start_date: YYYY-MM-DD for second bars returns one day, YYYY-MM for minute/hour bars returns one month)
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
Read the documentation resources for comprehensive guides:
- \`insightsentry://docs/rest-api\` — Full REST API reference with all endpoints
- \`insightsentry://docs/websocket\` — WebSocket connection, authentication, subscriptions, data formats, Python/JS examples
- \`insightsentry://docs/screener\` — Screener field discovery and filtering patterns
- \`insightsentry://docs/options\` — Option chains, Greeks, code format explained
- \`insightsentry://docs/history\` — History endpoints: bar types, params, concurrency limits, history vs series
- \`insightsentry://docs/futures-history\` — Futures contract month logic

## Key Concepts
- **Symbol format**: Always \`EXCHANGE:SYMBOL\` (e.g., NASDAQ:AAPL, BINANCE:BTCUSDT, CME_MINI:NQ1!)
- **Option codes**: \`OPRA:AAPL260417P325.0\` = OPRA exchange, AAPL, expires 2026-04-17, Put, $325 strike
- **Screeners**: First GET to discover fields, then POST to filter. Fields are case-insensitive.
- **Time series**: \`bar_type\` (tick/second/minute/hour/day/week/month) + \`bar_interval\` (1-1440). Use \`dp\` to control data points (default 3000, max 30000). Use \`filter\` to compute aggregates or extract specific fields from the series (e.g., \`series.close\`).
- **WebSocket**: For real-time streaming, read the websocket resource. Two endpoints: /live (market data) and /newsfeed (news).

## Handling Large Responses — Use \`filter\` (JSONata)
API responses can be large (e.g., 30k bars of time series, hundreds of fundamental fields, full screener pages). **Every tool supports an optional \`filter\` parameter** that accepts a [JSONata](https://jsonata.org) expression. The filter is applied server-side before the response reaches you, so you only receive the data you need — drastically reducing token usage.

**Always use \`filter\` when you don't need the full response.** Only omit it when the user explicitly asks for raw data or when debugging.

Examples:
- \`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 2000, filter: "{ \"code\": code, \"avg_close\": $average(series.close), \"max_high\": $max(series.high), \"min_low\": $min(series.low) }" })\` — compute aggregates server-side instead of consuming all bars
- \`get_symbol_fundamentals({ symbol: "NASDAQ:AAPL", filter: "$distinct(data.category)" })\` — list available categories first
- \`get_symbol_fundamentals({ symbol: "NASDAQ:AAPL", filter: "data.{ \"id\": id, \"name\": name }" })\` — list all field id+name pairs (without values, lightweight overview)
- \`get_symbol_fundamentals({ symbol: "NASDAQ:AAPL", filter: "data[category='Statistics'].{ \"id\": id, \"name\": name, \"value\": value }" })\` — then grab specific category with values
- \`screen_stocks({ fields: ["close", "volume", "market_cap"], filter: "$sum(data[market_cap != null].market_cap)" })\` — aggregate instead of listing rows (filter nulls first, as some rows may lack a field)
- \`get_stock_screener_params({ filter: "available_fields[$contains($, \\"volume\\")]" })\` — search screener fields by keyword (available_fields is a flat string array, not objects)
- \`get_symbol_info({ symbol: "NASDAQ:AAPL", filter: "$keys($)" })\` — list all available fields first
- \`get_symbol_info({ symbol: "NASDAQ:AAPL", filter: "{ \"sector\": sector, \"industry\": industry, \"market_cap\": market_cap, \"ceo\": ceo }" })\` — then pick specific fields
- \`get_newsfeed({ keywords: "tesla", filter: "data[[0..2]].{ \"title\": title, \"published_at\": published_at }" })\` — first 3 headlines only
- \`get_fundamentals_meta({ filter: "base[$contains($lowercase(name), \"cash flow\")].{ \"id\": id, \"name\": name, \"period\": period }" })\` — search available fields by keyword
- \`get_fundamentals_meta({ filter: "$distinct(base.category)" })\` — list all available categories
- \`get_fundamentals_meta({ filter: "$distinct(base.group)" })\` — list all available groups
- \`get_fundamentals_meta({ filter: "fundamental_series[$contains($lowercase(name), \"cash\") or $contains($lowercase(name), \"income\")].id" })\` — find series IDs for use with get_fundamentals_series
- \`get_options_expiration({ code: "NASDAQ:AAPL", expiration: "2026-06-17", range: 10, type: "call", filter: "data[$abs(delta) >= 0.4 and $abs(delta) <= 0.6].{ \"code\": code, \"strike\": strike_price, \"delta\": delta, \"iv\": implied_volatility }" })\` — API narrows to ±10% strikes + calls, then filter refines by delta
- \`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 300, filter: "{ \"code\": code, \"period_return_pct\": $round((series[-1].close - series[0].open) / series[0].open * 100, 2), \"total_volume\": $sum(series.volume) }" })\` — compute period return and total volume
- \`screen_stocks({ fields: ["close", "volume", "market_cap", "change_percent"], filter: "data[change_percent][change_percent > 0].{ \"name\": name, \"change_percent\": change_percent }" })\` — only gainers (first predicate filters out nulls)
- \`get_documents({ code: "NASDAQ:AAPL", filter: "$[form=\"10-K\" or form=\"10-Q\"].{ \"id\": id, \"title\": title, \"form\": form }" })\` — only SEC filings (10-K/10-Q)

Also prefer API-level filtering when available (screener field selection, option \`type\`/\`range\` filters) — combine with \`filter\` for maximum efficiency.

### Screener Recipes
Screener fields are limited to 10 per request — pick the most relevant ones and use \`filter\` to narrow and reshape results.

**Value screen** — low P/E, cheap on cash flow:
\`screen_stocks({ fields: ["close", "market_cap", "price_earnings_ttm", "price_free_cash_flow_ttm", "dividends_yield", "enterprise_value_ebitda_ttm"], exchanges: ["NYSE", "NASDAQ"], sortBy: "market_cap", sortOrder: "desc", filter: "data[price_earnings_ttm][price_free_cash_flow_ttm][price_earnings_ttm > 0 and price_earnings_ttm < 15 and price_free_cash_flow_ttm < 10].{ \"name\": name, \"code\": symbol_code, \"pe\": price_earnings_ttm, \"p_fcf\": price_free_cash_flow_ttm, \"div_yield\": dividends_yield, \"ev_ebitda\": enterprise_value_ebitda_ttm }" })\`

**Momentum screen** — strong 3-month performance + unusual volume:
\`screen_stocks({ fields: ["close", "market_cap", "change_percent_1W", "performance_3_month", "relative_volume_intraday", "average_volume_30d"], exchanges: ["NYSE", "NASDAQ"], sortBy: "performance_3_month", sortOrder: "desc", filter: "data[performance_3_month][relative_volume_intraday][performance_3_month > 20 and relative_volume_intraday > 1.5].{ \"name\": name, \"code\": symbol_code, \"perf_3m\": performance_3_month, \"chg_1w\": change_percent_1W, \"rvol\": relative_volume_intraday }" })\`

**Quality screen** — high ROIC, low leverage, strong margins:
\`screen_stocks({ fields: ["close", "market_cap", "return_on_invested_capital_fq", "debt_to_equity_fq", "operating_margin_ttm", "free_cash_flow_margin_ttm", "gross_margin_ttm"], exchanges: ["NYSE", "NASDAQ"], sortBy: "market_cap", sortOrder: "desc", filter: "data[return_on_invested_capital_fq][debt_to_equity_fq][operating_margin_ttm][return_on_invested_capital_fq > 20 and debt_to_equity_fq < 1 and operating_margin_ttm > 25].{ \"name\": name, \"code\": symbol_code, \"roic\": return_on_invested_capital_fq, \"d_e\": debt_to_equity_fq, \"op_margin\": operating_margin_ttm, \"fcf_margin\": free_cash_flow_margin_ttm }" })\`

**Volatility + volume spike** — unusual activity detection:
\`screen_stocks({ fields: ["close", "market_cap", "volatility_week", "volatility_month", "relative_volume_intraday", "gap", "change_percent"], exchanges: ["NYSE", "NASDAQ"], sortBy: "relative_volume_intraday", sortOrder: "desc", filter: "data[relative_volume_intraday][volatility_week][relative_volume_intraday > 2 and volatility_week > 3].{ \"name\": name, \"code\": symbol_code, \"vol_w\": volatility_week, \"rvol\": relative_volume_intraday, \"gap\": gap, \"chg\": change_percent }" })\`

## Charting with \`render_chart\`

Use \`render_chart\` to visualize data as PNG images. It accepts a full [Chart.js](https://www.chartjs.org/docs/) configuration as a JSON string. Combine with \`get_symbol_series\` or \`get_symbol_history\` using \`filter\` to extract chart-ready arrays.

### Series response format
\`get_symbol_series\` and \`get_symbol_history\` return:
\`\`\`json
{ "code": "NASDAQ:AAPL", "bar_type": "1d", "series": [{ "time": 1733432340, "open": 242.89, "high": 243.09, "low": 242.82, "close": 243.08, "volume": 533779 }, ...] }
\`\`\`
Use \`filter\` to extract parallel arrays for charting — e.g., \`filter: "{ \"labels\": series.$fromMillis(time * 1000, \"[M01]/[D01]\"), \"close\": series.close }"\`.

### Example: Line chart — daily closing prices
Step 1: Fetch data with filter to extract labels and values:
\`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 30, filter: "{ \"labels\": series.$fromMillis(time * 1000, \"[M01]/[D01]\"), \"close\": series.close }" })\`
→ returns \`{ "labels": ["03/01", "03/02", ...], "close": [242.5, 243.1, ...] }\`

Step 2: Pass to render_chart:
\`render_chart({ config: "{ \"type\": \"line\", \"data\": { \"labels\": [\"03/01\", \"03/02\", ...], \"datasets\": [{ \"label\": \"AAPL Close\", \"data\": [242.5, 243.1, ...], \"borderColor\": \"rgb(59,130,246)\", \"fill\": false, \"pointRadius\": 0 }] }, \"options\": { \"plugins\": { \"title\": { \"display\": true, \"text\": \"AAPL Daily Close (30 days)\" } } } }" })\`

### Example: Bar chart — daily volume
\`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 30, filter: "{ \"labels\": series.$fromMillis(time * 1000, \"[M01]/[D01]\"), \"volume\": series.volume }" })\`
\`render_chart({ config: "{ \"type\": \"bar\", \"data\": { \"labels\": [...], \"datasets\": [{ \"label\": \"Volume\", \"data\": [...], \"backgroundColor\": \"rgba(59,130,246,0.5)\" }] }, \"options\": { \"plugins\": { \"title\": { \"display\": true, \"text\": \"AAPL Daily Volume\" } } } }" })\`

### Example: Multi-line — comparing two symbols
Fetch both series (can be parallel), then combine into one chart:
\`render_chart({ config: "{ \"type\": \"line\", \"data\": { \"labels\": [...dates...], \"datasets\": [{ \"label\": \"AAPL\", \"data\": [...], \"borderColor\": \"rgb(59,130,246)\", \"pointRadius\": 0 }, { \"label\": \"MSFT\", \"data\": [...], \"borderColor\": \"rgb(239,68,68)\", \"pointRadius\": 0 }] }, \"options\": { \"plugins\": { \"title\": { \"display\": true, \"text\": \"AAPL vs MSFT\" } } } }" })\`

### Example: Candlestick-style OHLC using floating bars
Chart.js doesn't have a native candlestick type, but you can approximate with floating bar charts:
\`get_symbol_series({ symbol: "NASDAQ:AAPL", bar_type: "day", dp: 20, filter: "{ \"labels\": series.$fromMillis(time * 1000, \"[M01]/[D01]\"), \"open\": series.open, \"close\": series.close, \"high\": series.high, \"low\": series.low }" })\`
Use the \`open\` and \`close\` arrays as \`[low, high]\` pairs in a floating bar dataset, with color conditional on open vs close.

### Example: Intraday chart from history
\`get_symbol_history({ symbol: "NASDAQ:AAPL", bar_type: "minute", bar_interval: 5, start_date: "2026-03", filter: "{ \"labels\": series.$fromMillis(time * 1000, \"[H01]:[m01]\"), \"close\": series.close }" })\`
Then pass labels and close arrays to \`render_chart\` as a line chart.

### Tips
- Use \`filter\` with \`$fromMillis(time * 1000, \"[pattern]\")\` to format Unix timestamps as readable labels. The \`time\` field is in seconds — multiply by 1000 for milliseconds.
- Set \`pointRadius: 0\` on line charts with many data points for cleaner output.
- For large datasets (hundreds of points), use \`dp\` to limit data points or increase chart \`width\`.
- Supported chart types: line, bar, pie, doughnut, radar, polarArea, bubble, scatter.
- Default dimensions: 800×400px. Use \`width\`/\`height\` params to customize (200–2000px).
`;

const apiKey = process.env.INSIGHTSENTRY_API_KEY?.trim();

function isJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    for (const part of parts.slice(0, 2)) {
      atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    }
    return true;
  } catch {
    return false;
  }
}

let client: ApiClient | null = null;
let apiKeyError: string | null = null;

if (!apiKey) {
  apiKeyError =
    "INSIGHTSENTRY_API_KEY environment variable is not set. Get your API key from https://insightsentry.com/dashboard";
} else if (!isJwt(apiKey)) {
  apiKeyError =
    "INSIGHTSENTRY_API_KEY is not a valid API key. InsightSentry API keys are JWT tokens. Get your API key from https://insightsentry.com/dashboard";
} else {
  client = new ApiClient(apiKey);
}

const server = new McpServer(
  { name: "insightsentry", version: "1.0.0" },
  { instructions: INSTRUCTIONS },
);

// Register all API tools with Zod schemas for type-safe parameter validation
for (const tool of toolDefinitions) {
  const schema = {
    ...tool.schema,
    filter: z.string().describe("(Optional) JSONata expression to filter/transform the API response server-side before it reaches you. Use this to extract only the fields or rows you need, reducing token usage. See https://jsonata.org for syntax.").optional(),
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
        const { filter: filterExpr, ...apiArgs } = args;
        const result = await client.request(
          tool.method,
          tool.pathTemplate,
          apiArgs,
        );

        let output = result;
        if (filterExpr && typeof filterExpr === "string") {
          const expr = jsonata(filterExpr);
          output = await expr.evaluate(result);
        }

        const content =
          typeof output === "string"
            ? output
            : JSON.stringify(output, null, 2);
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (error: any) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${error.message}` },
          ],
          isError: true,
        };
      }
    },
  );
}

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
        content: [
          {
            type: "image" as const,
            data: base64,
            mimeType: "image/png",
          },
          {
            type: "text" as const,
            text: `Chart saved to: ${filePath}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${error.message}` },
        ],
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
        { uri: doc.uri, mimeType: doc.mimeType, text: doc.content },
      ],
    }),
  );
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
