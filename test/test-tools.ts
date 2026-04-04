/**
 * Integration test for all MCP tools, examples, and JSONata filters.
 * Run: npx tsx test/test-tools.ts
 */
import { ApiClient } from "../src/api-client.js";
import jsonata from "jsonata";

const apiKey = process.env.INSIGHTSENTRY_API_KEY?.trim();
if (!apiKey) {
  console.error("Set INSIGHTSENTRY_API_KEY");
  process.exit(1);
}

const client = new ApiClient(apiKey);

interface Test {
  name: string;
  fn: () => Promise<void>;
}

const tests: Test[] = [];
let passed = 0;
let failed = 0;
const failures: { name: string; error: string }[] = [];

function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

async function apiCall(
  method: string,
  path: string,
  params: Record<string, any>,
  filter?: string,
): Promise<any> {
  const result = await client.request(method, path, params);
  if (filter) {
    const expr = jsonata(filter);
    return await expr.evaluate(result);
  }
  return result;
}

// ─── search_symbols ───
test("search_symbols: basic query", async () => {
  const r = await apiCall("GET", "/v3/symbols/search", { query: "apple" });
  assert(r.symbols?.length > 0, "should return symbols");
  assert(r.symbols[0].code, "should have code field");
  assert(r.symbols[0].name, "should have name field");
  assert(r.symbols[0].type, "should have type field");
  assert(typeof r.current_page === "number", "should have current_page");
  assert(typeof r.has_more === "boolean", "should have has_more");
});

test("search_symbols: type filter", async () => {
  const r = await apiCall("GET", "/v3/symbols/search", { query: "bitcoin", type: "crypto" });
  assert(r.symbols?.length > 0, "should return crypto symbols");
});

test("search_symbols: exchange prefix query", async () => {
  const r = await apiCall("GET", "/v3/symbols/search", { query: "NASDAQ:" });
  assert(r.symbols?.length > 0, "should return NASDAQ symbols");
});

// ─── get_quotes ───
test("get_quotes: single symbol", async () => {
  const r = await apiCall("GET", "/v3/symbols/quotes", { codes: "NASDAQ:AAPL" });
  assert(r.total_items >= 1, "should have total_items");
  assert(r.data?.length >= 1, "should have data");
  const q = r.data[0];
  assert(q.code === "NASDAQ:AAPL", "code should match");
  assert(typeof q.last_price === "number", "should have last_price");
});

test("get_quotes: multiple symbols", async () => {
  const r = await apiCall("GET", "/v3/symbols/quotes", { codes: "NASDAQ:AAPL,NYSE:TSLA" });
  assert(r.data?.length === 2, "should return 2 quotes");
});

// ─── get_symbol_series ───
test("get_symbol_series: daily bars", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/series", { symbol: "NASDAQ:AAPL", bar_type: "day", dp: 5 });
  assert(r.code === "NASDAQ:AAPL", "code should match");
  assert(r.series?.length > 0, "should have series data");
  const bar = r.series[0];
  assert(typeof bar.time === "number", "bar should have time");
  assert(typeof bar.close === "number", "bar should have close");
});

test("get_symbol_series: abbr mode", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/series", { symbol: "NASDAQ:AAPL", bar_type: "day", dp: 5, abbr: true });
  assert(r.series_keys?.length > 0, "should have series_keys");
  assert(Array.isArray(r.series[0]), "series items should be arrays in abbr mode");
});

test("get_symbol_series: with filter (avg_close)", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/series",
    { symbol: "NASDAQ:AAPL", bar_type: "day", dp: 100 },
    '{ "code": code, "avg_close": $average(series.close), "max_high": $max(series.high), "min_low": $min(series.low) }',
  );
  assert(r.code === "NASDAQ:AAPL", "filter result should have code");
  assert(typeof r.avg_close === "number", "should compute avg_close");
  assert(typeof r.max_high === "number", "should compute max_high");
  assert(typeof r.min_low === "number", "should compute min_low");
});

