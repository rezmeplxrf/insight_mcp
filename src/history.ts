import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type HistoryBarType = "second" | "minute" | "hour" | "day" | "week" | "month";
export type HistoryOutputFormat = "json" | "csv" | "both";
export type RequestFn = (
  method: string,
  pathTemplate: string,
  params: Record<string, any>,
) => Promise<any>;

export interface DownloadHistoryOptions {
  symbol: string;
  from: string;
  to: string;
  bar_type: HistoryBarType;
  output_dir: string;
  bar_interval?: number;
  format?: HistoryOutputFormat;
  merge?: boolean;
  keep_chunks?: boolean;
  concurrency?: number;
  contract_lookback_months?: number;
  overwrite?: boolean;
  extended?: boolean;
  dadj?: boolean;
  badj?: boolean;
  settlement?: boolean;
}

export interface HistoryProgressEvent {
  completed: number;
  total: number;
  status: "saved" | "skipped" | "failed";
  symbol: string;
  start_date: string;
  files: string[];
  error?: string;
}

export interface DownloadHistoryDeps {
  request: RequestFn;
  onProgress?: (event: HistoryProgressEvent) => void;
}

export interface PlannedHistoryRequest {
  method: "history" | "series";
  params: Record<string, any>;
  outputBasePath: string;
}

export interface HistoryPlan {
  mode: "regular" | "futures";
  requests: PlannedHistoryRequest[];
}

export interface DownloadHistoryResult {
  mode: "regular" | "futures";
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  concurrency: number;
  output_dir: string;
  files: string[];
  merged_file?: string;
  errors: Array<{ symbol: string; start_date: string; message: string }>;
}

interface MonthValue {
  year: number;
  month: number;
}

interface DayValue extends MonthValue {
  day: number;
}

const HISTORY_PATH = "/v3/symbols/{symbol}/history";
const SERIES_PATH = "/v3/symbols/{symbol}/series";
const CONTRACTS_PATH = "/v3/symbols/{symbol}/contracts";
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;
const DEFAULT_CONTRACT_LOOKBACK_MONTHS = 6;
const HISTORY_BAR_TYPES = ["second", "minute", "hour"] as const;
const SERIES_BAR_TYPES = ["day", "week", "month"] as const;

export async function planHistoryRequests(
  options: DownloadHistoryOptions,
  deps: Pick<DownloadHistoryDeps, "request">,
): Promise<HistoryPlan> {
  validateOptions(options);
  if (isContinuousFrontMonth(options.symbol) && isArchiveBarType(options.bar_type)) {
    return planFuturesHistoryRequests(options, deps.request);
  }
  return {
    mode: "regular",
    requests: planRequestsForSymbol(options, options.symbol),
  };
}

