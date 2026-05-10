import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { z } from "zod";
import { ApiClient } from "./api-client.js";
import { coerceArgs, getZodEnumValues, getZodTypeName, isOptionalZodType } from "./arg-coercion.js";
import { type AuthStatus, getAuthStatus } from "./auth-status.js";
import { deleteConfig, getConfigLocation, resolveApiKey, saveConfig } from "./config.js";
import { type DownloadHistoryOptions, downloadHistory } from "./history.js";
import { type ToolDefinition, toolDefinitions } from "./tool-definitions.js";
import { runApiTool } from "./tool-runner.js";

export { coerceArgs } from "./arg-coercion.js";

const DOWNLOAD_HISTORY_COMMAND = "download_history";
const MAX_INTERACTIVE_PROMPT_ATTEMPTS = 3;
const DOWNLOAD_HISTORY_BAR_TYPES: readonly string[] = [
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
];

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
  lines.push(
    `  ${DOWNLOAD_HISTORY_COMMAND.padEnd(32)} Download historical ranges to JSON/CSV files with concurrency and progress`,
  );

  lines.push("");
  lines.push("Quick Start:");
  lines.push('  insight search_symbols --query "apple"');
  lines.push('  insight get_quotes --codes "NASDAQ:AAPL,NASDAQ:MSFT"');
  lines.push('  insight get_symbol_series --symbol "NASDAQ:AAPL" --bar_type day --dp 30');
  lines.push(
    '  insight download_history --symbol "NASDAQ:AAPL" --bar_type minute --from 2024-01 --to 2024-03 --output_dir ./data --format csv',
  );
  lines.push(
    '  insight screen_stocks --fields "close,volume,market_cap" --exchanges "NYSE,NASDAQ" --sortBy market_cap --sortOrder desc',
  );
  lines.push("  insight get_earnings --c US");
  lines.push('  insight list_options --code "NASDAQ:AAPL" --type call --range 10');
  lines.push("");
  lines.push("All tools support --filter <jsonata> to transform the response.");
  lines.push("Use: insight <tool> --help for tool-specific parameters.");
  lines.push("");
  lines.push("Authentication:");
  lines.push("  insight login --key <your-api-key>    Save API key (persisted across sessions)");
  lines.push("  insight whoami                        Print the logged-in user's email");
  lines.push("  insight logout                        Remove saved API key");
  lines.push("");
  lines.push(
    "  Or set INSIGHTSENTRY_API_KEY environment variable (takes priority over saved key).",
  );
  lines.push("  Get your API key from https://insightsentry.com/dashboard");

  return lines.join("\n");
}