test("get_symbol_series: with filter (period return)", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/series",
    { symbol: "NASDAQ:AAPL", bar_type: "day", dp: 300 },
    '{ "code": code, "period_return_pct": $round((series[-1].close - series[0].open) / series[0].open * 100, 2), "total_volume": $sum(series.volume) }',
  );
  assert(typeof r.period_return_pct === "number", "should compute period_return_pct");
  assert(typeof r.total_volume === "number", "should compute total_volume");
});

// ─── get_symbol_history ───
test("get_symbol_history: minute bars", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/history", { symbol: "NASDAQ:AAPL", bar_type: "minute", start_date: "2025-01" });
  assert(r.code === "NASDAQ:AAPL", "code should match");
  assert(r.series?.length > 0, "should have history data");
});

// ─── get_symbol_info ───
test("get_symbol_info: basic", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/info", { symbol: "NASDAQ:AAPL" });
  assert(r.code === "NASDAQ:AAPL", "should have code");
  assert(r.name, "should have name");
  assert(r.sector, "should have sector");
});

test("get_symbol_info: filter $keys", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/info",
    { symbol: "NASDAQ:AAPL" },
    "$keys($)",
  );
  assert(Array.isArray(r), "should return array of keys");
  assert(r.includes("code"), "should include 'code' key");
});

test("get_symbol_info: filter specific fields", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/info",
    { symbol: "NASDAQ:AAPL" },
    '{ "sector": sector, "industry": industry, "market_cap": market_cap, "ceo": ceo }',
  );
  assert(r.sector, "should have sector");
  assert(r.industry, "should have industry");
});

// ─── get_symbol_session ───
test("get_symbol_session: basic", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/session", { symbol: "NASDAQ:AAPL" });
  assert(r, "should return session data");
});

// ─── get_symbol_contracts ───
test("get_symbol_contracts: futures", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/contracts", { symbol: "CME_MINI:NQ1!" });
  assert(r.base_code, "should have base_code");
  assert(r.contracts?.length > 0, "should have contracts");
  assert(r.contracts[0].code, "contract should have code");
  assert(r.contracts[0].settlement_date, "contract should have settlement_date");
});

// ─── get_symbol_fundamentals ───
test("get_symbol_fundamentals: basic", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/fundamentals", { symbol: "NASDAQ:AAPL" });
  assert(r.code === "NASDAQ:AAPL", "should have code");
  assert(r.data?.length > 0, "should have fundamental data");
  assert(typeof r.last_update === "number", "should have last_update");
});

test("get_symbol_fundamentals: filter $distinct categories", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/fundamentals",
    { symbol: "NASDAQ:AAPL" },
    "$distinct(data.category)",
  );
  assert(Array.isArray(r), "should return array of categories");
  assert(r.length > 0, "should have categories");
});

test("get_symbol_fundamentals: filter by category Statistics", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/fundamentals",
    { symbol: "NASDAQ:AAPL" },
    'data[category="Statistics"].{ "id": id, "name": name, "value": value }',
  );
  assert(Array.isArray(r), "should return array");
  assert(r.length > 0, "should have statistics fields");
  assert(r[0].id, "should have id");
  assert(r[0].name, "should have name");
});

test("get_symbol_fundamentals: filter id+name only", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/{symbol}/fundamentals",
    { symbol: "NASDAQ:AAPL" },
    'data.{ "id": id, "name": name }',
  );
  assert(Array.isArray(r), "should return array");
  assert(r.length > 10, "should have many fields");
});

// ─── get_fundamentals_meta ───
test("get_fundamentals_meta: basic", async () => {
  const r = await apiCall("GET", "/v3/symbols/fundamentals", {});
  assert(r.base?.length > 0, "should have base fields");
  assert(r.fundamental_series?.length > 0, "should have fundamental_series");
  assert(r.technical_series?.length > 0, "should have technical_series");
});

test("get_fundamentals_meta: filter by name keyword", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/fundamentals", {},
    'base[$contains($lowercase(name), "cash flow")].{ "id": id, "name": name, "period": period }',
  );
  assert(Array.isArray(r), "should return array");
  assert(r.length > 0, "should find cash flow fields");
});

