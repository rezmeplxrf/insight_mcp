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

export async function runApiTool(options: RunApiToolOptions): Promise<any> {
  const { filter: filterExpr, store, output_file, output_dir, ...apiArgs } = options.args;
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

  if (filterExpr && typeof filterExpr === "string") {
    const expr = jsonata(filterExpr);
    return await expr.evaluate(result);
  }

  return stored ?? result;
}
