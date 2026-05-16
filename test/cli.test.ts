import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildHelp,
  buildToolHelp,
  buildVersion,
  coerceArgs,
  parseArgs,
  runCli,
} from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { type ToolDefinition, toolDefinitions } from "../src/tool-definitions.js";

function utcDateParts(date = new Date()): { day: string; month: string } {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/g, "");

  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

function findTool(name: string): ToolDefinition {
  const tool = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool;
}

describe("parseArgs", () => {
  it("parses tool name and flags", () => {
    const result = parseArgs(["search_symbols", "--query", "apple"]);
    assert.equal(result.toolName, "search_symbols");
    assert.deepEqual(result.args, { query: "apple" });
    assert.equal(result.help, false);
  });

  it("parses --help with no tool", () => {
    const result = parseArgs(["--help"]);
    assert.equal(result.toolName, null);
    assert.equal(result.help, true);
  });

  it("parses tool --help", () => {
    const result = parseArgs(["get_quotes", "--help"]);
    assert.equal(result.toolName, "get_quotes");
    assert.equal(result.help, true);
  });

  it("parses multiple flags", () => {
    const result = parseArgs([
      "get_symbol_series",
      "--symbol",
      "NASDAQ:AAPL",
      "--bar_type",
      "day",
      "--dp",
      "30",
      "--filter",
      "series[-1].close",
    ]);
    assert.equal(result.toolName, "get_symbol_series");
    assert.deepEqual(result.args, {
      symbol: "NASDAQ:AAPL",
      bar_type: "day",
      dp: "30",
      filter: "series[-1].close",
    });
  });

  it("parses boolean flags without value as true", () => {
    const result = parseArgs(["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--extended"]);
    assert.equal(result.args.extended, "true");
  });

  it("returns empty args when only tool name given", () => {
    const result = parseArgs(["get_fundamentals_meta"]);
    assert.equal(result.toolName, "get_fundamentals_meta");
    assert.deepEqual(result.args, {});
  });

  it("handles -h as help", () => {
    const result = parseArgs(["-h"]);
    assert.equal(result.help, true);
  });

  it("handles tool -h", () => {
    const result = parseArgs(["get_quotes", "-h"]);
    assert.equal(result.toolName, "get_quotes");
    assert.equal(result.help, true);
  });
});

describe("tool definitions", () => {
  it("exposes current options endpoints and omits deprecated option tools", () => {
    const names = new Set(toolDefinitions.map((tool) => tool.name));

    assert.ok(names.has("get_options_contracts"));
    assert.ok(names.has("get_options_quotes"));
    assert.ok(!names.has("list_options"));
    assert.ok(!names.has("get_options_expiration"));
    assert.ok(!names.has("get_options_strike"));

    assert.equal(findTool("get_options_contracts").pathTemplate, "/v3/options/contracts");
    assert.equal(findTool("get_options_quotes").pathTemplate, "/v3/options/quotes");
  });

  it("documents option range caps without rejecting values above the cap", () => {
    for (const toolName of ["get_options_contracts", "get_options_quotes"]) {
      const tool = findTool(toolName);
      const rangeSchema = tool.schema.range;
      assert.ok(rangeSchema, `${toolName} should expose range`);

      assert.equal(rangeSchema.safeParse(1500).success, true);
      assert.equal(rangeSchema.safeParse(0).success, false);
      assert.match(buildToolHelp(tool), /Values above 1000 are capped at 1000/);
    }
  });
});

describe("coerceArgs", () => {
  const seriesToolDef = findTool("get_symbol_series");

  it("coerces number strings to numbers", () => {
    const result = coerceArgs({ dp: "30", bar_interval: "5" }, seriesToolDef.schema);
    assert.equal(result.dp, 30);
    assert.equal(result.bar_interval, 5);
  });

  it("leaves already typed numbers as numbers", () => {
    const result = coerceArgs({ dp: 30, bar_interval: 5 }, seriesToolDef.schema);
    assert.equal(result.dp, 30);
    assert.equal(result.bar_interval, 5);
  });

  it("coerces boolean strings to booleans", () => {
    const result = coerceArgs({ extended: "true", dadj: "false" }, seriesToolDef.schema);
    assert.equal(result.extended, true);
    assert.equal(result.dadj, false);
  });

  it("leaves already typed booleans as booleans", () => {
    const result = coerceArgs({ extended: true, dadj: false }, seriesToolDef.schema);
    assert.equal(result.extended, true);
    assert.equal(result.dadj, false);
  });

  it("leaves strings as strings", () => {
    const result = coerceArgs({ symbol: "NASDAQ:AAPL", bar_type: "day" }, seriesToolDef.schema);
    assert.equal(result.symbol, "NASDAQ:AAPL");
    assert.equal(result.bar_type, "day");
  });

  it("coerces JSON arrays", () => {
    const screenerDef = findTool("screen_stocks");
    const result = coerceArgs(
      { fields: '["close","volume"]', exchanges: '["NYSE"]' },
      screenerDef.schema,
    );
    assert.deepEqual(result.fields, ["close", "volume"]);
    assert.deepEqual(result.exchanges, ["NYSE"]);
  });

  it("coerces comma-separated values to arrays", () => {
    const screenerDef = findTool("screen_stocks");
    const result = coerceArgs({ fields: "close,volume" }, screenerDef.schema);
    assert.deepEqual(result.fields, ["close", "volume"]);
  });

  it("passes through unknown args unmodified", () => {
    const result = coerceArgs({ filter: "series.close" }, seriesToolDef.schema);
    assert.equal(result.filter, "series.close");
  });
});

describe("buildHelp", () => {
  it("lists all tools", () => {
    const help = buildHelp();
    assert.ok(help.includes("insight"));
    assert.ok(help.includes("search_symbols"));
    assert.ok(help.includes("get_quotes"));
    assert.ok(help.includes("get_symbol_series"));
    assert.ok(help.includes("insight whoami"));
    assert.ok(help.includes("insight version"));
    assert.ok(help.includes("insight update"));
  });

  it("describes filter as API-tool only", () => {
    const help = buildHelp();
    assert.ok(help.includes("API tools support --filter"));
    assert.ok(!help.includes("All tools support --filter"));
  });
});

describe("buildToolHelp", () => {
  it("shows tool params", () => {
    const tool = findTool("get_symbol_series");
    const help = buildToolHelp(tool);
    assert.ok(help.includes("get_symbol_series"));
    assert.ok(help.includes("--symbol"));
    assert.ok(help.includes("--bar_type"));
    assert.ok(help.includes("--dp"));
    assert.ok(help.includes("--filter"));
    assert.ok(help.includes("--store"));
    assert.ok(help.includes("--output_file"));
  });

  it("marks optional params", () => {
    const tool = findTool("get_symbol_series");
    const help = buildToolHelp(tool);
    assert.ok(help.includes("[optional]"));
  });

  it("shows tool with no params", () => {
    const tool = findTool("get_fundamentals_meta");
    const help = buildToolHelp(tool);
    assert.ok(help.includes("get_fundamentals_meta"));
    assert.ok(help.includes("--filter"));
  });
});