export function buildDownloadHistoryHelp(): string {
  return [
    `insight ${DOWNLOAD_HISTORY_COMMAND}`,
    "",
    "Download historical data for a date range and save files locally. second/minute/hour use /history. day/week/month use /series. Continuous futures ending in 1! or 2! are expanded through the contracts endpoint into specific contract codes for second/minute/hour.",
    "",
    "Parameters:",
    "  --symbol                   string   Required. Symbol code, e.g. NASDAQ:AAPL or CME_MINI:NQ1!",
    "  --bar_type                 enum(second|minute|hour|day|week|month) Required. second uses daily /history requests; minute/hour use monthly /history requests; day/week/month use /series.",
    "  --from                     string   Required. Start date, YYYY-MM or YYYY-MM-DD.",
    "  --to                       string   Required. End date, YYYY-MM or YYYY-MM-DD.",
    "  --output_dir               string   Required. Directory where files will be written.",
    "  --format                   enum(json|csv|both) [optional] Default: csv.",
    "  --merge                    boolean [optional] Write one merged CSV when format is csv or both. Default: true.",
    "  --keep_chunks              boolean [optional] Keep per-request CSV chunk files after merge. Default: false.",
    "  --concurrency              number [optional] Concurrent history requests, 1-10. Default: 5.",
    "  --bar_interval             number [optional] Bar interval, 1-1440. Default: 1.",
    "  --contract_lookback_months number [optional] Futures contract months ending at settlement. Default: 6.",
    "  --overwrite                boolean [optional] Replace existing output files. Default: false.",
    "  --extended                 boolean [optional] Pass through to the request.",
    "  --dadj                     boolean [optional] Pass through to the request.",
    "  --badj                     boolean [optional] Pass through to the request.",
    "  --settlement               boolean [optional] Pass through to the request.",
    "",
    "Examples:",
    '  insight download_history --symbol "NASDAQ:AAPL" --bar_type minute --from 2024-01 --to 2024-06 --output_dir ./history --format csv --merge',
    '  insight download_history --symbol "NASDAQ:AAPL" --bar_type second --from 2024-06-01 --to 2024-06-14 --output_dir ./history --concurrency 5',
    '  insight download_history --symbol "CME_MINI:NQ1!" --bar_type hour --from 2025-01 --to 2025-12 --output_dir ./futures --format both',
  ].join("\n");
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
  get_symbol_contracts: ['insight get_symbol_contracts --symbol "CME_MINI:NQ1!"'],
  get_symbol_info: [
    'insight get_symbol_info --symbol "NASDAQ:AAPL"',
    `insight get_symbol_info --symbol "NASDAQ:AAPL" --filter '{ "sector": sector, "market_cap": market_cap, "pe": price_earnings_ttm }'`,
  ],
  get_symbol_session: ['insight get_symbol_session --symbol "NASDAQ:AAPL"'],
  get_symbol_fundamentals: [
    "insight get_symbol_fundamentals --symbol \"NASDAQ:AAPL\" --filter '$distinct(data.category)'",
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
    "insight get_dividends --c US",
    'insight get_dividends --code "NASDAQ:AAPL" --w 4',
  ],
  get_earnings: ["insight get_earnings --c US", 'insight get_earnings --code "NASDAQ:AAPL"'],
  get_ipos: ["insight get_ipos --c US", "insight get_ipos --w 4"],
  get_events: ["insight get_events --c US", "insight get_events --w 2"],
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
    "insight get_stock_screener_params",
    `insight get_stock_screener_params --filter 'available_fields[$contains($, "volume")]'`,
  ],
  get_etf_screener_params: ["insight get_etf_screener_params"],
  get_bond_screener_params: ["insight get_bond_screener_params"],
  get_crypto_screener_params: ["insight get_crypto_screener_params"],
  get_documents: [
    'insight get_documents --code "NASDAQ:AAPL"',
    `insight get_documents --code "NASDAQ:AAPL" --filter '$[form="10-K" or form="10-Q"].{ "id": id, "title": title, "form": form }'`,
  ],
  get_document: ['insight get_document --id "transcripts:2133670" --code "NASDAQ:AAPL" --text'],
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
    const optional = isOptionalZodType(zodType) ? " [optional]" : "";
    const desc = getZodDescription(zodType);
    const typeName = formatTypeName(zodType);
    lines.push(`  --${key.padEnd(24)} ${typeName}${optional}  ${desc}`);
  }

  // filter is always available
  lines.push(
    `  --${"filter".padEnd(24)} string [optional]  JSONata expression to transform the response`,
  );
  lines.push(
    `  --${"store".padEnd(24)} enum(none|json|csv) [optional]  Store the response instead of printing it. Default is none. csv is only for get_symbol_series.`,
  );
  lines.push(`  --${"output_file".padEnd(24)} string [optional]  File path for stored response.`);
  lines.push(
    `  --${"output_dir".padEnd(24)} string [optional]  Directory for stored response when output_file is not set.`,
  );

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

type RequestFn = (
  method: string,
  pathTemplate: string,
  params: Record<string, any>,
) => Promise<any>;

interface CliIO {
  write: (s: string) => void;
  exit: (code: number) => void;
  request?: RequestFn;
  progress?: (s: string) => void;
  prompt?: (question: string) => Promise<string>;
  isInteractive?: boolean;
  getAuthStatus?: () => AuthStatus;
}

const REQUIRED_DOWNLOAD_HISTORY_ARGS = ["symbol", "bar_type", "from", "to", "output_dir"] as const;
type RequiredDownloadHistoryArg = (typeof REQUIRED_DOWNLOAD_HISTORY_ARGS)[number];

