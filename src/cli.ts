import { execFile } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type { ChartConfiguration } from "chart.js";
import { z } from "zod";
import { ApiClient, validateApiPlanEntitlements } from "./api-client.js";
import { coerceArgs, getZodEnumValues, getZodTypeName, isOptionalZodType } from "./arg-coercion.js";
import { type AuthStatus, getAuthStatus, validateApiKeyForLogin } from "./auth-status.js";
import { renderChart } from "./chart.js";
import {
  deleteConfig,
  getConfigLocation,
  getVersionCacheLocation,
  resolveApiKey,
  saveConfig,
} from "./config.js";
import { downloadHistorySchema } from "./download-history-schema.js";
import {
  type DownloadHistoryOptions,
  downloadHistory,
  validateOutputDirectory,
} from "./history.js";
import { validateHistoryIntervalArgs } from "./history-validation.js";
import { PACKAGE_JSON } from "./package-info.js";
import {
  type ResponseStoreFormat,
  supportsCsvStorage,
  validateResponseStorageTarget,
} from "./response-storage.js";
import { analyzeSymbolCodes, shouldPromptSymbolScopedParam } from "./symbol-param-applicability.js";
import { validateSymbolLikeArg } from "./symbol-validation.js";
import { type ToolDefinition, toolDefinitions } from "./tool-definitions.js";
import { runApiTool, validateFilterExpression } from "./tool-runner.js";
import {
  fetchLatestPackageVersion,
  formatUpgradeNotice,
  formatVersionStatus,
  getVersionStatus,
  type LatestVersionProvider,
} from "./version-status.js";

export { coerceArgs } from "./arg-coercion.js";

const DOWNLOAD_HISTORY_COMMAND = "download_history";
const RENDER_CHART_COMMAND = "render_chart";
const UPDATE_COMMAND = "update";
const VERSION_COMMAND = "version";
const MAX_INTERACTIVE_PROMPT_ATTEMPTS = 3;
const execFileAsync = promisify(execFile);
const STORAGE_DESTINATION_SCHEMA: Record<"output_file" | "output_dir", z.ZodTypeAny> = {
  output_file: z.string().describe("File path for stored response.").optional(),
  output_dir: z
    .string()
    .describe("Directory for stored response when output_file is not set.")
    .optional(),
};
const JSON_STORE_SCHEMA = z
  .enum(["none", "json"])
  .default("none")
  .optional()
  .describe("Store original API response before filtering. Default: none.");
const CSV_STORE_SCHEMA = z
  .enum(["none", "json", "csv"])
  .default("none")
  .optional()
  .describe(
    "Store original API response before filtering. CSV is available for series/history responses. Default: none.",
  );
const FILTER_SCHEMA = z
  .string()
  .optional()
  .describe("JSONata expression to transform the response. Leave empty for no filter.");
const RENDER_CHART_SCHEMA: Record<"config" | "width" | "height", z.ZodTypeAny> = {
  config: z
    .string()
    .describe('Chart.js configuration as JSON. Must include "type" and "data" fields.'),
  width: z
    .number()
    .int()
    .min(200)
    .max(2000)
    .default(800)
    .optional()
    .describe("Chart width in pixels. Default: 800."),
  height: z
    .number()
    .int()
    .min(200)
    .max(2000)
    .default(400)
    .optional()
    .describe("Chart height in pixels. Default: 400."),
};

interface ParsedArgs {
  toolName: string | null;
  args: Record<string, string>;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: Record<string, string> = {};
  let toolName: string | null = null;
  let help = false;
  let version = false;

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
    if (arg === "--version" || arg === "-v") {
      version = true;
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

  return { toolName, args, help, version };
}

export function buildVersion(): string {
  return `${PACKAGE_JSON.name} ${PACKAGE_JSON.version}`;
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
  lines.push(`  ${RENDER_CHART_COMMAND.padEnd(32)} Render Chart.js configs as PNG images`);

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
  lines.push("API tools support --filter <jsonata> to transform the response.");
  lines.push("Use: insight <tool> --help for tool-specific parameters.");
  lines.push("");
  lines.push("Authentication:");
  lines.push("  insight login --key <your-api-key>    Save API key (persisted across sessions)");
  lines.push("  insight whoami                        Print the logged-in user's email");
  lines.push("  insight version                       Check current/latest CLI version");
  lines.push("  insight logout                        Remove saved API key");
  lines.push("  insight update                        Update this CLI with npm");
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
    "Download historical bars to local JSON or CSV files. Intraday bars use /history; day/week/month use /series. Continuous futures ending in 1! or 2! expand to contract codes for intraday bars.",
    "",
    "Parameters:",
    "  --symbol                   string   Required. Symbol code, e.g. NASDAQ:AAPL or CME_MINI:NQ1!",
    "  --bar_type                 enum(second|minute|hour|day|week|month) Required. Request granularity.",
    "  --from                     string   Required. Start date, YYYY-MM or YYYY-MM-DD.",
    "  --to                       string   Required. End date, YYYY-MM or YYYY-MM-DD.",
    "  --output_dir               string   Required. Directory where files will be written.",
    "  --format                   enum(json|csv|both) [optional] Output format. Default: csv.",
    "  --merge                    boolean [optional] Write one merged CSV when format is csv or both. Default: true.",
    "  --keep_chunks              boolean [optional] Keep CSV chunk files after merge. Default: false.",
    "  --concurrency              number [optional] Concurrent requests, 1-10. Default: 5.",
    "  --bar_interval             number [optional] Bar interval, 1-1440. Default: 1.",
    "  --contract_lookback_months number [optional] Prior futures contract months to include. Default: 6.",
    "  --overwrite                boolean [optional] Replace existing output files. Default: false.",
    "  --extended                 boolean [optional] Include extended hours. Default: true.",
    "  --dadj                     boolean [optional] Apply dividend adjustment. Default: false.",
    "  --badj                     boolean [optional] Back-adjust continuous futures. Default: true.",
    "  --split                    boolean [optional] Apply split adjustment. Default: true.",
    "  --settlement               boolean [optional] Use settlement as daily close. Default: false.",
    "",
    "Examples:",
    '  insight download_history --symbol "NASDAQ:AAPL" --bar_type minute --from 2024-01 --to 2024-06 --output_dir ./history --format csv --merge',
    '  insight download_history --symbol "NASDAQ:AAPL" --bar_type second --from 2024-06-01 --to 2024-06-14 --output_dir ./history --concurrency 5',
    '  insight download_history --symbol "CME_MINI:NQ1!" --bar_type hour --from 2025-01 --to 2025-12 --output_dir ./futures --format both',
  ].join("\n");
}