test("get_fundamentals_meta: filter $distinct categories", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/fundamentals", {},
    "$distinct(base.category)",
  );
  assert(Array.isArray(r), "should return array of categories");
  assert(r.length > 0, "should have categories");
});

test("get_fundamentals_meta: filter $distinct groups", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/fundamentals", {},
    "$distinct(base.group)",
  );
  assert(Array.isArray(r), "should return array of groups");
  assert(r.length > 0, "should have groups");
});

test("get_fundamentals_meta: filter series IDs by keyword", async () => {
  const r = await apiCall(
    "GET", "/v3/symbols/fundamentals", {},
    'fundamental_series[$contains($lowercase(name), "cash") or $contains($lowercase(name), "income")].id',
  );
  assert(Array.isArray(r) || typeof r === "string", "should return IDs");
});

// ─── get_fundamentals_series ───
test("get_fundamentals_series: basic", async () => {
  const r = await apiCall("GET", "/v3/symbols/{symbol}/fundamentals/series", {
    symbol: "NASDAQ:AAPL",
    ids: "accounts_payable_fy,net_income_fy",
  });
  assert(r.code === "NASDAQ:AAPL", "should have code");
  assert(r.data?.length > 0, "should have series data");
  assert(r.data[0].id, "should have id");
  assert(r.data[0].data?.length > 0, "should have data points");
});

// ─── list_options ───
test("list_options: basic", async () => {
  const r = await apiCall("GET", "/v3/options/list", { code: "NASDAQ:AAPL" });
  assert(r.codes?.length > 0, "should have option codes");
  assert(typeof r.last_update === "number", "should have last_update");
});

test("list_options: with range and type", async () => {
  const r = await apiCall("GET", "/v3/options/list", { code: "NASDAQ:AAPL", type: "call", range: 10 });
  assert(r.codes?.length > 0, "should have filtered option codes");
  assert(typeof r.last_price === "number", "should have last_price when range is provided");
});

// ─── get_options_expiration ───
test("get_options_expiration: basic", async () => {
  // First get a valid expiration from list_options
  const list = await apiCall("GET", "/v3/options/list", { code: "NASDAQ:AAPL", type: "call", range: 5 });
  // Parse an expiration from the first code (format: OPRA:AAPLyymmddCstrike)
  const firstCode = list.codes[0];
  const match = firstCode.match(/OPRA:\w+(\d{6})[CP]/);
  assert(match, `could not parse expiration from ${firstCode}`);
  const dateStr = match![1];
  const expiration = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;

  const r = await apiCall("GET", "/v3/options/expiration", { code: "NASDAQ:AAPL", expiration, type: "call", range: 10 });
  assert(r.underlying_code, "should have underlying_code");
  assert(r.data?.length > 0, "should have option chain data");
  const opt = r.data[0];
  assert(typeof opt.strike_price === "number", "should have strike_price");
  assert(typeof opt.delta === "number", "should have delta");
  assert(typeof opt.implied_volatility === "number", "should have implied_volatility");
});

test("get_options_expiration: with filter (delta range)", async () => {
  const list = await apiCall("GET", "/v3/options/list", { code: "NASDAQ:AAPL", type: "call", range: 10 });
  const firstCode = list.codes[0];
  const match = firstCode.match(/OPRA:\w+(\d{6})[CP]/);
  const dateStr = match![1];
  const expiration = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;

  const r = await apiCall(
    "GET", "/v3/options/expiration",
    { code: "NASDAQ:AAPL", expiration, range: 10, type: "call" },
    'data[$abs(delta) >= 0.3 and $abs(delta) <= 0.7].{ "code": code, "strike": strike_price, "delta": delta, "iv": implied_volatility }',
  );
  // JSONata may return undefined (no matches), single object, or array
  if (r === undefined) return;
  const arr = Array.isArray(r) ? r : [r];
  assert(arr.length > 0, "should have items");
  assert(typeof arr[0].delta === "number", "should have delta");
  assert(Math.abs(arr[0].delta) >= 0.3, "delta should be >= 0.3");
  assert(Math.abs(arr[0].delta) <= 0.7, "delta should be <= 0.7");
});

