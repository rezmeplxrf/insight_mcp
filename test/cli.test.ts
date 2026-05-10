import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { buildHelp, buildToolHelp, coerceArgs, parseArgs, runCli } from "../src/cli.js";
import { type ToolDefinition, toolDefinitions } from "../src/tool-definitions.js";

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
  const write = (s: string) => {
    output += s;
  };
  const exit = (code: number) => {
    exitCode = code;
  };

  beforeEach(() => {
    output = "";
    exitCode = undefined;
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

  it("shows tool help with tool --help", async () => {
    await runCli(["get_quotes", "--help"], { write, exit });
    assert.ok(output.includes("--codes"));
    assert.equal(exitCode, 0);
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

  it("login without key shows usage when non-interactive", async () => {
    await runCli(["login"], { write, exit, isInteractive: false });
    assert.ok(output.includes("insight login --key"));
    assert.equal(exitCode, 1);
  });

  it("login with key saves config", async () => {
    await runCli(["login", "--key", "test-jwt-key"], { write, exit });
    assert.ok(output.includes("API key saved"));
    assert.equal(exitCode, 0);
  });

  it("login prompts for key when interactive", async () => {
    const answers = new Map([["API key: ", "interactive-jwt-key"]]);

    await runCli(["login"], {
      write,
      exit,
      isInteractive: true,
      prompt: async (question) => answers.get(question) ?? "",
    });

    assert.ok(output.includes("API key saved"));
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

  it("calls API and outputs JSON", async () => {
    const mockRequest = async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] });
    await runCli(["search_symbols", "--query", "apple"], { write, exit, request: mockRequest });
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, { symbols: [{ code: "NASDAQ:AAPL" }] });
    assert.equal(exitCode, undefined);
  });

  it("prompts for missing required tool arguments when interactive", async () => {
    const answers = new Map([["Symbol: ", "NASDAQ:AAPL"]]);
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
      prompt: async (question) => answers.get(question) ?? "",
    });

    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, { code: "NASDAQ:AAPL" });
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

  it("prompts for an output file when storage is enabled interactively", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-store-"));
    const outputFile = path.join(outputDir, "series.csv");
    const answers = new Map([["Output file: ", outputFile]]);

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
          prompt: async (question) => answers.get(question) ?? "",
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

    assert.ok(output.includes("csv storage is only supported for get_symbol_series"));
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

  it("prompts for missing download_history arguments when interactive", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const answers = new Map([
      ["Symbol: ", "NASDAQ:AAPL"],
      ["Bar type (second/minute/hour/day/week/month): ", "minute"],
      ["From (YYYY-MM or YYYY-MM-DD): ", "2024-01"],
      ["To (YYYY-MM or YYYY-MM-DD): ", "2024-01"],
      ["Output directory: ", outputDir],
    ]);

    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        prompt: async (question) => answers.get(question) ?? "",
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
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reprompts when an interactive download_history argument is invalid", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-cli-history-"));
    const barTypes = ["daily", "minute"];
    const answers = new Map([
      ["Symbol: ", "NASDAQ:AAPL"],
      ["From (YYYY-MM or YYYY-MM-DD): ", "2024-01"],
      ["To (YYYY-MM or YYYY-MM-DD): ", "2024-01"],
      ["Output directory: ", outputDir],
    ]);

    try {
      await runCli(["download_history"], {
        write,
        exit,
        isInteractive: true,
        prompt: async (question) => {
          if (question === "Bar type (second/minute/hour/day/week/month): ") {
            return barTypes.shift() ?? "";
          }
          return answers.get(question) ?? "";
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