export function buildRenderChartHelp(): string {
  return [
    `insight ${RENDER_CHART_COMMAND}`,
    "",
    "Render a Chart.js chart configuration to a local PNG file.",
    "",
    "Parameters:",
    '  --config                   string   Required. Chart.js configuration JSON with "type" and "data" fields.',
    "  --width                    number [optional] Chart width in pixels, 200-2000. Default: 800.",
    "  --height                   number [optional] Chart height in pixels, 200-2000. Default: 400.",
    "",
    "Examples:",
    '  insight render_chart --config \'{"type":"line","data":{"labels":["Jan","Feb"],"datasets":[{"label":"Price","data":[100,105]}]}}\'',
    '  insight render_chart --config \'{"type":"bar","data":{"labels":["Jan"],"datasets":[{"label":"Volume","data":[1200]}]}}\' --width 1200 --height 600',
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
    const desc = formatHelpDescription(zodType);
    const typeName = formatTypeName(zodType);
    lines.push(`  --${key.padEnd(24)} ${typeName}${optional}  ${desc}`);
  }

  // filter is always available
  lines.push(
    `  --${"filter".padEnd(24)} string [optional]  JSONata expression applied to the response.`,
  );
  lines.push(
    `  --${"store".padEnd(24)} ${formatStoreTypeName(tool.name)} [optional]  ${formatStoreHelpDescription(tool.name)}`,
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

function formatStoreTypeName(toolName: string): string {
  return supportsCsvStorage(toolName) ? "enum(none|json|csv)" : "enum(none|json)";
}

function formatStoreHelpDescription(toolName: string): string {
  const suffix = supportsCsvStorage(toolName) ? " CSV writes series/history rows." : "";
  return `Store original API response before filtering.${suffix} Default: none.`;
}

function getZodDescription(t: z.ZodTypeAny): string {
  if (t.description) return t.description;
  const def = (t as any)._zod?.def ?? (t as any)._def ?? {};
  if (def.innerType) return getZodDescription(def.innerType);
  return "";
}

function formatHelpDescription(zodType: z.ZodTypeAny): string {
  const hint = getPromptHint(zodType) ?? "";
  const defaultValue = getPromptDefault(zodType);
  if (defaultValue === null) return hint;
  return hint ? `${hint} Default: ${defaultValue}.` : `Default: ${defaultValue}.`;
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
type RunCommandFn = (
  command: string,
  args: string[],
) => Promise<{ stdout?: string; stderr?: string }>;
type RenderChartFn = (
  config: ChartConfiguration,
  width?: number,
  height?: number,
) => Promise<{ base64: string; filePath: string }>;

interface CliIO {
  write: (s: string) => void;
  exit: (code: number) => void;
  request?: RequestFn;
  createRequestFromApiKey?: (apiKey: string) => RequestFn;
  runCommand?: RunCommandFn;
  getLatestVersion?: LatestVersionProvider;
  renderChart?: RenderChartFn;
  progress?: (s: string) => void;
  writeNotice?: (s: string) => void;
  prompt?: (question: string) => Promise<string>;
  selectTool?: (options: ToolSelectionOption[]) => Promise<string | null>;
  isInteractive?: boolean;
  getAuthStatus?: () => AuthStatus;
}

const REQUIRED_DOWNLOAD_HISTORY_ARGS = ["symbol", "bar_type", "from", "to", "output_dir"] as const;
type RequiredDownloadHistoryArg = (typeof REQUIRED_DOWNLOAD_HISTORY_ARGS)[number];

interface ToolSelectionOption {
  name: string;
  description: string;
}

interface InteractiveToolResolution {
  toolName: string;
  apiKey?: string;
}

export async function runCli(argv: string[], io: CliIO): Promise<void> {
  try {
    await runCliInner(argv, io);
  } catch (error) {
    if (isPromptAbortError(error)) {
      io.write("");
      io.exit(130);
      return;
    }
    throw error;
  }
}

function isPromptAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === "ABORT_ERR" || candidate.name === "AbortError";
}

async function runCliInner(argv: string[], io: CliIO): Promise<void> {
  let { toolName, args, help, version } = parseArgs(argv);
  let sessionApiKey: string | undefined;

  if (version) {
    io.write(buildVersion());
    io.exit(0);
    return;
  }

  if (!toolName) {
    if (!help && io.isInteractive === true && io.prompt) {
      const selected = await resolveInteractiveToolName(io);
      if (!selected) {
        io.exit(1);
        return;
      }
      toolName = selected.toolName;
      sessionApiKey = selected.apiKey;
    } else {
      io.write(buildHelp());
      io.exit(0);
      return;
    }
  }

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
    const validation = validateApiKeyForLogin(key);
    if (!validation.ok) {
      io.write(`Error: ${validation.error}`);
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

  if (toolName === UPDATE_COMMAND) {
    await runUpdateCommand(io);
    return;
  }

  if (toolName === VERSION_COMMAND) {
    await runVersionCommand(io);
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

    try {
      const inputArgs = { ...args };
      const interactive = io.isInteractive === true && Boolean(io.prompt);
      if (interactive) {
        for (const error of collectInvalidProvidedDownloadHistoryArgs(inputArgs)) {
          io.write(`Invalid ${downloadHistoryPromptLabel(error.key)}: ${error.error}\n`);
          delete inputArgs[error.key];
        }
      } else {
        const providedValidationError = validateDownloadHistoryArgs(inputArgs);
        if (providedValidationError) {
          io.write(
            `Invalid ${downloadHistoryPromptLabel(providedValidationError.key)}: ${providedValidationError.error}\n`,
          );
          io.exit(1);
          return;
        }
      }
      const historyArgs = await resolveDownloadHistoryArgs(inputArgs, io);
      if (!historyArgs) {
        io.write(
          `Error: Missing required options for download_history: ${missingDownloadHistoryArgs(inputArgs).join(", ")}\n\nRun: insight download_history --help`,
        );
        io.exit(1);
        return;
      }
      const validationError = validateDownloadHistoryArgs(historyArgs);
      if (validationError) {
        io.write(
          `Invalid ${downloadHistoryPromptLabel(validationError.key)}: ${validationError.error}\n`,
        );
        io.exit(1);
        return;
      }
      const request = resolveRequest(io, sessionApiKey);
      if (!request) {
        io.write(
          "Error: No API key found.\n\nSet it with:  insight login --key <your-api-key>\nOr export:    export INSIGHTSENTRY_API_KEY=your-api-key\n\nGet your API key from https://insightsentry.com/dashboard",
        );
        io.exit(1);
        return;
      }
      reportArgUsage(io, historyArgs, Object.keys(downloadHistorySchema), inputArgs);
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
      await maybeWritePostToolUpgradeNotice(io);
    } catch (error: any) {
      io.write(`Error: ${error.message}\n`);
      io.exit(1);
    }
    return;
  }

  if (toolName === RENDER_CHART_COMMAND) {
    if (help) {
      io.write(buildRenderChartHelp());
      io.exit(0);
      return;
    }

    const inputArgs = { ...args };
    const interactive = io.isInteractive === true && Boolean(io.prompt);
    if (interactive) {
      for (const error of collectInvalidRenderChartArgs(inputArgs)) {
        io.write(`Invalid ${toolPromptLabel(error.key)}: ${error.error}\n`);
        delete inputArgs[error.key];
      }
    } else {
      const providedValidationError = validateRenderChartArgs(inputArgs);
      if (providedValidationError) {
        io.write(
          `Invalid ${toolPromptLabel(providedValidationError.key)}: ${providedValidationError.error}\n`,
        );
        io.exit(1);
        return;
      }
    }

    const resolvedArgs = await resolveRenderChartArgs(inputArgs, io);
    if (!resolvedArgs) {
      io.write(
        `Error: Missing required options for ${RENDER_CHART_COMMAND}: config\n\nRun: insight ${RENDER_CHART_COMMAND} --help`,
      );
      io.exit(1);
      return;
    }

    const validationError = validateRenderChartArgs(resolvedArgs);
    if (validationError) {
      io.write(`Invalid ${toolPromptLabel(validationError.key)}: ${validationError.error}\n`);
      io.exit(1);
      return;
    }

    try {
      const { config, width, height } = parseRenderChartArgs(resolvedArgs);
      reportArgUsage(io, resolvedArgs, Object.keys(RENDER_CHART_SCHEMA), inputArgs);
      const renderer = io.renderChart ?? renderChart;
      const result = await renderer(config, width, height);
      io.write(
        JSON.stringify(
          {
            file: result.filePath,
            mime_type: "image/png",
          },
          null,
          2,
        ),
      );
      await maybeWritePostToolUpgradeNotice(io);
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

  const inputArgs = { ...args };
  const interactive = io.isInteractive === true && Boolean(io.prompt);
  if (interactive) {
    for (const error of collectInvalidProvidedToolArgs(inputArgs, tool)) {
      io.write(`Invalid ${toolPromptLabel(error.key)}: ${error.error}\n`);
      delete inputArgs[error.key];
    }
  } else {
    const providedValidationError = validateResolvedToolArgs(inputArgs, tool, {
      validateConditionalRequirements: false,
    });
    if (providedValidationError) {
      io.write(
        `Invalid ${toolPromptLabel(providedValidationError.key)}: ${providedValidationError.error}\n`,
      );
      io.exit(1);
      return;
    }
  }

  const storeModeError = validateStoreMode(tool.name, inputArgs.store);
  if (storeModeError) {
    if (interactive) {
      io.write(`Invalid Store: ${storeModeError}\n`);
      delete inputArgs.store;
    } else {
      io.write(`Invalid Store: ${storeModeError}\n`);
      io.exit(1);
      return;
    }
  }
  const filterError = validateFilterExpression(inputArgs.filter);
  if (filterError) {
    if (interactive) {
      io.write(`Invalid Filter: ${filterError}\n`);
      delete inputArgs.filter;
    } else {
      io.write(`Invalid Filter: ${filterError}\n`);
      io.exit(1);
      return;
    }
  }

  const resolvedArgs = await resolveToolArgs(inputArgs, tool, io);
  if (!resolvedArgs) {
    const missing = missingRequiredToolArgs(inputArgs, tool);
    io.write(
      `Error: Missing required options for ${tool.name}: ${missing.join(", ")}\n\nRun: insight ${tool.name} --help`,
    );
    io.exit(1);
    return;
  }

  const validationError = validateResolvedToolArgs(resolvedArgs, tool);
  if (validationError) {
    io.write(`Invalid ${toolPromptLabel(validationError.key)}: ${validationError.error}\n`);
    io.exit(1);
    return;
  }

  // Resolve request function
  const request = resolveRequest(io, sessionApiKey);
  if (!request) {
    io.write(
      "Error: No API key found.\n\nSet it with:  insight login --key <your-api-key>\nOr export:    export INSIGHTSENTRY_API_KEY=your-api-key\n\nGet your API key from https://insightsentry.com/dashboard",
    );
    io.exit(1);
    return;
  }

  try {
    const knownArgKeys = ["filter", "store", "output_file", "output_dir"];
    const initialApiArgs = pickKnownArgs(resolvedArgs, Object.keys(tool.schema), knownArgKeys);
    const apiArgs = await resolveApiPlanEntitlementArgs(initialApiArgs, tool, sessionApiKey, io);
    if (!apiArgs) {
      io.exit(1);
      return;
    }
    reportArgUsage(io, apiArgs, Object.keys(tool.schema), inputArgs, knownArgKeys);
    const outputValue = await runApiTool({
      toolName: tool.name,
      method: tool.method,
      pathTemplate: tool.pathTemplate,
      args: coerceArgs(apiArgs, tool.schema),
      request,
    });
    const output =
      typeof outputValue === "string" ? outputValue : JSON.stringify(outputValue, null, 2);
    io.write(output);
    await maybeWritePostToolUpgradeNotice(io);
  } catch (error: any) {
    io.write(`Error: ${error.message}\n`);
    io.exit(1);
  }
}

async function resolveInteractiveToolName(io: CliIO): Promise<InteractiveToolResolution | null> {
  let apiKey: string | undefined;
  const status = (io.getAuthStatus ?? getAuthStatus)();
  if (!status.authenticated) {
    io.write(status.message);
    apiKey = (await resolveLoginKey({}, io)) ?? undefined;
    if (!apiKey) {
      io.write(
        "Usage: insight login --key <your-api-key>\n\nGet your API key from https://insightsentry.com/dashboard",
      );
      return null;
    }
    saveConfig({ apiKey });
    io.write(`API key saved to ${getConfigLocation()}`);
  }

  const options = interactiveToolOptions();
  if (io.selectTool) {
    const selected = await io.selectTool(options);
    if (!selected) io.write("No tool selected.");
    return selected ? { toolName: selected, apiKey } : null;
  }

  io.write(buildInteractiveToolList(options));
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.("Choose tool (number or name): "))?.trim() ?? "";
    const selected = parseToolSelection(answer, options);
    if (selected) return { toolName: selected, apiKey };
    io.write("Invalid tool selection.");
  }

  io.write("No tool selected.");
  return null;
}

async function runUpdateCommand(io: CliIO): Promise<void> {
  const runCommand = io.runCommand ?? defaultRunCommand;
  const status = await getCachedVersionStatus(io);
  io.write(`${formatVersionStatus(status)}\n`);

  if (status.latestVersion && !status.updateAvailable) {
    io.exit(0);
    return;
  }

  if (!status.latestVersion) {
    io.write("Proceeding with update because you explicitly requested it.\n");
  }

  io.write("Updating InsightSentry CLI/MCP with: npm install -g @insightsentry/mcp\n");
  try {
    const result = await runCommand("npm", ["install", "-g", "@insightsentry/mcp"]);
    const details = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    if (details) io.write(`${details}\n`);
    io.write("InsightSentry CLI/MCP updated.");
    io.exit(0);
  } catch (error: any) {
    io.write(`Error: ${error?.message ?? String(error)}`);
    io.exit(1);
  }
}

async function runVersionCommand(io: CliIO): Promise<void> {
  const status = await getCachedVersionStatus(io);
  io.write(formatVersionStatus(status));
  io.exit(status.latestVersion ? 0 : 1);
}

async function maybeWritePostToolUpgradeNotice(io: CliIO): Promise<void> {
  if (!io.writeNotice) return;

  const status = await getCachedVersionStatus(io);
  const notice = formatUpgradeNotice(status);
  if (notice) io.writeNotice(notice);
}

async function getCachedVersionStatus(io: CliIO) {
  return getVersionStatus(PACKAGE_JSON, io.getLatestVersion ?? fetchLatestPackageVersion, {
    cachePath: getVersionCacheLocation(),
  });
}

async function defaultRunCommand(
  command: string,
  args: string[],
): Promise<{ stdout?: string; stderr?: string }> {
  return execFileAsync(command, args);
}

function interactiveToolOptions(): ToolSelectionOption[] {
  return [
    ...toolDefinitions.map((tool) => ({
      name: tool.name,
      description: summarizeToolDescription(tool.description),
    })),
    {
      name: DOWNLOAD_HISTORY_COMMAND,
      description: "Download historical ranges to JSON/CSV files",
    },
    {
      name: RENDER_CHART_COMMAND,
      description: "Render Chart.js configs as PNG images",
    },
  ];
}

function buildInteractiveToolList(options: ToolSelectionOption[]): string {
  return [
    "Choose a tool:",
    "",
    ...options.map((option, index) => `${index + 1}. ${option.name} - ${option.description}`),
    "",
    "Use arrow keys in a TTY, or type a number/name.",
  ].join("\n");
}

function summarizeToolDescription(description: string): string {
  return description.split("→")[0].split(".")[0].trim();
}

function parseToolSelection(rawSelection: string, options: ToolSelectionOption[]): string | null {
  const selection = rawSelection.trim();
  if (!selection) return null;

  const number = Number(selection);
  if (Number.isInteger(number) && number >= 1 && number <= options.length) {
    return options[number - 1].name;
  }

  const normalized = selection.toLowerCase();
  return options.find((option) => option.name.toLowerCase() === normalized)?.name ?? null;
}

async function resolveLoginKey(args: Record<string, string>, io: CliIO): Promise<string | null> {
  if (args.key?.trim()) return args.key.trim();
  if (io.isInteractive !== true || !io.prompt) return null;

  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt("API key: ")).trim();
    if (!answer) return null;

    const validation = validateApiKeyForLogin(answer);
    if (validation.ok) return answer;

    io.write(`Invalid API key: ${validation.error}\n`);
  }

  return null;
}

function resolveRequest(io: CliIO, apiKeyOverride?: string): RequestFn | null {
  if (io.request) return io.request;
  const apiKey = apiKeyOverride?.trim() || resolveApiKey();
  if (!apiKey) return null;
  if (io.createRequestFromApiKey) return io.createRequestFromApiKey(apiKey);
  const client = new ApiClient(apiKey);
  return (method, path, params) => client.request(method, path, params);
}

function reportArgUsage(
  io: CliIO,
  resolvedArgs: Record<string, string>,
  knownKeys: string[],
  originalArgs: Record<string, string>,
  extraKnownKeys: string[] = [],
): void {
  if (!io.progress) return;

  const known = new Set([...knownKeys, ...extraKnownKeys]);
  const used = Object.entries(resolvedArgs)
    .filter(([key, value]) => known.has(key) && hasArgValue(value))
    .map(([key, value]) => `${key}=${formatArgValue(value)}`);
  const disregarded = Object.entries(originalArgs)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => `--${key}=${formatArgValue(value)}`);

  io.progress(`Using args: ${used.length ? used.join(", ") : "(none)"}`);
  if (disregarded.length > 0) {
    io.progress(`Disregarding args: ${disregarded.join(", ")}`);
  }
}

