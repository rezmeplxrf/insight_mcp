import jsonata from "jsonata";
import { validateHistoryIntervalArgs } from "./history-validation.js";
import {
  type ResponseStoreFormat,
  storeResponse,
  validateResponseStorageTarget,
} from "./response-storage.js";
import { validateSymbolLikeArgs } from "./symbol-validation.js";

export type ApiToolRequestFn = (
  method: string,
  pathTemplate: string,
  params: Record<string, any>,
) => Promise<any>;

export interface RunApiToolOptions {
  toolName: string;
  method: string;
  pathTemplate: string;
  args: Record<string, any>;
  request: ApiToolRequestFn;
}

const DEFAULT_FILTER_ORIGINAL_OUTPUT_DIR = "./.tmp/insight";

export function validateFilterExpression(filterExpr: string | undefined): string | null {
  if (!filterExpr?.trim()) return null;
  try {
    jsonata(filterExpr);
    return null;
  } catch (error: any) {
    return error?.message ?? String(error);
  }
}

export async function runApiTool(options: RunApiToolOptions): Promise<any> {
  const { filter: filterExpr, store, output_file, output_dir, ...apiArgs } = options.args;
  let filter: ReturnType<typeof jsonata> | null = null;
  if (filterExpr && typeof filterExpr === "string") {
    try {
      filter = jsonata(filterExpr);
    } catch (error: any) {
      throw new Error(`Invalid filter: ${error?.message ?? String(error)}`);
    }
  }

  const storeOptions = {
    toolName: options.toolName,
    store: store as ResponseStoreFormat | undefined,
    output_file,
    output_dir,
    requestParams: apiArgs,
  };

  const symbolValidationError = validateSymbolLikeArgs(apiArgs);
  if (symbolValidationError) {
    throw new Error(`Invalid ${symbolValidationError.key}: ${symbolValidationError.error}`);
  }
  const historyIntervalError = validateHistoryIntervalArgs(options.toolName, apiArgs);
  if (historyIntervalError) {
    throw new Error(`Invalid ${historyIntervalError.key}: ${historyIntervalError.error}`);
  }
  await validateResponseStorageTarget(storeOptions);
  const result = await options.request(options.method, options.pathTemplate, apiArgs);
  const stored = await storeResponse(result, storeOptions);

  if (filter) {
    const filtered = await filter.evaluate(result);
    if (!isEmptyFilteredResult(filtered)) return filtered;

    const original =
      stored ?? (await tryStoreEmptyFilterOriginalResponse(result, options.toolName, apiArgs));
    const emptyFiltered = filtered === undefined ? null : filtered;
    if (!original) return emptyFiltered;

    return {
      filtered: emptyFiltered,
      message: `Filtered data is empty. Original response stored at ${original.stored_file}.`,
      original_response_file: original.stored_file,
    };
  }

  return stored ?? result;
}

function isEmptyFilteredResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

async function tryStoreEmptyFilterOriginalResponse(
  response: any,
  toolName: string,
  requestParams: Record<string, any>,
) {
  try {
    return await storeEmptyFilterOriginalResponse(response, toolName, requestParams);
  } catch {
    return null;
  }
}

async function storeEmptyFilterOriginalResponse(
  response: any,
  toolName: string,
  requestParams: Record<string, any>,
) {
  const stored = await storeResponse(response, {
    toolName,
    store: "json",
    output_dir: DEFAULT_FILTER_ORIGINAL_OUTPUT_DIR,
    requestParams,
  });
  if (!stored) throw new Error("failed to store original response for empty filtered data");
  return stored;
}
