import { z } from "zod";

export const DOWNLOAD_HISTORY_BAR_TYPES = [
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;
export const DOWNLOAD_HISTORY_FORMATS = ["json", "csv", "both"] as const;

export const downloadHistorySchema: Record<string, z.ZodTypeAny> = {
  symbol: z.string().describe("Symbol code in EXCHANGE:SYMBOL format, e.g. NASDAQ:AAPL"),
  bar_type: z
    .enum(DOWNLOAD_HISTORY_BAR_TYPES)
    .describe("Bar type. second/minute/hour use /history; day/week/month use /series."),
  from: z.string().describe("Start date. Use YYYY-MM or YYYY-MM-DD."),
  to: z.string().describe("End date. Use YYYY-MM or YYYY-MM-DD."),
  output_dir: z.string().describe("Directory where downloaded files should be stored."),
  bar_interval: z.number().int().min(1).max(1440).describe("Bar interval. Default: 1.").optional(),
  format: z.enum(DOWNLOAD_HISTORY_FORMATS).default("csv").optional(),
  merge: z
    .boolean()
    .default(true)
    .optional()
    .describe(
      "Write one merged CSV file for the whole run when format is csv or both. Default is true.",
    ),
  keep_chunks: z
    .boolean()
    .default(false)
    .optional()
    .describe("Keep per-request CSV chunk files after merged CSV is written. Default is false."),
  concurrency: z.number().int().min(1).max(10).default(5).optional(),
  contract_lookback_months: z.number().int().min(1).default(6).optional(),
  overwrite: z.boolean().default(false).optional(),
  extended: z.boolean().default(true).optional().describe("Extended hours. Default is true."),
  dadj: z.boolean().default(false).optional().describe("Dividend adjustment. Default is false."),
  badj: z.boolean().default(true).optional().describe("Back-adjustment. Default is true."),
  settlement: z
    .boolean()
    .default(false)
    .optional()
    .describe("Set settlement as daily close. Default is false."),
};