function pickKnownArgs(
  args: Record<string, string>,
  knownKeys: string[],
  extraKnownKeys: string[] = [],
): Record<string, string> {
  const known = new Set([...knownKeys, ...extraKnownKeys]);
  return Object.fromEntries(Object.entries(args).filter(([key]) => known.has(key)));
}

function formatArgValue(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= 120 ? singleLine : `${singleLine.slice(0, 117)}...`;
}

async function resolveApiPlanEntitlementArgs(
  args: Record<string, string>,
  tool: ToolDefinition,
  apiKeyOverride: string | undefined,
  io: CliIO,
): Promise<Record<string, string> | null> {
  const apiKey = apiKeyOverride?.trim() || resolveApiKey();
  if (!apiKey) return args;

  const error = validateApiPlanEntitlements(
    apiKey,
    tool.pathTemplate,
    coerceArgs(args, tool.schema),
  );
  if (!error) return args;

  const label = toolPromptLabel(error.key);
  if (io.isInteractive === true && io.prompt && tool.schema[error.key]) {
    io.write(`Invalid ${label}: ${error.error}\n`);
    const answer = await promptForPlanEntitledToolArg(
      error.key,
      tool.schema[error.key],
      args,
      tool,
      apiKey,
      io,
    );
    if (answer === null) return null;
    return { ...args, [error.key]: answer };
  }

  io.write(`Invalid ${label}: ${error.error}\n`);
  return null;
}

