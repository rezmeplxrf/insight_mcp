import { z } from "zod";
import jsonata from "jsonata";
import { ApiClient } from "./api-client.js";
import { toolDefinitions, type ToolDefinition } from "./tool-definitions.js";

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
  lines.push("All tools support --filter <jsonata> to transform the response.");
  lines.push("Use: insight <tool> --help for tool-specific parameters.");
  lines.push("");
  lines.push("Environment: INSIGHTSENTRY_API_KEY (required)");

  return lines.join("\n");
}

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
    const desc = zodType.description ?? "";
    const typeName = formatTypeName(zodType);
    lines.push(`  --${key.padEnd(24)} ${typeName}${optional}  ${desc}`);
  }

  // filter is always available
  lines.push(`  --${"filter".padEnd(24)} string [optional]  JSONata expression to transform the response`);

  return lines.join("\n");
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
    const apiKey = process.env.INSIGHTSENTRY_API_KEY?.trim();
    if (!apiKey) {
      io.write("Error: INSIGHTSENTRY_API_KEY environment variable is not set.\nGet your API key from https://insightsentry.com/dashboard\n");
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
