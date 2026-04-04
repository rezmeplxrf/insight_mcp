import { z } from "zod";
import jsonata from "jsonata";
import { ApiClient } from "./api-client.js";
import { toolDefinitions, type ToolDefinition } from "./tool-definitions.js";
import { saveConfig, deleteConfig, resolveApiKey, getConfigLocation } from "./config.js";

interface ParsedArgs {
  toolName: string | null;
  args: Record<string, string>;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: Record<string, string> = {};
  let toolName: string | null = null;
  let help = false;

  let i = 0;

  // First non-flag arg is the tool name
  if (i < argv.length && !argv[i].startsWith("-")) {
    toolName = argv[i];
    i++;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = "true";
        i++;
      } else {
        args[key] = next;
        i += 2;
      }
    } else {
      i++;
    }
  }

  return { toolName, args, help };
}

export function coerceArgs(
  args: Record<string, string>,
  schema: Record<string, z.ZodTypeAny>,
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(args)) {
    const zodType = schema[key];
    if (!zodType) {
      result[key] = value;
      continue;
    }

    const typeName = getZodTypeName(zodType);

    if (typeName === "number") {
      result[key] = Number(value);
    } else if (typeName === "boolean") {
      result[key] = value === "true";
    } else if (typeName === "array") {
      if (value.startsWith("[")) {
        try {
          result[key] = JSON.parse(value);
          continue;
        } catch { /* fall through to comma split */ }
      }
      result[key] = value.split(",").map((s) => s.trim());
    } else {
      result[key] = value;
    }
  }

  return result;
}

/** Unwrap optional/default wrappers and return the base Zod def (works across Zod v3 and v4) */
function resolveZodDef(t: z.ZodTypeAny): { type: string; def: any } {
  const def = (t as any)._zod?.def ?? (t as any)._def ?? {};
  const type: string = def.type ?? def.typeName ?? "";
  if ((type === "optional" || type === "default") && def.innerType) {
    return resolveZodDef(def.innerType);
  }
  return { type, def };
}

function getZodTypeName(t: z.ZodTypeAny): string {
  return resolveZodDef(t).type;
}

function getZodEnumValues(t: z.ZodTypeAny): string[] {
  const { type, def } = resolveZodDef(t);
  if (type === "enum" && def.entries) {
    return Object.values(def.entries) as string[];
  }
  return [];
}

export function buildHelp(): string {
  const lines = [
    "insight — CLI for the InsightSentry financial data API",
    "",
    "Usage: insight <tool> [--param value ...]",
    "",
    "Tools:",
  ];

  for (const tool of toolDefinitions) {
    const desc = tool.description.split(".")[0]; // first sentence
    lines.push(`  ${tool.name.padEnd(32)} ${desc}`);
  }

  lines.push("");
  lines.push("Quick Start:");
  lines.push('  insight search_symbols --query "apple"');
  lines.push('  insight get_quotes --codes "NASDAQ:AAPL,NASDAQ:MSFT"');
  lines.push('  insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --dp 30');
  lines.push('  insight screen_stocks --fields "close,volume,market_cap" --exchanges "NYSE,NASDAQ" --sortBy market_cap --sortOrder desc');
  lines.push('  insight get_earnings --c US');
  lines.push('  insight list_options --code "NASDAQ:AAPL" --type call --range 10');
  lines.push("");
  lines.push("All tools support --filter <jsonata> to transform the response.");
  lines.push("Use: insight <tool> --help for tool-specific parameters.");
  lines.push("");
  lines.push("Authentication:");
  lines.push("  insight login --key <your-api-key>    Save API key (persisted across sessions)");
  lines.push("  insight logout                        Remove saved API key");
  lines.push("");
  lines.push("  Or set INSIGHTSENTRY_API_KEY environment variable (takes priority over saved key).");
  lines.push("  Get your API key from https://insightsentry.com/dashboard");

  return lines.join("\n");
}