async function promptForPlanEntitledToolArg(
  key: string,
  zodType: z.ZodTypeAny,
  resolved: Record<string, string>,
  tool: ToolDefinition,
  apiKey: string,
  io: CliIO,
): Promise<string | null> {
  const label = toolPromptLabel(key);
  const question = promptQuestion(label, zodType, "required");
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    const answerError = validateToolArgAnswer(key, zodType, answer);
    if (answerError) {
      io.write(`Invalid ${label}: ${answerError}\n`);
      continue;
    }

    const planError = validateApiPlanEntitlements(apiKey, tool.pathTemplate, {
      ...coerceArgs(resolved, tool.schema),
      ...coerceArgs({ [key]: answer }, { [key]: zodType }),
    });
    if (!planError) return answer;
    io.write(`Invalid ${label}: ${planError.error}\n`);
  }
  return null;
}

function missingToolArgs(args: Record<string, string>, tool: ToolDefinition): string[] {
  return Object.entries(tool.schema)
    .filter(([_key, zodType]) => !isOptionalZodType(zodType))
    .map(([key]) => key)
    .filter((key) => !args[key]);
}

function missingRequiredToolArgs(args: Record<string, string>, tool: ToolDefinition): string[] {
  return [...missingToolArgs(args, tool), ...missingConditionalToolArgs(tool.name, args)];
}