// ─── get_options_strike ───
test("get_options_strike: basic", async () => {
  const r = await apiCall("GET", "/v3/options/strike", { code: "NASDAQ:AAPL", range: 5, type: "call" });
  assert(r.underlying_code, "should have underlying_code");
  assert(r.data?.length > 0, "should have strike data");
});

// ─── get_dividends ───
test("get_dividends: basic", async () => {
  const r = await apiCall("GET", "/v3/calendar/dividends", {});
  assert(typeof r.total_count === "number", "should have total_count");
  assert(r.data, "should have data");
});

test("get_dividends: with filters", async () => {
  const r = await apiCall("GET", "/v3/calendar/dividends", { w: 4, c: "US" });
  assert(typeof r.total_count === "number", "should have total_count");
});

// ─── get_earnings ───
test("get_earnings: basic", async () => {
  const r = await apiCall("GET", "/v3/calendar/earnings", {});
  assert(typeof r.total_count === "number", "should have total_count");
  assert(r.data, "should have data");
});

// ─── get_ipos ───
test("get_ipos: basic", async () => {
  const r = await apiCall("GET", "/v3/calendar/ipos", {});
  assert(typeof r.total_count === "number", "should have total_count");
  assert(r.data, "should have data");
});

// ─── get_events ───
test("get_events: basic", async () => {
  const r = await apiCall("GET", "/v3/calendar/events", {});
  assert(typeof r.total_count === "number", "should have total_count");
  assert(r.data, "should have data");
});

// ─── get_newsfeed ───
test("get_newsfeed: basic", async () => {
  const r = await apiCall("GET", "/v3/newsfeed", { limit: "5" });
  assert(typeof r.total_items === "number", "should have total_items");
  assert(r.data?.length > 0, "should have news items");
  assert(r.data[0].title, "should have title");
  assert(typeof r.data[0].published_at === "number", "should have published_at");
});

test("get_newsfeed: with keywords", async () => {
  const r = await apiCall("GET", "/v3/newsfeed", { keywords: "tesla", limit: "5" });
  assert(r.data, "should have data");
});

test("get_newsfeed: with filter (first 3 headlines)", async () => {
  const r = await apiCall(
    "GET", "/v3/newsfeed", { keywords: "tesla", limit: "10" },
    'data[[0..2]].{ "title": title, "published_at": published_at }',
  );
  assert(Array.isArray(r), "should return array");
  assert(r.length <= 3, "should have at most 3 items");
  if (r.length > 0) {
    assert(r[0].title, "should have title");
    assert(typeof r[0].published_at === "number", "should have published_at");
  }
});

// ─── get_stock_screener_params ───
test("get_stock_screener_params: basic", async () => {
  const r = await apiCall("GET", "/v3/screeners/stock", {});
  assert(r.available_fields?.length > 0, "should have available_fields");
  assert(r.available_exchanges?.length > 0, "should have available_exchanges");
  assert(r.available_countries?.length > 0, "should have available_countries");
});

test("get_stock_screener_params: filter by keyword", async () => {
  const r = await apiCall(
    "GET", "/v3/screeners/stock", {},
    'available_fields[$contains($, "volume")]',
  );
  assert(Array.isArray(r) || typeof r === "string", "should return matching fields");
});

// ─── screen_stocks ───
test("screen_stocks: basic", async () => {
  const r = await apiCall("POST", "/v3/screeners/stock", {
    fields: ["close", "volume", "market_cap"],
    exchanges: ["NYSE", "NASDAQ"],
    sortBy: "market_cap",
    sortOrder: "desc",
    page: 1,
  });
  assert(typeof r.current_page === "number", "should have current_page");
  assert(r.data?.length > 0, "should have data");
  assert(r.data[0].symbol_code, "should have symbol_code");
  assert(r.data[0].name, "should have name");
});

