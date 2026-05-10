import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { responseToCsv } from "./history.js";

export type ResponseStoreFormat = "none" | "json" | "csv";

export interface ResponseStoreOptions {
  toolName: string;
  store?: ResponseStoreFormat;
  output_dir?: string;
  output_file?: string;
  requestParams?: Record<string, any>;
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

export async function validateResponseStorageTarget(options: ResponseStoreOptions): Promise<void> {
  validateResponseStorage(options);
  const format = options.store ?? "none";
  if (format === "none") return;

  if (options.output_file) {
    await validateWritableFileTarget(path.resolve(options.output_file));
    return;
  }

  if (options.output_dir) {
    await validateWritableDirectory(path.resolve(options.output_dir));
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
  const content =
    format === "csv" ? responseToCsv(response) : `${JSON.stringify(response, null, 2)}\n`;
  const storedFile = await writeStoredFile(outputFile, content, !options.output_file);
  return { stored_file: storedFile, format };
}

async function validateWritableFileTarget(outputFile: string): Promise<void> {
  try {
    const info = await stat(outputFile);
    if (info.isDirectory()) {
      throw new Error("output_file points to a directory");
    }
    await access(outputFile, constants.W_OK);
    return;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw storageTargetError(outputFile, error);
    }
  }

  await validateWritableDirectory(path.dirname(outputFile));
}

async function validateWritableDirectory(outputDir: string): Promise<void> {
  const probePath = path.join(outputDir, `.insight-response-store-write-test-${randomUUID()}`);
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(probePath, "", { encoding: "utf8", flag: "wx" });
  } catch (error: any) {
    throw storageTargetError(outputDir, error);
  } finally {
    try {
      await unlink(probePath);
    } catch {
      // Ignore cleanup errors from a failed or already-removed probe.
    }
  }
}

function storageTargetError(target: string, error: any): Error {
  const message = error?.message ?? String(error);
  return new Error(`storage target is not writable: ${target} (${message})`);
}

async function writeStoredFile(
  outputFile: string,
  content: string,
  unique: boolean,
): Promise<string> {
  await mkdir(path.dirname(outputFile), { recursive: true });
  if (!unique) {
    await writeFile(outputFile, content, "utf8");
    return outputFile;
  }

  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? outputFile : addFileSuffix(outputFile, suffix);
    try {
      await writeFile(candidate, content, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function resolveOutputFile(
  response: any,
  options: ResponseStoreOptions,
  format: Exclude<ResponseStoreFormat, "none">,
): string {
  if (options.output_file) return path.resolve(options.output_file);
  const outputDir = options.output_dir;
  if (!outputDir) {
    throw new Error("output_file or output_dir is required when store is json or csv");
  }
  const paramsHash = options.requestParams
    ? createHash("sha256").update(stableStringify(options.requestParams)).digest("hex").slice(0, 10)
    : undefined;
  const parts = [options.toolName, paramsHash, response?.code, response?.bar_type]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => sanitizePathPart(String(part)));
  return path.join(path.resolve(outputDir), `${parts.join("_")}.${format}`);
}

function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function addFileSuffix(filePath: string, suffix: number): string {
  const ext = path.extname(filePath);
  return path.join(path.dirname(filePath), `${path.basename(filePath, ext)}-${suffix}${ext}`);
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._!-]+/g, "_");
}