async function resolveToolArgs(
  args: Record<string, string>,
  tool: ToolDefinition,
  io: CliIO,
): Promise<Record<string, string> | null> {
  const resolved = { ...args };
  if (io.isInteractive === true && io.prompt) {
    for (const [key, zodType] of Object.entries(tool.schema)) {
      if (resolved[key] !== undefined) continue;
      if (isOptionalZodType(zodType) && !shouldPromptSymbolScopedParam(key, resolved)) continue;
      if (isOptionalZodType(zodType)) {
        if (shouldSkipInteractiveToolArg(tool.name, key, resolved)) continue;
        const answer = isInteractiveToolArgRequired(tool.name, key, resolved)
          ? await promptForToolArg(key, zodType, io)
          : await promptForOptionalToolArg(key, zodType, io);
        if (answer === null) return null;
        if (answer !== undefined) resolved[key] = answer;
      } else {
        const answer = await promptForToolArg(key, zodType, io);
        if (!answer) return null;
        resolved[key] = answer;
      }
    }
    const storageAnswer = await resolveInteractiveStorageMode(resolved, tool.name, io);
    if (storageAnswer === null) return null;
    await resolveStorageDestination(resolved, tool.name, io);
    const filterAnswer = await resolveInteractiveFilter(resolved, io);
    if (filterAnswer === null) return null;
  } else if (missingToolArgs(resolved, tool).length > 0) {
    return null;
  }

  if (missingToolArgs(resolved, tool).length > 0) return null;

  return resolved;
}

async function resolveInteractiveStorageMode(
  resolved: Record<string, string>,
  toolName: string,
  io: CliIO,
): Promise<undefined | null> {
  if (resolved.store !== undefined) return;

  const answer = await promptForOptionalToolArg("store", storeModeSchema(toolName), io);
  if (answer === null) return null;
  if (answer !== undefined) resolved.store = answer;
}

function storeModeSchema(toolName: string): z.ZodTypeAny {
  return supportsCsvStorage(toolName) ? CSV_STORE_SCHEMA : JSON_STORE_SCHEMA;
}

async function resolveInteractiveFilter(
  resolved: Record<string, string>,
  io: CliIO,
): Promise<undefined | null> {
  if (resolved.filter !== undefined) return;

  const answer = await promptForOptionalFilterArg(io);
  if (answer === null) return null;
  if (answer !== undefined) resolved.filter = answer;
}

async function promptForOptionalFilterArg(io: CliIO): Promise<string | undefined | null> {
  const label = "Filter";
  const question = optionalPromptQuestion(label, FILTER_SCHEMA);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    if (!answer) return undefined;

    const error = validateFilterExpression(answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

function shouldSkipInteractiveToolArg(
  toolName: string,
  key: string,
  args: Record<string, string>,
): boolean {
  if (toolName === "screen_crypto" && key === "countries") return true;

  if (toolName === "get_options_expiration") {
    if (key === "expiration") return hasArgValue(args.from) || hasArgValue(args.to);
    if (key === "from" || key === "to") return hasArgValue(args.expiration);
  }

  if (toolName === "get_options_strike") {
    if (key === "strike") return hasArgValue(args.range);
    if (key === "range") return hasArgValue(args.strike);
  }

  return false;
}

function isInteractiveToolArgRequired(
  toolName: string,
  key: string,
  args: Record<string, string>,
): boolean {
  if (toolName === "get_options_expiration") {
    return (key === "from" || key === "to") && !hasArgValue(args.expiration);
  }

  if (toolName === "get_options_strike") {
    return key === "range" && !hasArgValue(args.strike);
  }

  return false;
}

async function resolveStorageDestination(
  resolved: Record<string, string>,
  toolName: string,
  io: CliIO,
): Promise<void> {
  if (!isStoreEnabled(resolved.store)) return;

  if (!resolved.output_file) {
    const answer = await promptForOptionalStorageDestinationArg(
      "output_file",
      STORAGE_DESTINATION_SCHEMA.output_file,
      resolved,
      toolName,
      io,
    );
    if (answer !== null && answer !== undefined) resolved.output_file = answer;
  }

  if (!resolved.output_file && !resolved.output_dir) {
    const answer = await promptForStorageDestinationArg(
      "output_dir",
      STORAGE_DESTINATION_SCHEMA.output_dir,
      resolved,
      toolName,
      io,
    );
    if (answer !== null) resolved.output_dir = answer;
  }
}

async function promptForStorageDestinationArg(
  key: "output_file" | "output_dir",
  zodType: z.ZodTypeAny,
  resolved: Record<string, string>,
  toolName: string,
  io: CliIO,
): Promise<string | null> {
  const label = toolPromptLabel(key);
  const question = promptQuestion(label, zodType, "required");
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    const error = validateToolArgAnswer(key, zodType, answer);
    if (error) {
      io.write(`Invalid ${label}: ${error}\n`);
      continue;
    }

    const storageError = await validateStorageDestinationAnswer(key, resolved, toolName, answer);
    if (!storageError) return answer;
    io.write(`Invalid ${label}: ${storageError}\n`);
  }
  return null;
}

async function promptForOptionalStorageDestinationArg(
  key: "output_file" | "output_dir",
  zodType: z.ZodTypeAny,
  resolved: Record<string, string>,
  toolName: string,
  io: CliIO,
): Promise<string | undefined | null> {
  const label = toolPromptLabel(key);
  const question = optionalPromptQuestion(label, zodType);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    if (!answer) return undefined;

    const error = validateToolArgAnswer(key, zodType, answer);
    if (error) {
      io.write(`Invalid ${label}: ${error}\n`);
      continue;
    }

    const storageError = await validateStorageDestinationAnswer(key, resolved, toolName, answer);
    if (!storageError) return answer;
    io.write(`Invalid ${label}: ${storageError}\n`);
  }
  return null;
}

