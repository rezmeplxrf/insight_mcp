import jsonata from "jsonata";
import {
  type ResponseStoreFormat,
  storeResponse,
  validateResponseStorage,
} from "./response-storage.js";

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

  validateResponseStorage(storeOptions);
  const result = await options.request(options.method, options.pathTemplate, apiArgs);
  const stored = await storeResponse(result, storeOptions);

  if (filterExpr && typeof filterExpr === "string") {
    const expr = jsonata(filterExpr);
    return await expr.evaluate(result);
  }

  return stored ?? result;
}