test("screen_stocks: with filter (sum market_cap)", async () => {
  const r = await apiCall(
    "POST", "/v3/screeners/stock",
    { fields: ["close", "volume", "market_cap"] },
    "$sum(data[market_cap != null].market_cap)",
  );
  assert(typeof r === "number", "should return a number (sum of market_cap)");
});

test("screen_stocks: with filter (only gainers)", async () => {
  const r = await apiCall(
    "POST", "/v3/screeners/stock",
    { fields: ["close", "volume", "market_cap", "change_percent"], exchanges: ["NYSE", "NASDAQ"] },
    'data[change_percent][change_percent > 0].{ "name": name, "change_percent": change_percent }',
  );
  // JSONata may return undefined (no matches), single object (1 match), or array (multiple matches)
  if (r === undefined) return; // no gainers found
  const arr = Array.isArray(r) ? r : [r];
  assert(arr.length > 0, "should have items");
  assert(arr[0].change_percent > 0, "should only have positive change_percent");
});

// ─── get_etf_screener_params + screen_etfs ───
test("get_etf_screener_params: basic", async () => {
  const r = await apiCall("GET", "/v3/screeners/etf", {});
  assert(r.available_fields?.length > 0, "should have available_fields");
});

test("screen_etfs: basic", async () => {
  const r = await apiCall("POST", "/v3/screeners/etf", {
    fields: ["close", "volume"],
    exchanges: ["NYSE", "NASDAQ"],
    page: 1,
  });
  assert(r.data?.length > 0, "should have ETF data");
});

// ─── get_bond_screener_params + screen_bonds ───
test("get_bond_screener_params: basic", async () => {
  const r = await apiCall("GET", "/v3/screeners/bond", {});
  assert(r.available_fields?.length > 0, "should have available_fields");
});

test("screen_bonds: basic", async () => {
  const r = await apiCall("POST", "/v3/screeners/bond", {
    fields: ["close_percent"],
    countries: ["US"],
    page: 1,
  });
  assert(r.data?.length > 0, "should have bond data");
});

// ─── get_crypto_screener_params + screen_crypto ───
test("get_crypto_screener_params: basic", async () => {
  const r = await apiCall("GET", "/v3/screeners/crypto", {});
  assert(r.available_fields?.length > 0, "should have available_fields");
});

test("screen_crypto: basic", async () => {
  const r = await apiCall("POST", "/v3/screeners/crypto", {
    fields: ["close", "volume", "market_cap"],
    sortBy: "market_cap",
    sortOrder: "desc",
    page: 1,
  });
  assert(r.data?.length > 0, "should have crypto data");
});

// ─── get_documents ───
test("get_documents: basic", async () => {
  const r = await apiCall("GET", "/v3/documents", { code: "NASDAQ:AAPL" });
  assert(Array.isArray(r), "should return array of documents");
  assert(r.length > 0, "should have documents");
  assert(r[0].id, "should have id");
  assert(r[0].title, "should have title");
});

test("get_documents: filter 10-K/10-Q", async () => {
  const r = await apiCall(
    "GET", "/v3/documents", { code: "NASDAQ:AAPL" },
    '$[form="10-K" or form="10-Q"].{ "id": id, "title": title, "form": form }',
  );
  assert(Array.isArray(r), "should return filtered array");
  if (r.length > 0) {
    assert(r[0].form === "10-K" || r[0].form === "10-Q", "should only have 10-K or 10-Q");
  }
});

// ─── get_document ───
test("get_document: read a transcript", async () => {
  const docs = await apiCall("GET", "/v3/documents", { code: "NASDAQ:AAPL" });
  const transcript = docs.find((d: any) => d.category === "Call transcript" && d.is_available && !d.is_pdf);
  assert(transcript, "should find an available call transcript");
  const r = await apiCall("GET", "/v3/documents/{id}", { id: transcript.id, code: "NASDAQ:AAPL" });
  assert(r.title, "should have title");
  assert(r.content, "should have content");
  assert(typeof r.published_at === "number", "should have published_at");
});