async function validateStorageDestinationAnswer(
  key: "output_file" | "output_dir",
  resolved: Record<string, string>,
  toolName: string,
  answer: string,
): Promise<string | null> {
  try {
    await validateResponseStorageTarget({
      toolName,
      store: resolved.store as ResponseStoreFormat | undefined,
      output_file: key === "output_file" ? answer : undefined,
      output_dir: key === "output_dir" ? answer : undefined,
    });
    return null;
  } catch (error: any) {
    return error?.message ?? String(error);
  }
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
  if (io.isInteractive !== true || !io.prompt) {
    return missingDownloadHistoryArgs(args).length === 0 ? args : null;
  }

  const resolved = { ...args };
  for (const [key, zodType] of Object.entries(downloadHistorySchema)) {
    if (resolved[key] !== undefined) continue;
    if (REQUIRED_DOWNLOAD_HISTORY_ARGS.includes(key as RequiredDownloadHistoryArg)) {
      const answer = await promptForDownloadHistoryArg(
        key as RequiredDownloadHistoryArg,
        resolved,
        io,
      );
      if (!answer) return null;
      resolved[key] = answer;
    } else {
      if (!shouldPromptDownloadHistoryParam(key, resolved)) continue;
      if (!shouldPromptSymbolScopedParam(key, resolved)) continue;
      const answer = await promptForOptionalDownloadHistoryArg(key, zodType, io);
      if (answer === null) return null;
      if (answer !== undefined) resolved[key] = answer;
    }
  }

  return missingDownloadHistoryArgs(resolved).length === 0 ? resolved : null;
}

function shouldPromptDownloadHistoryParam(
  key: string,
  args: Record<string, string | undefined>,
): boolean {
  if (key === "contract_lookback_months") {
    const { hasSymbol, hasContinuous } = analyzeSymbolCodes(args.symbol ?? "");
    return !hasSymbol || hasContinuous;
  }

  if (key !== "merge" && key !== "keep_chunks") return true;
  const format = args.format ?? "csv";
  const writesCsv = format === "csv" || format === "both";
  if (!writesCsv) return false;
  if (key === "keep_chunks" && args.merge?.toLowerCase() === "false") return false;
  return true;
}