export async function downloadHistory(
  options: DownloadHistoryOptions,
  deps: DownloadHistoryDeps,
): Promise<DownloadHistoryResult> {
  const format = options.format ?? "csv";
  const concurrency = normalizeConcurrency(options.concurrency);
  const shouldMergeCsv = options.merge ?? true;
  const plan = await planHistoryRequests(options, deps);
  const mergeTargetFiles = new Set<string>();
  const createdCsvFiles = new Set<string>();
  const result: DownloadHistoryResult = {
    mode: plan.mode,
    total: plan.requests.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    concurrency,
    output_dir: path.resolve(options.output_dir),
    files: [],
    errors: [],
  };

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < plan.requests.length) {
      const request = plan.requests[nextIndex];
      nextIndex += 1;
      const savedFiles: string[] = [];
      const startDate = String(request.params.start_date ?? `${options.from}_${options.to}`);
      const symbol = String(request.params.symbol);

      try {
        const targetFiles = outputFilesForFormat(request.outputBasePath, format);
        if (!options.overwrite && (await allFilesExist(targetFiles))) {
          for (const filePath of targetFiles.filter((target) => target.endsWith(".csv"))) {
            mergeTargetFiles.add(filePath);
          }
          result.skipped += 1;
          result.completed += 1;
          deps.onProgress?.({
            completed: result.completed,
            total: result.total,
            status: "skipped",
            symbol,
            start_date: startDate,
            files: targetFiles,
          });
          continue;
        }

        const response = filterResponseForRequest(
          await deps.request(
            "GET",
            request.method === "series" ? SERIES_PATH : HISTORY_PATH,
            request.params,
          ),
          options,
          request,
        );
        const message = response?.message ?? response?.error;
        if (message && !Array.isArray(response?.series)) {
          result.skipped += 1;
          result.completed += 1;
          deps.onProgress?.({
            completed: result.completed,
            total: result.total,
            status: "skipped",
            symbol,
            start_date: startDate,
            files: [],
            error: String(message),
          });
          continue;
        }

        for (const filePath of targetFiles) {
          await mkdir(path.dirname(filePath), { recursive: true });
          if (filePath.endsWith(".csv")) {
            await writeFile(filePath, responseToCsv(response), "utf8");
          } else {
            await writeFile(filePath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
          }
          savedFiles.push(filePath);
          result.files.push(filePath);
          if (filePath.endsWith(".csv")) {
            mergeTargetFiles.add(filePath);
            createdCsvFiles.add(filePath);
          }
        }

        result.completed += 1;
        deps.onProgress?.({
          completed: result.completed,
          total: result.total,
          status: "saved",
          symbol,
          start_date: startDate,
          files: savedFiles,
        });
      } catch (error: any) {
        const message = error?.message ?? String(error);
        result.failed += 1;
        result.completed += 1;
        result.errors.push({ symbol, start_date: startDate, message });
        deps.onProgress?.({
          completed: result.completed,
          total: result.total,
          status: "failed",
          symbol,
          start_date: startDate,
          files: savedFiles,
          error: message,
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, plan.requests.length) }, () => worker()),
  );

  if (shouldMergeCsv && (format === "csv" || format === "both")) {
    const orderedCsvFiles = plan.requests
      .flatMap((request) => outputFilesForFormat(request.outputBasePath, format))
      .filter((filePath) => filePath.endsWith(".csv") && mergeTargetFiles.has(filePath));
    if (orderedCsvFiles.length > 0) {
      const mergedFile = mergedCsvPath(options);
      await mergeCsvFiles(orderedCsvFiles, mergedFile);
      result.merged_file = mergedFile;
      result.files.push(mergedFile);
      if (!options.keep_chunks) {
        const removableCsvFiles = orderedCsvFiles.filter((filePath) => createdCsvFiles.has(filePath));
        await removeChunkFiles(removableCsvFiles);
        result.files = result.files.filter((filePath) => !removableCsvFiles.includes(filePath));
      }
    }
  }

  return result;
}

export function responseToCsv(response: any): string {
  const series = Array.isArray(response?.series) ? response.series : [];
  if (series.length === 0) return "";
  const metadataHeaders = response?.code && response?.bar_type ? ["code", "bar_type"] : [];
  const metadataValues = metadataHeaders.map((key) => response[key]);

  if (Array.isArray(response?.series_keys) && Array.isArray(series[0])) {
    const headers = [...metadataHeaders, ...response.series_keys.map(String)];
    const rows = series.map((row: any[]) => [...metadataValues, ...row]);
    return serializeCsvRows(headers, rows);
  }

  const preferred = ["code", "bar_type", "time", "open", "high", "low", "close", "volume", "type"];
  const keys = new Set<string>();
  for (const row of series) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const key of Object.keys(row)) keys.add(key);
    }
  }
  for (const key of metadataHeaders) keys.add(key);
  const headers = [
    ...preferred.filter((key) => keys.delete(key)),
    ...Array.from(keys).sort(),
  ];
  const rows = series.map((row: Record<string, any>) =>
    headers.map((key) => (key in row ? row[key] : response?.[key])),
  );
  return serializeCsvRows(headers, rows);
}

function planRequestsForSymbol(
  options: DownloadHistoryOptions,
  symbol: string,
  outputSymbol = symbol,
): PlannedHistoryRequest[] {
  if (isSeriesBarType(options.bar_type)) {
    const rangeStart = parseDay(options.from, "start");
    const rangeEnd = parseDay(options.to, "end");
    if (compareDays(rangeStart, rangeEnd) > 0) throw new Error("from must be before or equal to to");
    const rangeLabel = `${formatDay(rangeStart)}_${formatDay(rangeEnd)}`;
    return [
      {
        method: "series",
        params: {
          symbol,
          bar_type: options.bar_type,
          dp: 30000,
          ...optionalSeriesParams(options),
        },
        outputBasePath: path.join(
          path.resolve(options.output_dir),
          sanitizePathPart(outputSymbol),
          timeframeLabel(options.bar_type, options.bar_interval),
          rangeLabel,
        ),
      },
    ];
  }

  const startDates = iterStartDates(options.from, options.to, options.bar_type);
  return startDates.map((startDate) => ({
    method: "history",
    params: {
      symbol,
      bar_type: options.bar_type,
      start_date: startDate,
      ...optionalHistoryParams(options),
    },
    outputBasePath: path.join(
      path.resolve(options.output_dir),
      sanitizePathPart(outputSymbol),
      timeframeLabel(options.bar_type, options.bar_interval),
      startDate,
    ),
  }));
}