describe("runCli", () => {
  let output: string;
  let exitCode: number | undefined;
  let tempConfigDir: string | null = null;
  const originalConfigDir = process.env.INSIGHTSENTRY_CONFIG_DIR;
  const write = (s: string) => {
    output += s;
  };
  const exit = (code: number) => {
    exitCode = code;
  };

  beforeEach(async () => {
    output = "";
    exitCode = undefined;
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "insight-cli-config-"));
    process.env.INSIGHTSENTRY_CONFIG_DIR = tempConfigDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.INSIGHTSENTRY_CONFIG_DIR;
    } else {
      process.env.INSIGHTSENTRY_CONFIG_DIR = originalConfigDir;
    }
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = null;
    }
  });

  it("shows help with no args", async () => {
    await runCli([], { write, exit });
    assert.ok(output.includes("search_symbols"));
    assert.equal(exitCode, 0);
  });

  it("shows help with --help", async () => {
    await runCli(["--help"], { write, exit });
    assert.ok(output.includes("search_symbols"));
    assert.equal(exitCode, 0);
  });

  it("shows package version with --version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    let latestVersionChecked = false;

    await runCli(["--version"], {
      write,
      exit,
      getLatestVersion: async () => {
        latestVersionChecked = true;
        return "99.0.0";
      },
    });

    assert.equal(output, `@insightsentry/mcp ${packageJson.version}`);
    assert.equal(latestVersionChecked, false);
    assert.equal(exitCode, 0);
  });

  it("shows current and latest version with version command", async () => {
    await runCli(["version"], {
      write,
      exit,
      getLatestVersion: async () => "99.0.0",
    });

    assert.ok(output.includes(buildVersion()));
    assert.ok(output.includes("Latest: 99.0.0"));
    assert.ok(output.includes("Update available: run `insight update`."));
    assert.equal(exitCode, 0);
  });

  it("reports when version check cannot reach the registry", async () => {
    await runCli(["version"], {
      write,
      exit,
      getLatestVersion: async () => {
        throw new Error("registry unavailable");
      },
    });

    assert.ok(output.includes(buildVersion()));
    assert.ok(output.includes("Latest: unavailable"));
    assert.ok(output.includes("registry unavailable"));
    assert.equal(exitCode, 1);
  });

  it("prompts for a tool when run interactively without arguments", async () => {
    const selectedToolIndex =
      toolDefinitions.findIndex((tool) => tool.name === "get_fundamentals_meta") + 1;
    const questions: string[] = [];

    await runCli([], {
      write,
      exit,
      isInteractive: true,
      getAuthStatus: () => ({
        authenticated: true,
        source: "environment",
        config_path: "/tmp/insightsentry/config.json",
        key_present: true,
        key_format_valid: true,
        subject: "user@example.com",
        message: "Logged in using INSIGHTSENTRY_API_KEY.",
      }),
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Choose tool")) return String(selectedToolIndex);
        return "";
      },
      request: async () => ({ ok: true }),
    });

    assert.ok(output.includes("Choose a tool"));
    assert.ok(output.includes(`${selectedToolIndex}. get_fundamentals_meta`));
    assert.ok(questions.some((question) => question.includes("Choose tool")));
    assert.deepEqual(JSON.parse(output.slice(output.lastIndexOf("{"))), { ok: true });
    assert.equal(exitCode, undefined);
  });

  it("exits cleanly when Ctrl+C aborts an interactive prompt", async () => {
    const abort = Object.assign(new Error("Aborted with Ctrl+C"), {
      code: "ABORT_ERR",
      name: "AbortError",
    });

    await runCli([], {
      write,
      exit,
      isInteractive: true,
      getAuthStatus: () => ({
        authenticated: true,
        source: "environment",
        config_path: "/tmp/insightsentry/config.json",
        key_present: true,
        key_format_valid: true,
        subject: "user@example.com",
        message: "Logged in using INSIGHTSENTRY_API_KEY.",
      }),
      prompt: async () => {
        throw abort;
      },
    });

    assert.ok(output.includes("Choose a tool"));
    assert.equal(exitCode, 130);
  });

  it("prompts for an API key before the no-args interactive tool picker", async () => {
    const selectedToolIndex =
      toolDefinitions.findIndex((tool) => tool.name === "get_fundamentals_meta") + 1;
    const apiKey = jwt({ uuid: "user@example.com", plan: "ultra" });
    const questions: string[] = [];

    await runCli([], {
      write,
      exit,
      isInteractive: true,
      getAuthStatus: () => ({
        authenticated: false,
        source: "none",
        config_path: "/tmp/insightsentry/config.json",
        key_present: false,
        key_format_valid: false,
        message: "Logged out. No API key found.",
      }),
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("API key")) return apiKey;
        if (question.includes("Choose tool")) return String(selectedToolIndex);
        return "";
      },
      request: async () => ({ ok: true }),
    });

    assert.ok(output.includes("No API key found"));
    assert.ok(output.includes("API key saved"));
    assert.ok(output.includes("Choose a tool"));
    assert.ok(questions.some((question) => question.includes("API key")));
    assert.ok(questions.some((question) => question.includes("Choose tool")));
    assert.equal(loadConfig().apiKey, apiKey);
    assert.deepEqual(JSON.parse(output.slice(output.lastIndexOf("{"))), { ok: true });
    assert.equal(exitCode, undefined);
  });

  it("uses the prompted API key for the current no-args interactive run", async () => {
    const origKey = process.env.INSIGHTSENTRY_API_KEY;
    const selectedToolIndex =
      toolDefinitions.findIndex((tool) => tool.name === "get_fundamentals_meta") + 1;
    const apiKey = jwt({ uuid: "user@example.com", plan: "ultra" });
    let requestKey: string | undefined;

    process.env.INSIGHTSENTRY_API_KEY = "bad.env.key";
    try {
      await runCli([], {
        write,
        exit,
        isInteractive: true,
        getAuthStatus: () => ({
          authenticated: false,
          source: "environment",
          config_path: "/tmp/insightsentry/config.json",
          key_present: true,
          key_format_valid: false,
          message: "Logged out. INSIGHTSENTRY_API_KEY is not valid.",
        }),
        prompt: async (question) => {
          if (question.includes("API key")) return apiKey;
          if (question.includes("Choose tool")) return String(selectedToolIndex);
          return "";
        },
        createRequestFromApiKey: (key) => {
          requestKey = key;
          return async () => ({ ok: true });
        },
      });
    } finally {
      if (origKey === undefined) {
        delete process.env.INSIGHTSENTRY_API_KEY;
      } else {
        process.env.INSIGHTSENTRY_API_KEY = origKey;
      }
    }

    assert.equal(requestKey, apiKey);
    assert.deepEqual(JSON.parse(output.slice(output.lastIndexOf("{"))), { ok: true });
    assert.equal(exitCode, undefined);
  });

  it("shows tool help with tool --help", async () => {
    await runCli(["get_quotes", "--help"], { write, exit });
    assert.ok(output.includes("--codes"));
    assert.equal(exitCode, 0);
  });

  it("shows render_chart help", async () => {
    await runCli(["render_chart", "--help"], { write, exit });
    assert.ok(output.includes("Chart.js"));
    assert.ok(output.includes("--config"));
    assert.equal(exitCode, 0);
  });

  it("renders a chart from the CLI without API authentication", async () => {
    let rendered:
      | {
          config: Record<string, unknown>;
          width: number | undefined;
          height: number | undefined;
        }
      | undefined;
    const config = {
      type: "line",
      data: {
        labels: ["Jan"],
        datasets: [{ label: "Close", data: [100] }],
      },
    };

    await runCli(
      [
        "render_chart",
        "--config",
        JSON.stringify(config),
        "--width",
        "320",
        "--height",
        "240",
        "--unknown",
        "ignored",
      ],
      {
        write,
        exit,
        progress: () => {},
        renderChart: async (chartConfig, width, height) => {
          rendered = { config: chartConfig as Record<string, unknown>, width, height };
          return { base64: "png-base64", filePath: "/tmp/chart.png" };
        },
      },
    );

    assert.deepEqual(rendered, { config, width: 320, height: 240 });
    assert.deepEqual(JSON.parse(output), {
      file: "/tmp/chart.png",
      mime_type: "image/png",
    });
    assert.equal(exitCode, undefined);
  });

  it("errors on unknown tool", async () => {
    await runCli(["nonexistent_tool"], { write, exit });
    assert.ok(output.includes("Unknown tool"));
    assert.equal(exitCode, 1);
  });

  it("errors when API key is missing", async () => {
    const origKey = process.env.INSIGHTSENTRY_API_KEY;
    delete process.env.INSIGHTSENTRY_API_KEY;
    try {
      await runCli(["get_fundamentals_meta"], { write, exit });
      assert.ok(output.includes("No API key found"));
      assert.ok(output.includes("insight login"));
      assert.equal(exitCode, 1);
    } finally {
      if (origKey) process.env.INSIGHTSENTRY_API_KEY = origKey;
    }
  });

  it("reports used and disregarded args before running API tools", async () => {
    const events: string[] = [];

    await runCli(["search_symbols", "--query", "apple", "--type", "stock", "--bogus", "ignored"], {
      write,
      exit,
      progress: (message) => events.push(message),
      request: async (_method, _path, params) => {
        events.push("request");
        assert.deepEqual(params, { query: "apple", type: "stock" });
        return { symbols: [] };
      },
    });

    assert.deepEqual(events, [
      "Using args: query=apple, type=stock",
      "Disregarding args: --bogus=ignored",
      "request",
    ]);
    assert.deepEqual(JSON.parse(output), { symbols: [] });
  });

  it("login without key shows usage when non-interactive", async () => {
    await runCli(["login"], { write, exit, isInteractive: false });
    assert.ok(output.includes("insight login --key"));
    assert.equal(exitCode, 1);
  });

  it("login with key saves config", async () => {
    await runCli(["login", "--key", jwt({ uuid: "user@example.com", plan: "enterprise" })], {
      write,
      exit,
    });
    assert.ok(output.includes("API key saved"));
    assert.equal(exitCode, 0);
  });

  it("login rejects a non-JWT key", async () => {
    await runCli(["login", "--key", "not-a-jwt"], { write, exit });

    assert.ok(output.includes("API key is not a valid InsightSentry JWT"));
    assert.deepEqual(loadConfig(), {});
    assert.equal(exitCode, 1);
  });

  it("login rejects a JWT missing uuid or plan", async () => {
    await runCli(["login", "--key", jwt({ uuid: "user@example.com" })], { write, exit });

    assert.ok(output.includes("API key JWT must include uuid and plan"));
    assert.deepEqual(loadConfig(), {});
    assert.equal(exitCode, 1);
  });

  it("login prompts for key when interactive", async () => {
    const answers = new Map([["API key: ", jwt({ uuid: "user@example.com", plan: "mega" })]]);

    await runCli(["login"], {
      write,
      exit,
      isInteractive: true,
      prompt: async (question) => answers.get(question) ?? "",
    });

    assert.ok(output.includes("API key saved"));
    assert.equal(exitCode, 0);
  });

  it("interactive login reprompts after an invalid prompted key", async () => {
    const answers = [jwt({ plan: "enterprise" }), jwt({ uuid: "user@example.com", plan: "ultra" })];

    await runCli(["login"], {
      write,
      exit,
      isInteractive: true,
      prompt: async () => answers.shift() ?? "",
    });

    assert.ok(output.includes("API key JWT must include uuid and plan"));
    assert.ok(output.includes("API key saved"));
    assert.equal(loadConfig().apiKey, jwt({ uuid: "user@example.com", plan: "ultra" }));
    assert.equal(exitCode, 0);
  });

  it("logout removes config", async () => {
    await runCli(["logout"], { write, exit });
    assert.ok(output.includes("API key removed"));
    assert.equal(exitCode, 0);
  });

  it("whoami prints the configured identity", async () => {
    await runCli(["whoami"], {
      write,
      exit,
      getAuthStatus: () => ({
        authenticated: true,
        source: "environment",
        config_path: "/tmp/insightsentry/config.json",
        key_present: true,
        key_format_valid: true,
        subject: "user@example.com",
        expires_at: "2026-06-01T00:00:00.000Z",
        expired: false,
        message: "Logged in using INSIGHTSENTRY_API_KEY.",
      }),
    });

    assert.equal(output, "user@example.com");
    assert.equal(exitCode, 0);
  });

  it("whoami reports missing credentials", async () => {
    await runCli(["whoami"], {
      write,
      exit,
      getAuthStatus: () => ({
        authenticated: false,
        source: "none",
        config_path: "/tmp/insightsentry/config.json",
        key_present: false,
        key_format_valid: false,
        message: "Logged out. No API key found.",
      }),
    });

    assert.ok(output.includes("No API key found"));
    assert.equal(exitCode, 1);
  });

  it("updates the global CLI package", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["update"], {
      write,
      exit,
      getLatestVersion: async () => "99.0.0",
      runCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "updated package", stderr: "" };
      },
    });

    assert.deepEqual(commands, [{ command: "npm", args: ["install", "-g", "@insightsentry/mcp"] }]);
    assert.ok(output.includes("Updating InsightSentry CLI/MCP"));
    assert.ok(output.includes("updated package"));
    assert.equal(exitCode, 0);
  });

  it("skips update when the CLI is already current", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));

    await runCli(["update"], {
      write,
      exit,
      getLatestVersion: async () => packageJson.version,
      runCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "updated package", stderr: "" };
      },
    });

    assert.deepEqual(commands, []);
    assert.ok(output.includes("You are on the latest version."));
    assert.equal(exitCode, 0);
  });

  it("reports update command failures", async () => {
    await runCli(["update"], {
      write,
      exit,
      getLatestVersion: async () => "99.0.0",
      runCommand: async () => {
        throw new Error("npm is not available");
      },
    });

    assert.ok(output.includes("Error: npm is not available"));
    assert.equal(exitCode, 1);
  });

  it("calls API and outputs JSON", async () => {
    const mockRequest = async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] });
    await runCli(["search_symbols", "--query", "apple"], { write, exit, request: mockRequest });
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, { symbols: [{ code: "NASDAQ:AAPL" }] });
    assert.equal(exitCode, undefined);
  });

  it("checks for upgrades after successful tools without changing stdout", async () => {
    let notice = "";
    let latestVersionChecks = 0;
    const mockRequest = async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] });

    await runCli(["search_symbols", "--query", "apple"], {
      write,
      exit,
      request: mockRequest,
      writeNotice: (s) => {
        notice += s;
      },
      getLatestVersion: async () => {
        latestVersionChecks++;
        return "99.0.0";
      },
    });

    assert.deepEqual(JSON.parse(output), { symbols: [{ code: "NASDAQ:AAPL" }] });
    assert.equal(latestVersionChecks, 1);
    assert.ok(notice.includes("InsightSentry CLI/MCP 99.0.0 is available"));
    assert.ok(notice.includes("Run `insight update`."));
  });

  it("uses cached upgrade checks for repeated tool runs", async () => {
    let latestVersionChecks = 0;
    const mockRequest = async () => ({ symbols: [] });
    const io = {
      write,
      exit,
      request: mockRequest,
      writeNotice: () => {},
      getLatestVersion: async () => {
        latestVersionChecks++;
        return "99.0.0";
      },
    };

    await runCli(["search_symbols", "--query", "apple"], io);
    output = "";
    await runCli(["search_symbols", "--query", "microsoft"], io);

    assert.equal(latestVersionChecks, 1);
  });

  it("does not fail a successful tool when the post-tool version check fails", async () => {
    let notice = "";
    const mockRequest = async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] });

    await runCli(["search_symbols", "--query", "apple"], {
      write,
      exit,
      request: mockRequest,
      writeNotice: (s) => {
        notice += s;
      },
      getLatestVersion: async () => {
        throw new Error("registry unavailable");
      },
    });

    assert.deepEqual(JSON.parse(output), { symbols: [{ code: "NASDAQ:AAPL" }] });
    assert.equal(notice, "");
    assert.equal(exitCode, undefined);
  });

  it("prompts for missing required tool arguments when interactive", async () => {
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => ({
      code: params.symbol,
    });

    await runCli(["get_symbol_info"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
        return "";
      },
    });

    const parsed = JSON.parse(output.slice(output.indexOf("{")));
    assert.deepEqual(parsed, { code: "NASDAQ:AAPL" });
    assert.equal(exitCode, undefined);
  });

  it("shows choices and schema hints for required interactive tool arguments", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_symbol_history"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
        if (question.startsWith("Bar Type")) return "minute";
        if (question.startsWith("Start Date")) return "2024-01";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.symbol, "NASDAQ:AAPL");
    assert.equal(parsed.bar_type, "minute");
    assert.equal(parsed.start_date, "2024-01");
    assert.ok(
      questions.some(
        (question) =>
          question.includes("Bar Type: Bar type.") &&
          question.includes("Bar Type (required, choices: second/minute/hour):"),
      ),
    );
    assert.ok(
      questions.some(
        (question) =>
          question.includes("Start Date: Starting period in YYYY-MM format") &&
          question.includes("Start Date (required):"),
      ),
    );
  });

  it("shows concise descriptions separately from optional prompt instructions", async () => {
    const questions: string[] = [];

    await runCli(["get_dividends"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => params,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("W:")) return "2";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.w, 2);
    assert.ok(
      questions.some(
        (question) =>
          question.includes("W: Specifies the week range.") &&
          question.includes("and so on.") &&
          question.includes("W (optional, type: number, press Enter to skip):"),
      ),
    );
    assert.ok(!questions.some((question) => question.includes("...")));
  });

  it("accepts an option quote date selector interactively", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_options_quotes", "--code", "NASDAQ:AAPL"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("From")) return "2026-06-01";
        if (question.startsWith("To")) return "2026-07-01";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.code, "NASDAQ:AAPL");
    assert.equal(parsed.from, "2026-06-01");
    assert.ok(
      questions.some(
        (question) =>
          question.startsWith("Expiration") &&
          question.includes("optional") &&
          question.includes("Exact expiration date") &&
          question.includes("Expiration (optional, press Enter to skip):"),
      ),
    );
    assert.ok(questions.some((question) => question.startsWith("From")));
    assert.ok(!questions.some((question) => question.startsWith("To")));
    assert.ok(!questions.some((question) => question.startsWith("Range")));
    assert.ok(!output.includes("Invalid Expiration"));
  });

  it("skips other option quote selector prompts when expiration is provided", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_options_quotes", "--code", "NASDAQ:AAPL"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Expiration")) return "2026-06-19";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.expiration, "2026-06-19");
    assert.ok(!questions.some((question) => question.startsWith("From")));
    assert.ok(!questions.some((question) => question.startsWith("To")));
    assert.ok(!questions.some((question) => question.startsWith("Range")));
  });

  it("accepts optional range interactively after other option quote selectors are skipped", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_options_quotes", "--code", "NASDAQ:AAPL"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Range")) return "5";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.range, 5);
    assert.ok(questions.some((question) => question.startsWith("Strike")));
    assert.ok(questions.some((question) => question.startsWith("Expiration")));
    assert.ok(questions.some((question) => question.startsWith("From")));
    assert.ok(questions.some((question) => question.startsWith("To")));
    assert.ok(
      questions.some((question) => question.startsWith("Range") && question.includes("optional")),
    );
    assert.ok(!output.includes("Invalid Strike"));
  });

  it("skips other option quote selector prompts when strike is provided", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_options_quotes", "--code", "NASDAQ:AAPL"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Strike")) return "250";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.strike, 250);
    assert.ok(!questions.some((question) => question.startsWith("Expiration")));
    assert.ok(!questions.some((question) => question.startsWith("From")));
    assert.ok(!questions.some((question) => question.startsWith("To")));
    assert.ok(!questions.some((question) => question.startsWith("Range")));
  });

  it("prompts for optional tool arguments in interactive mode and shows defaults", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_symbol_series", "--symbol", "NASDAQ:AAPL"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Bar Type")) return "minute";
        if (question.includes("Split")) return "true";
        if (question.includes("Dadj")) return "true";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.symbol, "NASDAQ:AAPL");
    assert.equal(parsed.bar_type, "minute");
    assert.equal(parsed.split, true);
    assert.equal(parsed.dadj, true);
    assert.ok(questions.some((question) => question.includes("Bar Type")));
    assert.ok(questions.some((question) => question.includes("Default: day")));
    assert.ok(questions.some((question) => question.includes("Split")));
    assert.ok(questions.some((question) => question.includes("Dadj")));
    assert.ok(!questions.some((question) => question.includes("Badj")));
    assert.ok(!questions.some((question) => question.includes("Settlement")));
    assert.ok(questions.some((question) => question.includes("Default: false")));
  });

  it("skips dadj after split is disabled with a boolean alias in interactive mode", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_symbol_series", "--symbol", "NASDAQ:AAPL"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Bar Type")) return "minute";
        if (question.includes("Split")) return "no";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.split, false);
    assert.equal(parsed.dadj, undefined);
    assert.ok(questions.some((question) => question.includes("Split")));
    assert.ok(!questions.some((question) => question.includes("Dadj")));
  });

  it("skips equity-only prompts for interactive futures symbols", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_symbol_series", "--symbol", "CME_MINI:NQ1!"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Bar Type")) return "hour";
        if (question.includes("Badj")) return "true";
        if (question.includes("Settlement")) return "true";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.symbol, "CME_MINI:NQ1!");
    assert.equal(parsed.bar_type, "hour");
    assert.equal(parsed.badj, true);
    assert.equal(parsed.settlement, true);
    assert.ok(!questions.some((question) => question.includes("Extended")));
    assert.ok(!questions.some((question) => question.includes("Split")));
    assert.ok(!questions.some((question) => question.includes("Dadj")));
    assert.ok(questions.some((question) => question.includes("Badj")));
    assert.ok(questions.some((question) => question.includes("Settlement")));
  });

  it("skips continuous-only prompts for specific futures symbols", async () => {
    const questions: string[] = [];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => params;

    await runCli(["get_symbol_series", "--symbol", "CME_MINI:NQH2026"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Bar Type")) return "hour";
        if (question.includes("Settlement")) return "true";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.equal(parsed.symbol, "CME_MINI:NQH2026");
    assert.equal(parsed.bar_type, "hour");
    assert.equal(parsed.settlement, true);
    assert.ok(!questions.some((question) => question.includes("Extended")));
    assert.ok(!questions.some((question) => question.includes("Split")));
    assert.ok(!questions.some((question) => question.includes("Dadj")));
    assert.ok(!questions.some((question) => question.includes("Badj")));
    assert.ok(questions.some((question) => question.includes("Settlement")));
  });

  it("prompts for storage and filter by default in interactive mode", async () => {
    const questions: string[] = [];

    await runCli(["get_fundamentals_meta"], {
      write,
      exit,
      request: async () => ({
        base: [{ id: "total_revenue" }, { id: "net_income" }],
      }),
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        return "";
      },
    });

    assert.deepEqual(JSON.parse(output), {
      base: [{ id: "total_revenue" }, { id: "net_income" }],
    });
    assert.equal(questions.length, 2);
    assert.ok(questions[0].includes("Store: Store original API response before filtering."));
    assert.ok(questions[0].includes("Store (optional, choices: none/json"));
    assert.ok(!questions[0].includes("csv"));
    assert.ok(questions[1].includes("Filter: JSONata expression to transform the response."));
    assert.ok(questions[1].includes("Filter (optional, press Enter to skip):"));
  });

  it("reprompts invalid interactive filters", async () => {
    const questions: string[] = [];
    const filters = ["base[", "base.id"];

    await runCli(["get_fundamentals_meta"], {
      write,
      exit,
      request: async () => ({
        base: [{ id: "total_revenue" }, { id: "net_income" }],
      }),
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Filter")) return filters.shift() ?? "";
        return "";
      },
    });

    assert.ok(output.includes("Invalid Filter"));
    assert.ok(questions.filter((question) => question.includes("Filter")).length >= 2);
    assert.deepEqual(JSON.parse(output.slice(output.indexOf("["))), [
      "total_revenue",
      "net_income",
    ]);
    assert.equal(exitCode, undefined);
  });

  it("does not prompt for unsupported crypto screener country filters", async () => {
    const questions: string[] = [];

    await runCli(["screen_crypto"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => params,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Fields")) return "close,volume";
        return "";
      },
    });

    const parsed = JSON.parse(output);
    assert.deepEqual(parsed.fields, ["close", "volume"]);
    assert.ok(!questions.some((question) => question.startsWith("Countries")));
  });

  it("reprompts invalid provided tool arguments when interactive", async () => {
    const questions: string[] = [];

    await runCli(["get_symbol_history", "--symbol", "NASDAQ:AAPL", "--bar_type", "daily"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => params,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.startsWith("Bar Type")) return "minute";
        if (question.startsWith("Start Date")) return "2024-01";
        return "";
      },
    });

    const parsed = JSON.parse(output.slice(output.indexOf("{")));
    assert.equal(parsed.bar_type, "minute");
    assert.equal(parsed.start_date, "2024-01");
    assert.ok(output.includes("Invalid Bar Type"));
    assert.ok(questions.some((question) => question.startsWith("Bar Type")));
    assert.equal(exitCode, undefined);
  });

  it("reprompts impossible storage modes in interactive mode", async () => {
    const questions: string[] = [];

    await runCli(["search_symbols", "--query", "apple", "--store", "csv"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => params,
      isInteractive: true,
      prompt: async (question) => {
        questions.push(question);
        if (question.includes("Store")) return "none";
        return "";
      },
    });

    assert.ok(
      output.includes("csv storage is only supported for get_symbol_series and get_symbol_history"),
    );
    assert.ok(questions.some((question) => question.includes("Store")));
    assert.deepEqual(JSON.parse(output.slice(output.indexOf("{"))), { query: "apple" });
    assert.equal(exitCode, undefined);
  });

  it("reports missing required options before auth in non-interactive mode", async () => {
    const origKey = process.env.INSIGHTSENTRY_API_KEY;
    delete process.env.INSIGHTSENTRY_API_KEY;
    try {
      await runCli(["get_symbol_info"], {
        write,
        exit,
        isInteractive: false,
      });
    } finally {
      if (origKey !== undefined) process.env.INSIGHTSENTRY_API_KEY = origKey;
    }

    assert.ok(output.includes("Missing required options for get_symbol_info: symbol"));
    assert.ok(!output.includes("No API key found"));
    assert.equal(exitCode, 1);
  });

  it("allows option quote requests with only code when interactive prompts are left blank", async () => {
    await runCli(["get_options_quotes", "--code", "NASDAQ:AAPL"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => params,
      isInteractive: true,
      prompt: async () => "",
    });

    assert.deepEqual(JSON.parse(output), { code: "NASDAQ:AAPL" });
    assert.equal(exitCode, undefined);
  });

  it("validates provided tool arguments before calling the API", async () => {
    await runCli(["get_symbol_history", "--symbol", "NASDAQ:AAPL", "--bar_type", "daily"], {
      write,
      exit,
      request: async () => assert.fail("invalid args should fail before request"),
    });

    assert.ok(output.includes("Invalid Bar Type"));
    assert.ok(output.includes("second, minute, hour"));
    assert.equal(exitCode, 1);
  });

  it("validates history bar intervals before calling the API", async () => {
    await runCli(
      [
        "get_symbol_history",
        "--symbol",
        "NASDAQ:AAPL",
        "--bar_type",
        "second",
        "--start_date",
        "2024-01-01",
        "--bar_interval",
        "2",
      ],
      {
        write,
        exit,
        request: async () => assert.fail("invalid interval should fail before request"),
      },
    );

    assert.ok(output.includes("Invalid Bar Interval"));
    assert.ok(output.includes("1, 5, 10, 15, 30, 45"));
    assert.equal(exitCode, 1);
  });

  it("reprompts interactive tick series when the plan is below mega", async () => {
    const origKey = process.env.INSIGHTSENTRY_API_KEY;
    process.env.INSIGHTSENTRY_API_KEY = jwt({ uuid: "user@example.com", plan: "ultra" });
    try {
      const questions: string[] = [];
      let requestedParams: Record<string, any> | undefined;

      await runCli(
        ["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--bar_type", "tick", "--dp", "1"],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => {
            questions.push(question);
            if (question.startsWith("Bar Type")) return "day";
            return "";
          },
          request: async (_method, _path, params) => {
            requestedParams = params;
            return { ok: true };
          },
        },
      );

      assert.ok(output.includes("Invalid Bar Type"));
      assert.ok(output.includes("Mega or Enterprise plan"));
      assert.ok(questions.some((question) => question.startsWith("Bar Type")));
      assert.equal(requestedParams?.bar_type, "day");
      assert.equal(exitCode, undefined);
    } finally {
      if (origKey === undefined) {
        delete process.env.INSIGHTSENTRY_API_KEY;
      } else {
        process.env.INSIGHTSENTRY_API_KEY = origKey;
      }
    }
  });

  it("rejects non-interactive tick series before request when the plan is below mega", async () => {
    const origKey = process.env.INSIGHTSENTRY_API_KEY;
    process.env.INSIGHTSENTRY_API_KEY = jwt({ uuid: "user@example.com", plan: "ultra" });
    try {
      let called = false;

      await runCli(
        ["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--bar_type", "tick", "--dp", "1"],
        {
          write,
          exit,
          request: async () => {
            called = true;
            return { ok: true };
          },
        },
      );

      assert.ok(output.includes("Invalid Bar Type"));
      assert.ok(output.includes("Mega or Enterprise plan"));
      assert.equal(called, false);
      assert.equal(exitCode, 1);
    } finally {
      if (origKey === undefined) {
        delete process.env.INSIGHTSENTRY_API_KEY;
      } else {
        process.env.INSIGHTSENTRY_API_KEY = origKey;
      }
    }
  });

  it("allows screener max_range values that the API gateway clamps", async () => {
    const calls: Record<string, any>[] = [];

    await runCli(["screen_stocks", "--fields", "close", "--max_range", "10"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => {
        calls.push(params);
        return { data: [] };
      },
    });

    assert.deepEqual(calls, [{ fields: ["close"], max_range: 10 }]);
    assert.deepEqual(JSON.parse(output), { data: [] });
    assert.equal(exitCode, undefined);
  });

  it("validates symbol code format before calling the API", async () => {
    await runCli(["get_symbol_info", "--symbol", "AAPL"], {
      write,
      exit,
      request: async () => assert.fail("invalid symbol should fail before request"),
    });

    assert.ok(output.includes("Invalid Symbol"));
    assert.ok(output.includes("EXCHANGE:SYMBOL"));
    assert.equal(exitCode, 1);
  });

  it("validates comma-separated symbol codes before calling the API", async () => {
    await runCli(["get_quotes", "--codes", "NASDAQ:AAPL,AAPL"], {
      write,
      exit,
      request: async () => assert.fail("invalid codes should fail before request"),
    });

    assert.ok(output.includes("Invalid Codes"));
    assert.ok(output.includes("AAPL"));
    assert.equal(exitCode, 1);
  });

  it("allows option quote requests with only code before calling the API", async () => {
    await runCli(["get_options_quotes", "--code", "NASDAQ:AAPL"], {
      write,
      exit,
      request: async (_method, _pathTemplate, params) => params,
    });

    assert.deepEqual(JSON.parse(output), { code: "NASDAQ:AAPL" });
    assert.equal(exitCode, undefined);
  });

  it("reprompts when an interactive tool argument is invalid", async () => {
    const answers = ["daily", "minute"];
    const mockRequest = async (
      _method: string,
      _pathTemplate: string,
      params: Record<string, any>,
    ) => ({
      bar_type: params.bar_type,
    });

    await runCli(["get_symbol_history", "--symbol", "NASDAQ:AAPL", "--start_date", "2024-01"], {
      write,
      exit,
      request: mockRequest,
      isInteractive: true,
      prompt: async () => answers.shift() ?? "",
    });

    assert.ok(output.includes("Invalid Bar Type"));
    assert.ok(output.includes("second, minute, hour"));
    assert.ok(output.includes('"bar_type": "minute"'));
    assert.equal(exitCode, undefined);
  });

  it("fails on missing required tool arguments when non-interactive", async () => {
    await runCli(["get_symbol_info"], {
      write,
      exit,
      isInteractive: false,
      request: async () => assert.fail("missing required args should fail before request"),
    });

    assert.ok(output.includes("Missing required options for get_symbol_info: symbol"));
    assert.equal(exitCode, 1);
  });

  it("stores a normal tool response as JSON when requested", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "symbols.json");

    try {
      const mockRequest = async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] });
      await runCli(
        ["search_symbols", "--query", "apple", "--store", "json", "--output_file", outputFile],
        { write, exit, request: mockRequest },
      );

      assert.deepEqual(JSON.parse(output), { stored_file: outputFile, format: "json" });
      assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), {
        symbols: [{ code: "NASDAQ:AAPL" }],
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stores the original JSON response when filter is also provided", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "symbols.json");

    try {
      const mockRequest = async () => ({
        symbols: [
          { code: "NASDAQ:AAPL", name: "Apple" },
          { code: "NASDAQ:MSFT", name: "Microsoft" },
        ],
      });
      await runCli(
        [
          "search_symbols",
          "--query",
          "apple",
          "--filter",
          "symbols.code",
          "--store",
          "json",
          "--output_file",
          outputFile,
        ],
        { write, exit, request: mockRequest },
      );

      assert.deepEqual(JSON.parse(output), ["NASDAQ:AAPL", "NASDAQ:MSFT"]);
      assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), {
        symbols: [
          { code: "NASDAQ:AAPL", name: "Apple" },
          { code: "NASDAQ:MSFT", name: "Microsoft" },
        ],
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses request-specific filenames when storing to an output directory", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));

    try {
      const mockRequest = async (
        _method: string,
        _pathTemplate: string,
        params: Record<string, any>,
      ) => ({
        symbols: [{ code: `NASDAQ:${String(params.query).toUpperCase()}` }],
      });
      await runCli(
        ["search_symbols", "--query", "apple", "--store", "json", "--output_dir", outputDir],
        { write, exit, request: mockRequest },
      );
      output = "";
      await runCli(
        ["search_symbols", "--query", "tesla", "--store", "json", "--output_dir", outputDir],
        { write, exit, request: mockRequest },
      );

      const files = await readdir(outputDir);
      assert.equal(files.length, 2);
      assert.notEqual(files[0], files[1]);
      assert.ok(
        files.every((file) => file.startsWith("search_symbols_") && file.endsWith(".json")),
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stores get_symbol_series as CSV when requested", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "series.csv");

    try {
      const mockRequest = async () => ({
        code: "NASDAQ:AAPL",
        bar_type: "1D",
        series: [{ time: 1, close: 10 }],
      });
      await runCli(
        [
          "get_symbol_series",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "day",
          "--store",
          "csv",
          "--output_file",
          outputFile,
        ],
        { write, exit, request: mockRequest },
      );

      assert.deepEqual(JSON.parse(output), { stored_file: outputFile, format: "csv" });
      assert.equal(
        await readFile(outputFile, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("prompts for CSV storage for history tools in interactive mode", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "history.csv");
    const questions: string[] = [];

    try {
      const mockRequest = async () => ({
        code: "NASDAQ:AAPL",
        bar_type: "1m",
        series: [{ time: 1, close: 10 }],
      });
      await runCli(
        [
          "get_symbol_history",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "minute",
          "--start_date",
          "2024-01",
        ],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => {
            questions.push(question);
            if (question.includes("Store")) return "csv";
            if (question.includes("Output File")) return outputFile;
            return "";
          },
          request: mockRequest,
        },
      );

      assert.ok(questions.some((question) => question.includes("choices: none/json/csv")));
      assert.deepEqual(JSON.parse(output), { stored_file: outputFile, format: "csv" });
      assert.equal(
        await readFile(outputFile, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1m,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("prompts for an output file when storage is enabled interactively", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "series.csv");

    try {
      const mockRequest = async () => ({
        code: "NASDAQ:AAPL",
        bar_type: "1D",
        series: [{ time: 1, close: 10 }],
      });
      await runCli(
        ["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--bar_type", "day", "--store", "csv"],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => (question.includes("Output File") ? outputFile : ""),
          request: mockRequest,
        },
      );

      assert.deepEqual(JSON.parse(output), { stored_file: outputFile, format: "csv" });
      assert.equal(
        await readFile(outputFile, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reprompts for an invalid interactive storage output file", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const invalidOutputFile = await mkdtemp(path.join(outputDir, "not-a-file-"));
    const validOutputFile = path.join(outputDir, "series.csv");
    const outputFileAnswers = [invalidOutputFile, validOutputFile];
    let requestCount = 0;

    try {
      const mockRequest = async () => {
        requestCount += 1;
        return {
          code: "NASDAQ:AAPL",
          bar_type: "1D",
          series: [{ time: 1, close: 10 }],
        };
      };
      await runCli(
        ["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--bar_type", "day", "--store", "csv"],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) =>
            question.includes("Output File") ? (outputFileAnswers.shift() ?? "") : "",
          request: mockRequest,
        },
      );

      assert.equal(requestCount, 1);
      assert.ok(output.includes("Invalid Output File"));
      const parsed = JSON.parse(output.slice(output.indexOf("{")));
      assert.deepEqual(parsed, { stored_file: validOutputFile, format: "csv" });
      assert.equal(
        await readFile(validOutputFile, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("requires and reprompts for interactive storage output directory when output file is skipped", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const invalidOutputDir = path.join(outputDir, "not-a-dir");
    const validOutputDir = path.join(outputDir, "stored");
    const outputDirAnswers = [invalidOutputDir, validOutputDir];
    const questions: string[] = [];
    let requestCount = 0;

    try {
      await writeFile(invalidOutputDir, "not a directory");
      const mockRequest = async () => {
        requestCount += 1;
        return {
          code: "NASDAQ:AAPL",
          bar_type: "1D",
          series: [{ time: 1, close: 10 }],
        };
      };
      await runCli(
        ["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--bar_type", "day", "--store", "csv"],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => {
            questions.push(question);
            if (question.includes("Output File")) return "";
            if (question.includes("Output Dir")) return outputDirAnswers.shift() ?? "";
            return "";
          },
          request: mockRequest,
        },
      );

      assert.equal(requestCount, 1);
      assert.ok(output.includes("Invalid Output Dir"));
      assert.ok(questions.some((question) => question.includes("Output Dir (required")));
      const parsed = JSON.parse(output.slice(output.indexOf("{")));
      assert.equal(parsed.format, "csv");
      assert.ok(parsed.stored_file.startsWith(validOutputDir));
      assert.deepEqual(await readdir(validOutputDir), [path.basename(parsed.stored_file)]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails before request when storage destination is missing non-interactively", async () => {
    await runCli(
      ["get_symbol_series", "--symbol", "NASDAQ:AAPL", "--bar_type", "day", "--store", "csv"],
      {
        write,
        exit,
        isInteractive: false,
        request: async () => assert.fail("missing storage destination should fail before request"),
      },
    );

    assert.ok(output.includes("output_file or output_dir is required"));
    assert.equal(exitCode, 1);
  });

  it("stores the original series CSV when filter is also provided", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "series.csv");

    try {
      const mockRequest = async () => ({
        code: "NASDAQ:AAPL",
        bar_type: "1D",
        series: [{ time: 1, close: 10 }],
      });
      await runCli(
        [
          "get_symbol_series",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "day",
          "--filter",
          "series.close",
          "--store",
          "csv",
          "--output_file",
          outputFile,
        ],
        { write, exit, request: mockRequest },
      );

      assert.equal(JSON.parse(output), 10);
      assert.equal(
        await readFile(outputFile, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects CSV storage for non-series tools before calling the API", async () => {
    await runCli(
      ["search_symbols", "--query", "apple", "--store", "csv", "--output_file", "symbols.csv"],
      {
        write,
        exit,
        request: async () => assert.fail("CSV storage should be rejected before request"),
      },
    );

    assert.ok(
      output.includes("csv storage is only supported for get_symbol_series and get_symbol_history"),
    );
    assert.equal(exitCode, 1);
  });

  it("downloads history through the built-in command", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const progress: string[] = [];
    try {
      await runCli(
        [
          "download_history",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "minute",
          "--from",
          "2024-01",
          "--to",
          "2024-01",
          "--output_dir",
          outputDir,
          "--format",
          "json",
          "--merge",
          "true",
        ],
        {
          write,
          exit,
          progress: (message) => progress.push(message),
          request: async () => ({ series: [{ time: 1, close: 10 }] }),
        },
      );

      const parsed = JSON.parse(output);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.completed, 1);
      assert.equal(parsed.failed, 0);
      assert.ok(progress.some((message) => message.includes("saved NASDAQ:AAPL 2024-01")));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reports missing download_history options before auth in non-interactive mode", async () => {
    const origKey = process.env.INSIGHTSENTRY_API_KEY;
    delete process.env.INSIGHTSENTRY_API_KEY;
    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: false,
      });
    } finally {
      if (origKey !== undefined) process.env.INSIGHTSENTRY_API_KEY = origKey;
    }

    assert.ok(output.includes("Missing required options for download_history"));
    assert.ok(output.includes("symbol, bar_type, from, to, output_dir"));
    assert.ok(!output.includes("No API key found"));
    assert.equal(exitCode, 1);
  });

  it("prompts for missing download_history arguments when interactive", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const questions: string[] = [];

    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        prompt: async (question) => {
          questions.push(question);
          if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
          if (question.startsWith("Bar type")) return "minute";
          if (question.startsWith("From")) return "2024-01";
          if (question.startsWith("To")) return "2024-01";
          if (question.startsWith("Output directory")) return outputDir;
          return "";
        },
        request: async () => ({
          code: "NASDAQ:AAPL",
          bar_type: "1m",
          series: [{ time: 1, close: 10 }],
        }),
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.failed, 0);
      assert.ok(parsed.merged_file.endsWith("merged.csv"));
      assert.ok(
        questions.some(
          (question) =>
            question.includes(
              "Bar type: Bar type. second/minute/hour use /history; day/week/month use /series.",
            ) &&
            question.includes("Bar type (required, choices: second/minute/hour/day/week/month):"),
        ),
      );
      assert.ok(!questions.some((question) => question.includes("Filter")));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("defaults the interactive download_history to month to the current month", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const questions: string[] = [];
    const { month: currentMonth } = utcDateParts();

    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        prompt: async (question) => {
          questions.push(question);
          if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
          if (question.startsWith("Bar type")) return "minute";
          if (question.startsWith("From")) return currentMonth;
          if (question.startsWith("To")) return "";
          if (question.startsWith("Output directory")) return outputDir;
          return "";
        },
        request: async (_method, _pathTemplate, params) => {
          assert.equal(params.start_date, currentMonth);
          return {
            code: "NASDAQ:AAPL",
            bar_type: "1m",
            series: [{ time: 1, close: 10 }],
          };
        },
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.failed, 0);
      assert.ok(
        questions.some(
          (question) =>
            question.startsWith("To") &&
            question.includes(`Default: ${currentMonth}`) &&
            question.includes("press Enter to use default"),
        ),
      );
      assert.equal(exitCode, undefined);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("defaults the interactive download_history second to the current date", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const progress: string[] = [];
    const { day: currentDay } = utcDateParts();

    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        progress: (message) => progress.push(message),
        prompt: async (question) => {
          if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
          if (question.startsWith("Bar type")) return "second";
          if (question.startsWith("From")) return currentDay;
          if (question.startsWith("To")) return "";
          if (question.startsWith("Output directory")) return outputDir;
          return "";
        },
        request: async (_method, _pathTemplate, params) => {
          assert.equal(params.start_date, currentDay);
          return {
            code: "NASDAQ:AAPL",
            bar_type: "1S",
            series: [{ time: 1, close: 10 }],
          };
        },
      });

      const parsed = JSON.parse(output);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.failed, 0);
      assert.ok(progress.some((message) => message.includes(`saved NASDAQ:AAPL ${currentDay}`)));
      assert.equal(exitCode, undefined);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("ignores filter for download_history", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    try {
      await runCli(
        [
          "download_history",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "day",
          "--from",
          "2024-01",
          "--to",
          "2024-02",
          "--output_dir",
          outputDir,
          "--filter",
          "series.close",
        ],
        {
          write,
          exit,
          isInteractive: true,
          request: async (_method, _path, params) => {
            assert.equal(params.filter, undefined);
            return { code: "NASDAQ:AAPL", series: [{ time: 1, close: 10 }] };
          },
        },
      );

      const parsed = JSON.parse(output);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.failed, 0);
      assert.ok(!output.includes("Unsupported download_history option"));
      assert.equal(exitCode, undefined);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reprompts for an invalid interactive download_history output directory", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const invalidOutputDir = path.join(tempDir, "not-a-directory");
    const validOutputDir = path.join(tempDir, "valid-output");
    const outputDirAnswers = [invalidOutputDir, validOutputDir];
    let requestCount = 0;

    try {
      await writeFile(invalidOutputDir, "not a directory", "utf8");
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        prompt: async (question) => {
          if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
          if (question.startsWith("Bar type")) return "minute";
          if (question.startsWith("From")) return "2024-01";
          if (question.startsWith("To")) return "2024-01";
          if (question.startsWith("Output directory")) return outputDirAnswers.shift() ?? "";
          return "";
        },
        request: async () => {
          requestCount += 1;
          return {
            code: "NASDAQ:AAPL",
            bar_type: "1m",
            series: [{ time: 1, close: 10 }],
          };
        },
      });

      assert.equal(requestCount, 1);
      assert.ok(output.includes("Invalid Output directory"));
      const parsed = JSON.parse(output.slice(output.indexOf("{")));
      assert.equal(parsed.output_dir, path.resolve(validOutputDir));
      assert.equal(parsed.failed, 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prompts for optional download_history arguments in interactive mode", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const questions: string[] = [];

    try {
      await runCli(
        [
          "download_history",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "minute",
          "--from",
          "2024-01",
          "--to",
          "2024-01",
          "--output_dir",
          outputDir,
        ],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => {
            questions.push(question);
            if (question.includes("Format")) return "json";
            if (question.includes("Split")) return "false";
            if (question.includes("Extended")) return "true";
            return "";
          },
          request: async (_method, _pathTemplate, params) => ({
            code: params.symbol,
            format: params.format,
            split: params.split,
            extended: params.extended,
            bar_type: "1m",
            series: [{ time: 1, close: 10 }],
          }),
        },
      );

      const parsed = JSON.parse(output);
      assert.equal(parsed.failed, 0);
      assert.equal(parsed.merged_file, undefined);
      assert.ok(parsed.files.every((file: string) => file.endsWith(".json")));
      assert.ok(questions.some((question) => question.includes("Format")));
      assert.ok(questions.some((question) => question.includes("Default: csv")));
      assert.ok(!questions.some((question) => question.includes("Merge")));
      assert.ok(!questions.some((question) => question.includes("Keep chunks")));
      assert.ok(questions.some((question) => question.includes("Split")));
      assert.ok(questions.some((question) => question.includes("Extended")));
      assert.ok(!questions.some((question) => question.includes("Dadj")));
      assert.ok(!questions.some((question) => question.includes("Badj")));
      assert.ok(!questions.some((question) => question.includes("Settlement")));
      assert.ok(!questions.some((question) => question.includes("Contract lookback months")));
      assert.ok(questions.some((question) => question.includes("Default: false")));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("skips symbol-incompatible download_history prompts in interactive mode", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const questions: string[] = [];

    try {
      await runCli(
        [
          "download_history",
          "--symbol",
          "CME_MINI:NQ1!",
          "--bar_type",
          "hour",
          "--from",
          "2024-01",
          "--to",
          "2024-01",
          "--output_dir",
          outputDir,
          "--format",
          "json",
          "--merge",
          "false",
        ],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => {
            questions.push(question);
            if (question.includes("Contract lookback months")) return "3";
            if (question.includes("Badj")) return "true";
            if (question.includes("Settlement")) return "true";
            return "";
          },
          request: async (_method, pathTemplate, params) => {
            if (pathTemplate.includes("/contracts")) {
              return {
                base_code: "CME_MINI:NQ",
                contracts: [{ code: "CME_MINI:NQF2024", settlement_date: "20240119" }],
              };
            }
            return {
              code: params.symbol,
              badj: params.badj,
              settlement: params.settlement,
              bar_type: "1h",
              series: [{ time: 1, close: 10 }],
            };
          },
        },
      );

      const parsed = JSON.parse(output);
      assert.equal(parsed.failed, 0);
      assert.ok(!questions.some((question) => question.includes("Extended")));
      assert.ok(!questions.some((question) => question.includes("Split")));
      assert.ok(!questions.some((question) => question.includes("Dadj")));
      assert.ok(questions.some((question) => question.includes("Contract lookback months")));
      assert.ok(questions.some((question) => question.includes("Badj")));
      assert.ok(questions.some((question) => question.includes("Settlement")));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("validates download_history symbol format before planning requests", async () => {
    await runCli(
      [
        "download_history",
        "--symbol",
        "AAPL",
        "--bar_type",
        "minute",
        "--from",
        "2024-01",
        "--to",
        "2024-01",
        "--output_dir",
        ".",
      ],
      {
        write,
        exit,
        request: async () => assert.fail("invalid symbol should fail before request"),
      },
    );

    assert.ok(output.includes("Invalid Symbol"));
    assert.ok(output.includes("EXCHANGE:SYMBOL"));
    assert.equal(exitCode, 1);
  });

  it("reprompts when an interactive download_history argument is invalid", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const barTypes = ["daily", "minute"];

    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        prompt: async (question) => {
          if (question.startsWith("Symbol")) return "NASDAQ:AAPL";
          if (question.startsWith("Bar type")) return barTypes.shift() ?? "";
          if (question.startsWith("From")) return "2024-01";
          if (question.startsWith("To")) return "2024-01";
          if (question.startsWith("Output directory")) return outputDir;
          return "";
        },
        request: async () => ({
          code: "NASDAQ:AAPL",
          bar_type: "1m",
          series: [{ time: 1, close: 10 }],
        }),
      });

      assert.ok(output.includes("Invalid Bar type"));
      assert.ok(output.includes("second, minute, hour, day, week, month"));
      const parsed = JSON.parse(output.slice(output.indexOf("{")));
      assert.equal(parsed.failed, 0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reprompts invalid provided download_history arguments when interactive", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const barTypes = ["minute"];

    try {
      await runCli(
        [
          "download_history",
          "--symbol",
          "NASDAQ:AAPL",
          "--bar_type",
          "daily",
          "--from",
          "2024-01",
          "--to",
          "2024-01",
          "--output_dir",
          outputDir,
          "--format",
          "json",
        ],
        {
          write,
          exit,
          isInteractive: true,
          prompt: async (question) => {
            if (question.startsWith("Bar type")) return barTypes.shift() ?? "";
            return "";
          },
          request: async () => ({
            code: "NASDAQ:AAPL",
            bar_type: "1m",
            series: [{ time: 1, close: 10 }],
          }),
        },
      );

      assert.ok(output.includes("Invalid Bar type"));
      const parsed = JSON.parse(output.slice(output.indexOf("{")));
      assert.equal(parsed.failed, 0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails on missing download_history arguments when non-interactive", async () => {
    await runCli(["download_history"], {
      write,
      exit,
      isInteractive: false,
      request: async () => assert.fail("missing required args should fail before request"),
    });

    assert.ok(output.includes("Missing required options"));
    assert.equal(exitCode, 1);
  });

  it("applies JSONata filter", async () => {
    const mockRequest = async () => ({
      symbols: [
        { code: "NASDAQ:AAPL", name: "Apple" },
        { code: "NASDAQ:MSFT", name: "Microsoft" },
      ],
    });
    await runCli(["search_symbols", "--query", "a", "--filter", "symbols.code"], {
      write,
      exit,
      request: mockRequest,
    });
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, ["NASDAQ:AAPL", "NASDAQ:MSFT"]);
  });

  it("handles API errors", async () => {
    const mockRequest = async () => {
      throw new Error("API error (401): Unauthorized");
    };
    await runCli(["search_symbols", "--query", "x"], { write, exit, request: mockRequest });
    assert.ok(output.includes("Unauthorized"));
    assert.equal(exitCode, 1);
  });
});