export async function runCli(argv: string[], io: CliIO): Promise<void> {
  const { toolName, args, help } = parseArgs(argv);

  if (!toolName) {
    io.write(buildHelp());
    io.exit(0);
    return;
  }

  // Built-in commands
  if (toolName === "login") {
    const key = await resolveLoginKey(args, io);
    if (!key) {
      io.write(
        "Usage: insight login --key <your-api-key>\n\nGet your API key from https://insightsentry.com/dashboard",
      );
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

  if (toolName === "whoami") {
    const status = (io.getAuthStatus ?? getAuthStatus)();
    if (status.subject) {
      io.write(status.subject);
      io.exit(0);
    } else {
      io.write(`Error: ${status.message}`);
      io.exit(1);
    }
    return;
  }

  if (toolName === DOWNLOAD_HISTORY_COMMAND) {
    if (help) {
      io.write(buildDownloadHistoryHelp());
      io.exit(0);
      return;
    }

    const request = resolveRequest(io);
    if (!request) {
      io.write(
        "Error: No API key found.\n\nSet it with:  insight login --key <your-api-key>\nOr export:    export INSIGHTSENTRY_API_KEY=your-api-key\n\nGet your API key from https://insightsentry.com/dashboard",
      );
      io.exit(1);
      return;
    }

    try {
      const historyArgs = await resolveDownloadHistoryArgs(args, io);
      if (!historyArgs) {
        io.write(
          `Error: Missing required options for download_history: ${missingDownloadHistoryArgs(args).join(", ")}\n\nRun: insight download_history --help`,
        );
        io.exit(1);
        return;
      }
      const result = await downloadHistory(parseDownloadHistoryArgs(historyArgs), {
        request,
        onProgress: (event) => {
          const target = event.files.length ? ` -> ${event.files.join(", ")}` : "";
          const error = event.error ? ` (${event.error})` : "";
          io.progress?.(
            `[${event.completed}/${event.total}] ${event.status} ${event.symbol} ${event.start_date}${target}${error}`,
          );
        },
      });
      io.write(JSON.stringify(result, null, 2));
    } catch (error: any) {
      io.write(`Error: ${error.message}\n`);
      io.exit(1);
    }
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
  const request = resolveRequest(io);
  if (!request) {
    io.write(
      "Error: No API key found.\n\nSet it with:  insight login --key <your-api-key>\nOr export:    export INSIGHTSENTRY_API_KEY=your-api-key\n\nGet your API key from https://insightsentry.com/dashboard",
    );
    io.exit(1);
    return;
  }

  const resolvedArgs = await resolveToolArgs(args, tool, io);
  if (!resolvedArgs) {
    io.write(
      `Error: Missing required options for ${tool.name}: ${missingToolArgs(args, tool).join(", ")}\n\nRun: insight ${tool.name} --help`,
    );
    io.exit(1);
    return;
  }

  try {
    const outputValue = await runApiTool({
      toolName: tool.name,
      method: tool.method,
      pathTemplate: tool.pathTemplate,
      args: coerceArgs(resolvedArgs, tool.schema),
      request,
    });
    const output =
      typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue, null, 2);
    io.write(output);
  } catch (error: any) {
    io.write(`Error: ${error.message}\n`);
    io.exit(1);
  }
}

async function resolveLoginKey(args: Record<string, string>, io: CliIO): Promise<string | null> {
  if (args.key?.trim()) return args.key.trim();
  if (io.isInteractive !== true || !io.prompt) return null;

  const answer = (await io.prompt("API key: ")).trim();
  return answer || null;
}

function resolveRequest(io: CliIO): RequestFn | null {
  if (io.request) return io.request;
  const apiKey = resolveApiKey();
  if (!apiKey) return null;
  const client = new ApiClient(apiKey);
  return (method, path, params) => client.request(method, path, params);
}

function missingToolArgs(args: Record<string, string>, tool: ToolDefinition): string[] {
  return Object.entries(tool.schema)
    .filter(([_key, zodType]) => !isOptionalZodType(zodType))
    .map(([key]) => key)
    .filter((key) => !args[key]);
}

async function resolveToolArgs(
  args: Record<string, string>,
  tool: ToolDefinition,
  io: CliIO,
): Promise<Record<string, string> | null> {
  const resolved = { ...args };
  const missing = missingToolArgs(resolved, tool);
  if (missing.length > 0) {
    if (io.isInteractive !== true || !io.prompt) return null;

    for (const key of missing) {
      const answer = await promptForToolArg(key, tool.schema[key], io);
      if (!answer) return null;
      resolved[key] = answer;
    }

    if (missingToolArgs(resolved, tool).length > 0) return null;
  }

  if (
    io.isInteractive === true &&
    io.prompt &&
    isStoreEnabled(resolved.store) &&
    !resolved.output_file &&
    !resolved.output_dir
  ) {
    const answer = (await io.prompt("Output file: ")).trim();
    if (answer) resolved.output_file = answer;
  }

  return resolved;
}

function isStoreEnabled(value: string | undefined): boolean {
  return value === "json" || value === "csv";
}

function toolPromptLabel(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function missingDownloadHistoryArgs(args: Record<string, string>): RequiredDownloadHistoryArg[] {
  return REQUIRED_DOWNLOAD_HISTORY_ARGS.filter((key) => !args[key]);
}

async function resolveDownloadHistoryArgs(
  args: Record<string, string>,
  io: CliIO,
): Promise<Record<string, string> | null> {
  const missing = missingDownloadHistoryArgs(args);
  if (missing.length === 0) return args;
  if (io.isInteractive !== true || !io.prompt) return null;

  const resolved = { ...args };
  for (const key of missing) {
    const answer = await promptForDownloadHistoryArg(key, io);
    if (!answer) return null;
    resolved[key] = answer;
  }

  return missingDownloadHistoryArgs(resolved).length === 0 ? resolved : null;
}

async function promptForToolArg(
  key: string,
  zodType: z.ZodTypeAny,
  io: CliIO,
): Promise<string | null> {
  const label = toolPromptLabel(key);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(`${label}: `))?.trim() ?? "";
    const error = validateToolArgAnswer(key, zodType, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

function validateToolArgAnswer(key: string, zodType: z.ZodTypeAny, answer: string): string | null {
  if (!answer) return "value is required";

  const coerced = coerceArgs({ [key]: answer }, { [key]: zodType })[key];
  const parsed = zodType.safeParse(coerced);
  if (parsed.success) return null;

  const enumValues = getZodEnumValues(zodType);
  if (enumValues.length > 0) return `expected one of: ${enumValues.join(", ")}`;
  return parsed.error.issues.map((issue) => issue.message).join("; ");
}

async function promptForDownloadHistoryArg(
  key: RequiredDownloadHistoryArg,
  io: CliIO,
): Promise<string | null> {
  const label = downloadHistoryPromptLabel(key);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(`${label}: `))?.trim() ?? "";
    const error = validateDownloadHistoryArgAnswer(key, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

function validateDownloadHistoryArgAnswer(
  key: RequiredDownloadHistoryArg,
  answer: string,
): string | null {
  if (!answer) return "value is required";
  if (key === "bar_type" && !DOWNLOAD_HISTORY_BAR_TYPES.includes(answer)) {
    return `expected one of: ${DOWNLOAD_HISTORY_BAR_TYPES.join(", ")}`;
  }
  return null;
}

function downloadHistoryPromptLabel(key: RequiredDownloadHistoryArg): string {
  switch (key) {
    case "symbol":
      return "Symbol";
    case "bar_type":
      return "Bar type (second/minute/hour/day/week/month)";
    case "from":
      return "From (YYYY-MM or YYYY-MM-DD)";
    case "to":
      return "To (YYYY-MM or YYYY-MM-DD)";
    case "output_dir":
      return "Output directory";
  }
}

function parseDownloadHistoryArgs(args: Record<string, string>): DownloadHistoryOptions {
  const options: DownloadHistoryOptions = {
    symbol: args.symbol,
    from: args.from,
    to: args.to,
    bar_type: args.bar_type as DownloadHistoryOptions["bar_type"],
    output_dir: args.output_dir,
  };

  for (const key of ["bar_interval", "concurrency", "contract_lookback_months"] as const) {
    if (args[key] !== undefined) options[key] = Number(args[key]);
  }
  for (const key of [
    "overwrite",
    "merge",
    "keep_chunks",
    "extended",
    "dadj",
    "badj",
    "settlement",
  ] as const) {
    if (args[key] !== undefined) options[key] = args[key] === "true";
  }
  if (args.format !== undefined) {
    options.format = args.format as DownloadHistoryOptions["format"];
  }

  return options;
}

export function main() {
  const rl = createInterface({ input, output });
  runCli(process.argv.slice(2), {
    write: (s) => process.stdout.write(`${s}\n`),
    progress: (s) => process.stderr.write(`${s}\n`),
    prompt: (question) => rl.question(question),
    isInteractive: process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== "true",
    exit: (code) => process.exit(code),
  }).finally(() => rl.close());
}