async function planFuturesHistoryRequests(
  options: DownloadHistoryOptions,
  request: RequestFn,
): Promise<HistoryPlan> {
  const schedule = await fetchContractSchedule(options.symbol, request);
  const range = monthRangeFor(options.from, options.to);
  const lookback = options.contract_lookback_months ?? DEFAULT_CONTRACT_LOOKBACK_MONTHS;
  const requests: PlannedHistoryRequest[] = [];

  for (let year = range.start.year; year <= range.end.year + 1; year += 1) {
    for (const monthCode of schedule.monthCodes) {
      const settlementMonth = schedule.settlementMonths.get(monthCode);
      if (!settlementMonth) continue;

      const settlement = { year, month: settlementMonth };
      const coverageStart = addMonths(settlement, -lookback + 1);
      for (const month of iterMonths(coverageStart, settlement)) {
        if (compareMonths(month, range.start) < 0 || compareMonths(month, range.end) > 0) {
          continue;
        }

        const symbol = `${schedule.fullBaseCode}${monthCode}${year}`;
        const startDate = formatMonth(month);
        for (const archiveDate of expandArchiveStartDates(startDate, options.bar_type)) {
          requests.push({
            method: "history",
            params: {
              symbol,
              bar_type: options.bar_type,
              start_date: archiveDate,
              ...optionalHistoryParams(options),
            },
            outputBasePath: path.join(
              path.resolve(options.output_dir),
              sanitizePathPart(schedule.fullBaseCode),
              sanitizePathPart(symbol),
              timeframeLabel(options.bar_type, options.bar_interval),
              archiveDate,
            ),
          });
        }
      }
    }
  }

  return { mode: "futures", requests };
}

async function fetchContractSchedule(symbol: string, request: RequestFn): Promise<{
  fullBaseCode: string;
  monthCodes: string[];
  settlementMonths: Map<string, number>;
}> {
  const response = await request("GET", CONTRACTS_PATH, { symbol });
  const inferredBase = continuousToBaseSymbol(symbol);
  const rawBase = String(response?.base_code || inferredBase);
  const fullBaseCode = rawBase.includes(":")
    ? rawBase
    : `${symbol.split(":", 1)[0]}:${rawBase}`;
  const rootBase = fullBaseCode.includes(":") ? fullBaseCode.split(":").at(-1)! : fullBaseCode;
  const settlementMonths = new Map<string, number>();

  for (const contract of response?.contracts ?? []) {
    const code = String(contract?.code ?? "");
    const settlementDate = String(contract?.settlement_date ?? "");
    const monthCode = extractMonthCode(code, fullBaseCode, rootBase);
    const month = parseSettlementMonth(settlementDate);
    if (!monthCode || !month) continue;

    const existing = settlementMonths.get(monthCode);
    if (existing !== undefined && existing !== month) {
      throw new Error(`Contract month ${monthCode} maps to both ${existing} and ${month}`);
    }
    settlementMonths.set(monthCode, month);
  }

  if (settlementMonths.size === 0) {
    throw new Error(`No contract schedule returned for ${symbol}`);
  }

  const monthCodes = Array.from(settlementMonths.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([monthCode]) => monthCode);
  return { fullBaseCode, monthCodes, settlementMonths };
}

function optionalHistoryParams(options: DownloadHistoryOptions): Record<string, any> {
  const params: Record<string, any> = {};
  for (const key of [
    "bar_interval",
    "extended",
    "dadj",
    "badj",
    "settlement",
  ] as const) {
    if (options[key] !== undefined) params[key] = options[key];
  }
  return params;
}

function optionalSeriesParams(options: DownloadHistoryOptions): Record<string, any> {
  return optionalHistoryParams(options);
}