// ─── Screener recipe tests (from INSTRUCTIONS) ───
test("screener recipe: value screen", async () => {
  const r = await apiCall(
    "POST", "/v3/screeners/stock",
    {
      fields: ["close", "market_cap", "price_earnings_ttm", "price_free_cash_flow_ttm", "dividends_yield", "enterprise_value_ebitda_ttm"],
      exchanges: ["NYSE", "NASDAQ"],
      sortBy: "market_cap",
      sortOrder: "desc",
    },
    'data[price_earnings_ttm][price_free_cash_flow_ttm][price_earnings_ttm > 0 and price_earnings_ttm < 15 and price_free_cash_flow_ttm < 10].{ "name": name, "code": symbol_code, "pe": price_earnings_ttm, "p_fcf": price_free_cash_flow_ttm, "div_yield": dividends_yield, "ev_ebitda": enterprise_value_ebitda_ttm }',
  );
  // May return undefined, single object, or array — just verify no error
});

test("screener recipe: momentum screen", async () => {
  const r = await apiCall(
    "POST", "/v3/screeners/stock",
    {
      fields: ["close", "market_cap", "change_percent_1W", "performance_3_month", "relative_volume_intraday", "average_volume_30d"],
      exchanges: ["NYSE", "NASDAQ"],
      sortBy: "performance_3_month",
      sortOrder: "desc",
    },
    'data[performance_3_month][relative_volume_intraday][performance_3_month > 20 and relative_volume_intraday > 1.5].{ "name": name, "code": symbol_code, "perf_3m": performance_3_month, "chg_1w": change_percent_1W, "rvol": relative_volume_intraday }',
  );
  // May return undefined, single object, or array — just verify no error
});

test("screener recipe: quality screen", async () => {
  const r = await apiCall(
    "POST", "/v3/screeners/stock",
    {
      fields: ["close", "market_cap", "return_on_invested_capital_fq", "debt_to_equity_fq", "operating_margin_ttm", "free_cash_flow_margin_ttm", "gross_margin_ttm"],
      exchanges: ["NYSE", "NASDAQ"],
      sortBy: "market_cap",
      sortOrder: "desc",
    },
    'data[return_on_invested_capital_fq][debt_to_equity_fq][operating_margin_ttm][return_on_invested_capital_fq > 20 and debt_to_equity_fq < 1 and operating_margin_ttm > 25].{ "name": name, "code": symbol_code, "roic": return_on_invested_capital_fq, "d_e": debt_to_equity_fq, "op_margin": operating_margin_ttm, "fcf_margin": free_cash_flow_margin_ttm }',
  );
  // May return undefined, single object, or array — just verify no error
});

test("screener recipe: volatility + volume spike", async () => {
  const r = await apiCall(
    "POST", "/v3/screeners/stock",
    {
      fields: ["close", "market_cap", "volatility_week", "volatility_month", "relative_volume_intraday", "gap", "change_percent"],
      exchanges: ["NYSE", "NASDAQ"],
      sortBy: "relative_volume_intraday",
      sortOrder: "desc",
    },
    'data[relative_volume_intraday][volatility_week][relative_volume_intraday > 2 and volatility_week > 3].{ "name": name, "code": symbol_code, "vol_w": volatility_week, "rvol": relative_volume_intraday, "gap": gap, "chg": change_percent }',
  );
  // May return undefined, single object, or array — just verify no error
});

// ─── Runner ───
function assert(condition: any, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function run() {
  console.log(`\nRunning ${tests.length} tests...\n`);
  for (const t of tests) {
    const start = Date.now();
    try {
      await t.fn();
      const ms = Date.now() - start;
      passed++;
      console.log(`  ✓ ${t.name} (${ms}ms)`);
    } catch (err: any) {
      const ms = Date.now() - start;
      failed++;
      const msg = err.message || String(err);
      failures.push({ name: t.name, error: msg });
      console.log(`  ✗ ${t.name} (${ms}ms)`);
      console.log(`    ${msg}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      console.log(`    ${f.error}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

run();