async function promptForToolArg(
  key: string,
  zodType: z.ZodTypeAny,
  io: CliIO,
): Promise<string | null> {
  const label = toolPromptLabel(key);
  const question = promptQuestion(label, zodType, "required");
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    const error = validateToolArgAnswer(key, zodType, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

async function promptForOptionalToolArg(
  key: string,
  zodType: z.ZodTypeAny,
  io: CliIO,
): Promise<string | undefined | null> {
  const label = toolPromptLabel(key);
  const question = optionalPromptQuestion(label, zodType);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    if (!answer) return undefined;
    const error = validateToolArgAnswer(key, zodType, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

function validateToolArgAnswer(key: string, zodType: z.ZodTypeAny, answer: string): string | null {
  if (!answer) return "value is required";

  const symbolError = validateSymbolLikeArg(key, answer);
  if (symbolError) return symbolError;

  const coerced = coerceArgs({ [key]: answer }, { [key]: zodType })[key];
  const parsed = zodType.safeParse(coerced);
  if (parsed.success) return null;

  const enumValues = getZodEnumValues(zodType);
  if (enumValues.length > 0) return `expected one of: ${enumValues.join(", ")}`;
  return parsed.error.issues.map((issue) => issue.message).join("; ");
}

function validateResolvedToolArgs(
  args: Record<string, string>,
  tool: ToolDefinition,
  options: { validateConditionalRequirements?: boolean } = {},
): { key: string; error: string } | null {
  for (const [key, zodType] of Object.entries(tool.schema)) {
    if (args[key] === undefined) continue;
    const error = validateToolArgAnswer(key, zodType, args[key]);
    if (error) return { key, error };
  }
  if (options.validateConditionalRequirements !== false) {
    const conditionalError = validateConditionalToolArgs(tool.name, args);
    if (conditionalError) return conditionalError;
  }
  const historyIntervalError = validateHistoryIntervalArgs(tool.name, args);
  if (historyIntervalError) return historyIntervalError;
  return null;
}

function collectInvalidProvidedToolArgs(
  args: Record<string, string>,
  tool: ToolDefinition,
): Array<{ key: string; error: string }> {
  const errors: Array<{ key: string; error: string }> = [];
  for (const [key, zodType] of Object.entries(tool.schema)) {
    if (args[key] === undefined) continue;
    const error = validateToolArgAnswer(key, zodType, args[key]);
    if (error) errors.push({ key, error });
  }

  if (!errors.some((error) => error.key === "bar_interval")) {
    const historyIntervalError = validateHistoryIntervalArgs(tool.name, args);
    if (historyIntervalError) errors.push(historyIntervalError);
  }

  return errors;
}

function validateConditionalToolArgs(
  toolName: string,
  args: Record<string, string>,
): { key: string; error: string } | null {
  const missing = missingConditionalToolArgs(toolName, args);
  if (missing.length === 0) return null;
  const key = toolName === "get_options_strike" ? "strike" : "expiration";
  return { key, error: `provide ${missing.join(", ")}` };
}

function missingConditionalToolArgs(toolName: string, args: Record<string, string>): string[] {
  if (toolName === "get_options_expiration") {
    const hasExpiration = hasArgValue(args.expiration);
    if (hasExpiration) return [];
    const missing = [];
    if (!hasArgValue(args.from)) missing.push("from");
    if (!hasArgValue(args.to)) missing.push("to");
    return missing.length === 2 ? ["expiration or from/to"] : missing;
  }

  if (toolName === "get_options_strike" && !hasArgValue(args.strike) && !hasArgValue(args.range)) {
    return ["strike or range"];
  }

  return [];
}

function hasArgValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function validateStoreMode(toolName: string, store: string | undefined): string | null {
  if (store === undefined) return null;
  if (!["none", "json", "csv"].includes(store)) return "store must be none, json, or csv";
  if (store === "csv" && !supportsCsvStorage(toolName)) {
    return "csv storage is only supported for get_symbol_series and get_symbol_history";
  }
  return null;
}

async function resolveRenderChartArgs(
  args: Record<string, string>,
  io: CliIO,
): Promise<Record<string, string> | null> {
  if (io.isInteractive !== true || !io.prompt) {
    return hasArgValue(args.config) ? args : null;
  }

  const resolved = { ...args };
  for (const [key, zodType] of Object.entries(RENDER_CHART_SCHEMA)) {
    if (resolved[key] !== undefined) continue;
    if (key === "config") {
      const answer = await promptForRenderChartArg(key, zodType, io);
      if (!answer) return null;
      resolved[key] = answer;
    } else {
      const answer = await promptForOptionalRenderChartArg(key, zodType, io);
      if (answer === null) return null;
      if (answer !== undefined) resolved[key] = answer;
    }
  }

  return hasArgValue(resolved.config) ? resolved : null;
}

async function promptForRenderChartArg(
  key: string,
  zodType: z.ZodTypeAny,
  io: CliIO,
): Promise<string | null> {
  const label = toolPromptLabel(key);
  const question = promptQuestion(label, zodType, "required");
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    const error = validateRenderChartArgAnswer(key, zodType, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

async function promptForOptionalRenderChartArg(
  key: string,
  zodType: z.ZodTypeAny,
  io: CliIO,
): Promise<string | undefined | null> {
  const label = toolPromptLabel(key);
  const question = optionalPromptQuestion(label, zodType);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    if (!answer) return undefined;
    const error = validateRenderChartArgAnswer(key, zodType, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

function validateRenderChartArgs(
  args: Record<string, string>,
): { key: string; error: string } | null {
  for (const [key, zodType] of Object.entries(RENDER_CHART_SCHEMA)) {
    if (args[key] === undefined) continue;
    const error = validateRenderChartArgAnswer(key, zodType, args[key]);
    if (error) return { key, error };
  }
  return null;
}

function collectInvalidRenderChartArgs(
  args: Record<string, string>,
): Array<{ key: string; error: string }> {
  const errors: Array<{ key: string; error: string }> = [];
  for (const [key, zodType] of Object.entries(RENDER_CHART_SCHEMA)) {
    if (args[key] === undefined) continue;
    const error = validateRenderChartArgAnswer(key, zodType, args[key]);
    if (error) errors.push({ key, error });
  }
  return errors;
}

function validateRenderChartArgAnswer(
  key: string,
  zodType: z.ZodTypeAny,
  answer: string,
): string | null {
  if (!answer) return "value is required";

  const coerced = coerceArgs({ [key]: answer }, { [key]: zodType })[key];
  const parsed = zodType.safeParse(coerced);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => issue.message).join("; ");
  }

  if (key !== "config") return null;
  try {
    const config = JSON.parse(answer);
    if (!config || typeof config !== "object" || !config.type || !config.data) {
      return 'Chart config must include "type" and "data" fields';
    }
    return null;
  } catch (error: any) {
    return `config must be valid JSON: ${error?.message ?? String(error)}`;
  }
}

function parseRenderChartArgs(args: Record<string, string>): {
  config: ChartConfiguration;
  width?: number;
  height?: number;
} {
  const coerced = coerceArgs(args, RENDER_CHART_SCHEMA);
  return {
    config: JSON.parse(coerced.config) as ChartConfiguration,
    width: coerced.width,
    height: coerced.height,
  };
}

async function promptForDownloadHistoryArg(
  key: RequiredDownloadHistoryArg,
  resolved: Record<string, string>,
  io: CliIO,
): Promise<string | null> {
  const label = downloadHistoryPromptLabel(key);
  const defaultAnswer = getDownloadHistoryPromptDefault(key, resolved);
  const question = defaultAnswer
    ? promptQuestion(label, downloadHistorySchema[key], "required", {
        blankInstruction: "press Enter to use default",
        value: defaultAnswer,
      })
    : promptQuestion(label, downloadHistorySchema[key], "required");
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const rawAnswer = (await io.prompt?.(question))?.trim() ?? "";
    const answer = rawAnswer || defaultAnswer || "";
    const error = validateDownloadHistoryArgAnswer(key, answer);
    if (error) {
      io.write(`Invalid ${label}: ${error}\n`);
      continue;
    }

    const storageError = await validateDownloadHistoryStorageAnswer(key, answer);
    if (!storageError) return answer;
    io.write(`Invalid ${label}: ${storageError}\n`);
  }
  return null;
}

function getDownloadHistoryPromptDefault(
  key: RequiredDownloadHistoryArg,
  resolved: Record<string, string>,
): string | null {
  if (key !== "to") return null;
  return resolved.bar_type === "second" ? currentUtcDay() : currentUtcMonth();
}

function currentUtcDay(date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function currentUtcMonth(date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

async function validateDownloadHistoryStorageAnswer(
  key: RequiredDownloadHistoryArg,
  answer: string,
): Promise<string | null> {
  if (key !== "output_dir") return null;
  try {
    await validateOutputDirectory(answer);
    return null;
  } catch (error: any) {
    return error?.message ?? String(error);
  }
}

function validateDownloadHistoryArgAnswer(key: string, answer: string): string | null {
  if (!answer) return "value is required";

  const symbolError = validateSymbolLikeArg(key, answer);
  if (symbolError) return symbolError;

  const zodType = downloadHistorySchema[key];
  if (!zodType) return null;
  const coerced = coerceArgs({ [key]: answer }, { [key]: zodType })[key];
  const parsed = zodType.safeParse(coerced);
  if (parsed.success) return null;

  const enumValues = getZodEnumValues(zodType);
  if (enumValues.length > 0) return `expected one of: ${enumValues.join(", ")}`;
  return parsed.error.issues.map((issue) => issue.message).join("; ");
}

async function promptForOptionalDownloadHistoryArg(
  key: string,
  zodType: z.ZodTypeAny,
  io: CliIO,
): Promise<string | undefined | null> {
  const label = downloadHistoryPromptLabel(key);
  const question = optionalPromptQuestion(label, zodType);
  for (let attempt = 0; attempt < MAX_INTERACTIVE_PROMPT_ATTEMPTS; attempt++) {
    const answer = (await io.prompt?.(question))?.trim() ?? "";
    if (!answer) return undefined;
    const error = validateDownloadHistoryArgAnswer(key, answer);
    if (!error) return answer;
    io.write(`Invalid ${label}: ${error}\n`);
  }
  return null;
}

function validateDownloadHistoryArgs(
  args: Record<string, string>,
): { key: string; error: string } | null {
  for (const key of Object.keys(downloadHistorySchema)) {
    if (args[key] === undefined) continue;
    const error = validateDownloadHistoryArgAnswer(key, args[key]);
    if (error) return { key, error };
  }
  const historyIntervalError = validateHistoryIntervalArgs(DOWNLOAD_HISTORY_COMMAND, args);
  if (historyIntervalError) return historyIntervalError;
  return null;
}

function collectInvalidProvidedDownloadHistoryArgs(
  args: Record<string, string>,
): Array<{ key: string; error: string }> {
  const errors: Array<{ key: string; error: string }> = [];
  for (const key of Object.keys(downloadHistorySchema)) {
    if (args[key] === undefined) continue;
    const error = validateDownloadHistoryArgAnswer(key, args[key]);
    if (error) errors.push({ key, error });
  }

  if (!errors.some((error) => error.key === "bar_interval")) {
    const historyIntervalError = validateHistoryIntervalArgs(DOWNLOAD_HISTORY_COMMAND, args);
    if (historyIntervalError) errors.push(historyIntervalError);
  }

  return errors;
}

function downloadHistoryPromptLabel(key: string): string {
  switch (key) {
    case "symbol":
      return "Symbol";
    case "bar_type":
      return "Bar type";
    case "from":
      return "From";
    case "to":
      return "To";
    case "output_dir":
      return "Output directory";
    case "format":
      return "Format";
    case "keep_chunks":
      return "Keep chunks";
    case "contract_lookback_months":
      return "Contract lookback months";
    case "bar_interval":
      return "Bar interval";
    case "split":
      return "Split";
    default:
      return toolPromptLabel(key);
  }
}

function parseDownloadHistoryArgs(args: Record<string, string>): DownloadHistoryOptions {
  const coerced = coerceArgs(args, downloadHistorySchema);
  const options: DownloadHistoryOptions = {
    symbol: coerced.symbol,
    from: coerced.from,
    to: coerced.to,
    bar_type: coerced.bar_type as DownloadHistoryOptions["bar_type"],
    output_dir: coerced.output_dir,
  };

  for (const key of ["bar_interval", "concurrency", "contract_lookback_months"] as const) {
    if (coerced[key] !== undefined) options[key] = coerced[key];
  }
  for (const key of [
    "overwrite",
    "merge",
    "keep_chunks",
    "extended",
    "dadj",
    "badj",
    "split",
    "settlement",
  ] as const) {
    if (coerced[key] !== undefined) options[key] = coerced[key];
  }
  if (coerced.format !== undefined) {
    options.format = coerced.format as DownloadHistoryOptions["format"];
  }

  return options;
}

function optionalPromptQuestion(label: string, zodType: z.ZodTypeAny): string {
  return promptQuestion(label, zodType, "optional");
}

function promptQuestion(
  label: string,
  zodType: z.ZodTypeAny,
  requirement: "required" | "optional",
  defaultOverride?: { value: string; blankInstruction: string },
): string {
  const parts: string[] = [requirement];
  const enumValues = getZodEnumValues(zodType);
  if (enumValues.length > 0) parts.push(`choices: ${enumValues.join("/")}`);
  if (enumValues.length === 0) {
    const typeName = formatTypeName(zodType);
    if (typeName && typeName !== "string") parts.push(`type: ${typeName}`);
  }

  const defaultValue = defaultOverride?.value ?? getPromptDefault(zodType);
  if (defaultValue !== null) parts.push(`Default: ${defaultValue}`);

  const hint = getPromptHint(zodType);
  if (defaultOverride) {
    parts.push(defaultOverride.blankInstruction);
  } else if (requirement !== "required") {
    parts.push("press Enter to skip");
  }

  const description = hint ? `${label}: ${hint}\n` : "";
  return `${description}${label} (${parts.join(", ")}): `;
}

function getPromptDefault(zodType: z.ZodTypeAny): string | null {
  const zodDefault = getZodDefaultValue(zodType);
  if (zodDefault !== undefined) return String(zodDefault);

  const descriptionDefault = extractDefaultFromDescription(getZodDescription(zodType));
  return descriptionDefault ? descriptionDefault : null;
}

function getZodDefaultValue(t: z.ZodTypeAny): unknown {
  const def = (t as any)._zod?.def ?? (t as any)._def ?? {};
  const type = def.type ?? def.typeName ?? "";
  if (type === "default") {
    return typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
  }
  if ((type === "optional" || type === "default") && def.innerType) {
    return getZodDefaultValue(def.innerType);
  }
  return undefined;
}

function extractDefaultFromDescription(description: string): string | null {
  const match = description.match(/Default(?:\s+is|\s+to|:)\s+['"`]?([^.'"`]+)['"`]?/i);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function getPromptHint(zodType: z.ZodTypeAny): string | null {
  const description = getZodDescription(zodType);
  if (!description) return null;

  const hint = description
    .replace(/^\((?:Optional|Required)(?:\s+if[^)]*)?\)\s*/i, "")
    .replace(/\s*Default(?:\s+is|\s+to|:)\s+['"`]?[^.]+['"`]?\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!hint) return null;
  return hint;
}

function canUseKeyboardToolSelection(): boolean {
  return (
    input.isTTY === true &&
    output.isTTY === true &&
    typeof input.setRawMode === "function" &&
    process.env.CI !== "true"
  );
}

function selectToolWithKeyboard(options: ToolSelectionOption[]): Promise<string | null> {
  return new Promise((resolve) => {
    let selectedIndex = 0;
    let typed = "";
    let error = "";
    let closed = false;
    const wasRaw = input.isRaw;

    const render = () => {
      output.write("\x1B[2J\x1B[H\x1B[?25l");
      output.write("Choose a tool:\n\n");
      for (const [index, option] of options.entries()) {
        const marker = index === selectedIndex ? ">" : " ";
        output.write(`${marker} ${index + 1}. ${option.name} - ${option.description}\n`);
      }
      output.write("\nUse Up/Down, Enter, or type a number/name.");
      output.write(`\nChoose tool: ${typed}`);
      if (error) output.write(`\n${error}`);
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      output.write("\x1B[?25h\n");
    };

    const finish = (toolName: string | null) => {
      cleanup();
      resolve(toolName);
    };

    const updateSelectedFromTyped = () => {
      const selected = parseToolSelection(typed, options);
      if (!selected) return;
      selectedIndex = options.findIndex((option) => option.name === selected);
    };

    const onKeypress = (
      value: string,
      key: { ctrl?: boolean; name?: string; sequence?: string },
    ) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }
      if (key.name === "escape") {
        finish(null);
        return;
      }
      if (key.name === "up") {
        selectedIndex = selectedIndex === 0 ? options.length - 1 : selectedIndex - 1;
        typed = "";
        error = "";
        render();
        return;
      }
      if (key.name === "down") {
        selectedIndex = selectedIndex === options.length - 1 ? 0 : selectedIndex + 1;
        typed = "";
        error = "";
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const selected = typed.trim()
          ? parseToolSelection(typed, options)
          : options[selectedIndex].name;
        if (selected) {
          finish(selected);
          return;
        }
        error = "Invalid tool selection.";
        render();
        return;
      }
      if (key.name === "backspace") {
        typed = typed.slice(0, -1);
        error = "";
        updateSelectedFromTyped();
        render();
        return;
      }
      if (value && value >= " " && !key.ctrl && key.sequence !== "\x7F") {
        typed += value;
        error = "";
        updateSelectedFromTyped();
        render();
      }
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

export function main() {
  const rl = createInterface({ input, output });
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== "true";
  runCli(process.argv.slice(2), {
    write: (s) => process.stdout.write(`${s}\n`),
    progress: (s) => process.stderr.write(`${s}\n`),
    writeNotice: (s) => process.stderr.write(`${s}\n`),
    prompt: (question) => rl.question(question),
    selectTool: canUseKeyboardToolSelection() ? selectToolWithKeyboard : undefined,
    isInteractive: interactive,
    exit: (code) => process.exit(code),
  }).finally(() => rl.close());
}