function validateOptions(options: DownloadHistoryOptions): void {
  if (!options.symbol) throw new Error("symbol is required");
  if (!options.from) throw new Error("from is required");
  if (!options.to) throw new Error("to is required");
  if (!options.output_dir) throw new Error("output_dir is required");
  if (![...HISTORY_BAR_TYPES, ...SERIES_BAR_TYPES].includes(options.bar_type)) {
    throw new Error("bar_type must be second, minute, hour, day, week, or month");
  }
  normalizeConcurrency(options.concurrency);
  if (options.format && !["json", "csv", "both"].includes(options.format)) {
    throw new Error("format must be json, csv, or both");
  }
  if (
    options.bar_interval !== undefined &&
    (!Number.isInteger(options.bar_interval) || options.bar_interval < 1 || options.bar_interval > 1440)
  ) {
    throw new Error("bar_interval must be an integer between 1 and 1440");
  }
  if (
    options.contract_lookback_months !== undefined &&
    (!Number.isInteger(options.contract_lookback_months) || options.contract_lookback_months < 1)
  ) {
    throw new Error("contract_lookback_months must be a positive integer");
  }
}

function normalizeConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }
  return concurrency;
}

function isContinuousFrontMonth(symbol: string): boolean {
  return symbol.endsWith("1!") || symbol.endsWith("2!");
}

function isArchiveBarType(barType: HistoryBarType): barType is (typeof HISTORY_BAR_TYPES)[number] {
  return HISTORY_BAR_TYPES.includes(barType as (typeof HISTORY_BAR_TYPES)[number]);
}

function isSeriesBarType(barType: HistoryBarType): barType is (typeof SERIES_BAR_TYPES)[number] {
  return SERIES_BAR_TYPES.includes(barType as (typeof SERIES_BAR_TYPES)[number]);
}

function continuousToBaseSymbol(symbol: string): string {
  return symbol.endsWith("1!") || symbol.endsWith("2!") ? symbol.slice(0, -2) : symbol;
}

function iterStartDates(from: string, to: string, barType: HistoryBarType): string[] {
  if (barType === "second") {
    const start = parseDay(from, "start");
    const end = parseDay(to, "end");
    if (compareDays(start, end) > 0) throw new Error("from must be before or equal to to");
    return Array.from(iterDays(start, end), formatDay);
  }

  const { start, end } = monthRangeFor(from, to);
  if (compareMonths(start, end) > 0) throw new Error("from must be before or equal to to");
  return Array.from(iterMonths(start, end), formatMonth);
}

function monthRangeFor(from: string, to: string): { start: MonthValue; end: MonthValue } {
  return { start: parseMonth(from), end: parseMonth(to) };
}

function expandArchiveStartDates(month: string, barType: HistoryBarType): string[] {
  if (barType !== "second") return [month];
  const start = parseDay(month, "start");
  const end = parseDay(month, "end");
  return Array.from(iterDays(start, end), formatDay);
}

function parseMonth(value: string): MonthValue {
  const match = /^(?<year>\d{4})-(?<month>\d{2})(?:-(?<day>\d{2}))?$/.exec(value);
  if (!match?.groups) throw new Error(`Invalid date "${value}". Use YYYY-MM or YYYY-MM-DD.`);
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  if (month < 1 || month > 12) throw new Error(`Invalid month in "${value}"`);
  if (match.groups.day !== undefined) {
    const day = Number(match.groups.day);
    if (day < 1 || day > daysInMonth(year, month)) {
      throw new Error(`Invalid day in "${value}"`);
    }
  }
  return { year, month };
}

function parseDay(value: string, bound: "start" | "end"): DayValue {
  const monthOnly = /^(?<year>\d{4})-(?<month>\d{2})$/.exec(value);
  if (monthOnly?.groups) {
    const year = Number(monthOnly.groups.year);
    const month = Number(monthOnly.groups.month);
    if (month < 1 || month > 12) throw new Error(`Invalid month in "${value}"`);
    const day = bound === "start" ? 1 : daysInMonth(year, month);
    return { year, month, day };
  }

  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(value);
  if (!match?.groups) throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Invalid day in "${value}"`);
  }
  return { year, month, day };
}

function* iterMonths(start: MonthValue, end: MonthValue): Generator<MonthValue> {
  let current = start;
  while (compareMonths(current, end) <= 0) {
    yield current;
    current = addMonths(current, 1);
  }
}

function* iterDays(start: DayValue, end: DayValue): Generator<DayValue> {
  let current = start;
  while (compareDays(current, end) <= 0) {
    yield current;
    current = addDays(current, 1);
  }
}

function addMonths(value: MonthValue, months: number): MonthValue {
  const index = value.year * 12 + value.month - 1 + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function addDays(value: DayValue, days: number): DayValue {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function compareMonths(a: MonthValue, b: MonthValue): number {
  return a.year === b.year ? a.month - b.month : a.year - b.year;
}

function compareDays(a: DayValue, b: DayValue): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function formatMonth(value: MonthValue): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`;
}