const toolExamples: Record<string, string[]> = {
  search_symbols: [
    'insight search_symbols --query "tesla"',
    'insight search_symbols --query "bitcoin" --type crypto',
    'insight search_symbols --query "NASDAQ:" --type stock --country US',
  ],
  get_quotes: [
    'insight get_quotes --codes "NASDAQ:AAPL,NASDAQ:MSFT"',
    'insight get_quotes --codes "BINANCE:BTCUSDT"',
    `insight get_quotes --codes "NASDAQ:AAPL" --filter '{ "price": data[0].last_price, "change": data[0].change_percent }'`,
  ],
  get_symbol_series: [
    'insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --dp 30',
    'insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type minute --bar_interval 5 --dp 100',
    `insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --dp 30 --filter '{ "last_close": series[-1].close, "avg_vol": $average(series.volume) }'`,
  ],
  get_symbol_history: [
    'insight get_symbol_history --symbol "NASDAQ:AAPL" --bar_type minute --start_date "2025-01"',
    'insight get_symbol_history --symbol "NASDAQ:AAPL" --bar_type hour --start_date "2025-06" --bar_interval 4',
  ],
  get_symbol_contracts: [
    'insight get_symbol_contracts --symbol "CME_MINI:NQ1!"',
  ],
  get_symbol_info: [
    'insight get_symbol_info --symbol "NASDAQ:AAPL"',
    `insight get_symbol_info --symbol "NASDAQ:AAPL" --filter '{ "sector": sector, "market_cap": market_cap, "pe": price_earnings_ttm }'`,
  ],
  get_symbol_session: [
    'insight get_symbol_session --symbol "NASDAQ:AAPL"',
  ],
  get_symbol_fundamentals: [
    'insight get_symbol_fundamentals --symbol "NASDAQ:AAPL" --filter \'$distinct(data.category)\'',
    `insight get_symbol_fundamentals --symbol "NASDAQ:AAPL" --filter 'data[category="Valuation"].{ "id": id, "name": name, "value": value }'`,
  ],
  get_fundamentals_series: [
    'insight get_fundamentals_series --symbol "NASDAQ:AAPL" --ids "total_revenue,net_income"',
  ],
  get_fundamentals_meta: [
    `insight get_fundamentals_meta --filter '$distinct(base.category)'`,
    `insight get_fundamentals_meta --filter 'base[$contains($lowercase(name), "cash flow")].{ "id": id, "name": name }'`,
  ],
  list_options: [
    'insight list_options --code "NASDAQ:AAPL" --type call --range 10',
    'insight list_options --code "NASDAQ:AAPL" --expiration_min "2026-06-01" --expiration_max "2026-12-31"',
  ],
  get_options_expiration: [
    'insight get_options_expiration --code "NASDAQ:AAPL" --expiration "2026-06-19" --type call',
    'insight get_options_expiration --code "NASDAQ:AAPL" --from "2026-06-01" --to "2026-07-01" --range 10',
  ],
  get_options_strike: [
    'insight get_options_strike --code "NASDAQ:AAPL" --strike 250 --type call',
    'insight get_options_strike --code "NASDAQ:AAPL" --range 5 --sortBy delta --sort desc',
  ],
  get_dividends: [
    'insight get_dividends --c US',
    'insight get_dividends --code "NASDAQ:AAPL" --w 4',
  ],
  get_earnings: [
    'insight get_earnings --c US',
    'insight get_earnings --code "NASDAQ:AAPL"',
  ],
  get_ipos: [
    'insight get_ipos --c US',
    'insight get_ipos --w 4',
  ],
  get_events: [
    'insight get_events --c US',
    'insight get_events --w 2',
  ],
  get_newsfeed: [
    'insight get_newsfeed --keywords "tesla,apple" --limit 10',
    `insight get_newsfeed --keywords "bitcoin" --filter 'data[[0..4]].{ "title": title, "published_at": published_at }'`,
  ],
  screen_stocks: [
    'insight screen_stocks --fields "close,volume,market_cap" --exchanges "NYSE,NASDAQ" --sortBy market_cap --sortOrder desc',
    `insight screen_stocks --fields "close,market_cap,price_earnings_ttm" --exchanges "NYSE,NASDAQ" --sortBy market_cap --sortOrder desc --filter 'data[price_earnings_ttm < 15].{ "name": name, "pe": price_earnings_ttm }'`,
  ],
  screen_etfs: [
    'insight screen_etfs --fields "close,volume,nav" --exchanges "NYSE,NASDAQ" --sortBy nav --sortOrder desc',
  ],
  screen_bonds: [
    'insight screen_bonds --fields "close_percent,yield_to_maturity,volume" --countries "US" --sortBy yield_to_maturity --sortOrder desc',
  ],
  screen_crypto: [
    'insight screen_crypto --fields "close,volume,market_cap" --sortBy market_cap --sortOrder desc',
  ],
  get_stock_screener_params: [
    'insight get_stock_screener_params',
    `insight get_stock_screener_params --filter 'available_fields[$contains($, "volume")]'`,
  ],
  get_etf_screener_params: [
    'insight get_etf_screener_params',
  ],
  get_bond_screener_params: [
    'insight get_bond_screener_params',
  ],
  get_crypto_screener_params: [
    'insight get_crypto_screener_params',
  ],
  get_documents: [
    'insight get_documents --code "NASDAQ:AAPL"',
    `insight get_documents --code "NASDAQ:AAPL" --filter '$[form="10-K" or form="10-Q"].{ "id": id, "title": title, "form": form }'`,
  ],
  get_document: [
    'insight get_document --id "transcripts:2133670" --code "NASDAQ:AAPL" --text',
  ],
};

