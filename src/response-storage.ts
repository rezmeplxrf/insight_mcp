import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { responseToCsv } from "./history.js";

export type ResponseStoreFormat = "none" | "json" | "csv";

export interface ResponseStoreOptions {
  toolName: string;
  store?: ResponseStoreFormat;
  output_dir?: string;
  output_file?: string;
}

export interface StoredResponse {
  stored_file: string;
  format: Exclude<ResponseStoreFormat, "none">;
}

export function validateResponseStorage(options: ResponseStoreOptions): void {
  const format = options.store ?? "none";
  if (!["none", "json", "csv"].includes(format)) {
    throw new Error("store must be none, json, or csv");
  }
  if (format === "none") return;
  if (format === "csv" && options.toolName !== "get_symbol_series") {
    throw new Error("csv storage is only supported for get_symbol_series");
  }
  if (!options.output_file && !options.output_dir) {
    throw new Error("output_file or output_dir is required when store is json or csv");
  }
}

export async function storeResponse(
  response: any,
  options: ResponseStoreOptions,
): Promise<StoredResponse | null> {
  validateResponseStorage(options);
  const format = options.store ?? "none";
  if (format === "none") return null;

  const outputFile = resolveOutputFile(response, options, format);
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (format === "csv") {
    await writeFile(outputFile, responseToCsv(response), "utf8");
  } else {
    await writeFile(outputFile, `${JSON.stringify(response, null, 2)}\n`, "utf8");
  }
  return { stored_file: outputFile, format };
}

function resolveOutputFile(
  response: any,
  options: ResponseStoreOptions,
  format: Exclude<ResponseStoreFormat, "none">,
): string {
  if (options.output_file) return path.resolve(options.output_file);
  const parts = [options.toolName, response?.code, response?.bar_type]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => sanitizePathPart(String(part)));
  return path.join(path.resolve(options.output_dir!), `${parts.join("_")}.${format}`);
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._!-]+/g, "_");
}