function formatDay(value: DayValue): string {
  return `${formatMonth(value)}-${String(value.day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function timeframeLabel(barType: HistoryBarType, interval = 1): string {
  const suffix = { second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo" }[
    barType
  ];
  return `${interval}${suffix}`;
}

function filterResponseForRequest(
  response: any,
  options: DownloadHistoryOptions,
  request: PlannedHistoryRequest,
): any {
  if (request.method !== "series" || !Array.isArray(response?.series)) return response;

  const start = dayBoundaryUnixSeconds(parseDay(options.from, "start"), "start");
  const end = dayBoundaryUnixSeconds(parseDay(options.to, "end"), "end");
  return {
    ...response,
    series: response.series.filter((row: any) => {
      const time = Array.isArray(row) ? row[0] : row?.time;
      return typeof time === "number" && time >= start && time <= end;
    }),
  };
}

function dayBoundaryUnixSeconds(value: DayValue, bound: "start" | "end"): number {
  const milliseconds =
    bound === "start"
      ? Date.UTC(value.year, value.month - 1, value.day, 0, 0, 0, 0)
      : Date.UTC(value.year, value.month - 1, value.day, 23, 59, 59, 999);
  return Math.floor(milliseconds / 1000);
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._!-]+/g, "_");
}

function outputFilesForFormat(outputBasePath: string, format: HistoryOutputFormat): string[] {
  if (format === "both") return [`${outputBasePath}.json`, `${outputBasePath}.csv`];
  return [`${outputBasePath}.${format}`];
}

function mergedCsvPath(options: DownloadHistoryOptions): string {
  return path.join(
    path.resolve(options.output_dir),
    sanitizePathPart(options.symbol),
    timeframeLabel(options.bar_type, options.bar_interval),
    "merged.csv",
  );
}

async function mergeCsvFiles(files: string[], outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const headers: string[] = [];
  const headerSet = new Set<string>();
  const rowsByKey = new Map<string, Record<string, string>>();

  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (!content.trim()) continue;

    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) continue;

    const columns = parseCsvLine(lines[0]);
    const codeIndex = columns.indexOf("code");
    const barTypeIndex = columns.indexOf("bar_type");
    const timeIndex = columns.indexOf("time");
    if (codeIndex === -1 || barTypeIndex === -1 || timeIndex === -1) {
      throw new Error("Merged CSV requires code, bar_type, and time columns for deduplication");
    }

    for (const column of columns) {
      if (!headerSet.has(column)) {
        headerSet.add(column);
        headers.push(column);
      }
    }

    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      const key = [codeIndex, barTypeIndex, timeIndex]
        .map((index) => values[index] ?? "")
        .join("\u0000");
      const row: Record<string, string> = {};
      for (let index = 0; index < columns.length; index += 1) {
        row[columns[index]] = values[index] ?? "";
      }
      rowsByKey.set(key, row);
    }
  }

  const rows = Array.from(rowsByKey.values()).map((row) =>
    headers.map((header) => row[header] ?? ""),
  );
  const content = headers.length > 0 ? serializeCsvRows(headers, rows) : "";
  await writeFile(outputPath, content, "utf8");
}

async function allFilesExist(files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      await readFile(file);
    } catch {
      return false;
    }
  }
  return true;
}

async function removeChunkFiles(files: string[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      try {
        await unlink(file);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }),
  );
}

function serializeCsvRows(headers: string[], rows: any[][]): string {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function escapeCsvCell(value: any): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells;
}

function parseSettlementMonth(value: string): number | null {
  const match = /^\d{4}(?<month>\d{2})\d{2}$/.exec(value);
  if (!match?.groups) return null;
  const month = Number(match.groups.month);
  return month >= 1 && month <= 12 ? month : null;
}

function extractMonthCode(code: string, fullBaseCode: string, rootBase: string): string | null {
  const prefixes = [fullBaseCode, rootBase];
  for (const prefix of prefixes) {
    if (!code.startsWith(prefix)) continue;
    const suffix = code.slice(prefix.length);
    const match = /^(?<monthCode>[A-Z])\d{4}$/.exec(suffix);
    if (match?.groups) return match.groups.monthCode;
  }
  const fallback = /(?<monthCode>[A-Z])\d{4}$/.exec(code);
  return fallback?.groups?.monthCode ?? null;
}