export function buildToolHelp(tool: ToolDefinition): string {
  const lines = [
    `insight ${tool.name}`,
    "",
    tool.description.split("→")[0].trim(),
    "",
    "Parameters:",
  ];

  for (const [key, zodType] of Object.entries(tool.schema)) {
    const optional = zodType.isOptional() ? " [optional]" : "";
    const desc = getZodDescription(zodType);
    const typeName = formatTypeName(zodType);
    lines.push(`  --${key.padEnd(24)} ${typeName}${optional}  ${desc}`);
  }

  // filter is always available
  lines.push(`  --${"filter".padEnd(24)} string [optional]  JSONata expression to transform the response`);

  const examples = toolExamples[tool.name];
  if (examples?.length) {
    lines.push("");
    lines.push("Examples:");
    for (const ex of examples) {
      lines.push(`  ${ex}`);
    }
  }

  return lines.join("\n");
}

function getZodDescription(t: z.ZodTypeAny): string {
  if (t.description) return t.description;
  const def = (t as any)._zod?.def ?? (t as any)._def ?? {};
  if (def.innerType) return getZodDescription(def.innerType);
  return "";
}

function formatTypeName(t: z.ZodTypeAny): string {
  const name = getZodTypeName(t);
  if (name === "enum") {
    const values = getZodEnumValues(t);
    return values.length ? `enum(${values.join("|")})` : "enum";
  }
  return name || "string";
}

type RequestFn = (method: string, pathTemplate: string, params: Record<string, any>) => Promise<any>;

interface CliIO {
  write: (s: string) => void;
  exit: (code: number) => void;
  request?: RequestFn;
}

export async function runCli(argv: string[], io: CliIO): Promise<void> {
  const { toolName, args, help } = parseArgs(argv);

  if (!toolName) {
    io.write(buildHelp());
    io.exit(0);
    return;
  }

  // Built-in commands
  if (toolName === "login") {
    const key = args.key;
    if (!key) {
      io.write("Usage: insight login --key <your-api-key>\n\nGet your API key from https://insightsentry.com/dashboard");
      io.exit(1);
      return;
    }
    saveConfig({ apiKey: key });
    io.write(`API key saved to ${getConfigLocation()}`);
    io.exit(0);
    return;
  }

  if (toolName === "logout") {
    deleteConfig();
    io.write(`API key removed from ${getConfigLocation()}`);
    io.exit(0);
    return;
  }

  // Find tool
  const tool = toolDefinitions.find((t) => t.name === toolName);
  if (!tool) {
    io.write(`Error: Unknown tool "${toolName}". Run insight --help for available tools.\n`);
    io.exit(1);
    return;
  }

  // Tool help
  if (help) {
    io.write(buildToolHelp(tool));
    io.exit(0);
    return;
  }

  // Resolve request function
  let request: RequestFn;
  if (io.request) {
    request = io.request;
  } else {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      io.write("Error: No API key found.\n\nSet it with:  insight login --key <your-api-key>\nOr export:    export INSIGHTSENTRY_API_KEY=your-api-key\n\nGet your API key from https://insightsentry.com/dashboard");
      io.exit(1);
      return;
    }
    const client = new ApiClient(apiKey);
    request = (method, path, params) => client.request(method, path, params);
  }

  const { filter: filterExpr, ...apiArgs } = coerceArgs(args, tool.schema);

  try {
    let result = await request(tool.method, tool.pathTemplate, apiArgs);

    if (filterExpr && typeof filterExpr === "string") {
      const expr = jsonata(filterExpr);
      result = await expr.evaluate(result);
    }

    const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    io.write(output);
  } catch (error: any) {
    io.write(`Error: ${error.message}\n`);
    io.exit(1);
  }
}

export function main() {
  runCli(process.argv.slice(2), {
    write: (s) => process.stdout.write(s + "\n"),
    exit: (code) => process.exit(code),
  });
}
