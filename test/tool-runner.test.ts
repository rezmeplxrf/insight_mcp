import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { type ApiToolRequestFn, runApiTool } from "../src/tool-runner.js";

describe("tool runner", () => {
  it("returns the raw response when storage and filter are not requested", async () => {
    const result = await runApiTool({
      toolName: "search_symbols",
      method: "GET",
      pathTemplate: "/symbols",
      args: { query: "apple" },
      request: async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] }),
    });

    assert.deepEqual(result, { symbols: [{ code: "NASDAQ:AAPL" }] });
  });

  it("stores the original JSON response and returns a storage summary", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const outputFile = path.join(outputDir, "symbols.json");

    try {
      const result = await runApiTool({
        toolName: "search_symbols",
        method: "GET",
        pathTemplate: "/symbols",
        args: { query: "apple", store: "json", output_file: outputFile },
        request: async () => ({ symbols: [{ code: "NASDAQ:AAPL" }] }),
      });

      assert.deepEqual(result, { stored_file: outputFile, format: "json" });
      assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), {
        symbols: [{ code: "NASDAQ:AAPL" }],
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stores the original response but returns filtered data when filter is provided", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const outputFile = path.join(outputDir, "symbols.json");

    try {
      const result = await runApiTool({
        toolName: "search_symbols",
        method: "GET",
        pathTemplate: "/symbols",
        args: {
          query: "apple",
          filter: "symbols.code",
          store: "json",
          output_file: outputFile,
        },
        request: async () => ({
          symbols: [
            { code: "NASDAQ:AAPL", name: "Apple" },
            { code: "NASDAQ:MSFT", name: "Microsoft" },
          ],
        }),
      });

      assert.deepEqual(JSON.parse(JSON.stringify(result)), ["NASDAQ:AAPL", "NASDAQ:MSFT"]);
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

  it("rejects invalid filters before calling the API or writing storage", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const outputFile = path.join(outputDir, "symbols.json");
    const request: ApiToolRequestFn = async () =>
      assert.fail("invalid filter should fail before request");

    try {
      await assert.rejects(
        () =>
          runApiTool({
            toolName: "search_symbols",
            method: "GET",
            pathTemplate: "/symbols",
            args: {
              query: "apple",
              filter: "symbols[",
              store: "json",
              output_file: outputFile,
            },
            request,
          }),
        /filter/i,
      );
      await assert.rejects(() => readFile(outputFile, "utf8"), /ENOENT/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stores the original response in .tmp/insight when filtered data is empty", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const cwd = process.cwd();

    try {
      process.chdir(tempDir);
      const result = await runApiTool({
        toolName: "search_symbols",
        method: "GET",
        pathTemplate: "/symbols",
        args: {
          query: "apple",
          filter: "symbols[code='NASDAQ:MSFT']",
        },
        request: async () => ({
          symbols: [{ code: "NASDAQ:AAPL", name: "Apple" }],
        }),
      });

      assert.equal(result.filtered, null);
      assert.ok(result.message.includes("Filtered data is empty"));
      assert.ok(result.original_response_file.includes(path.join(".tmp", "insight")));
      assert.deepEqual(JSON.parse(await readFile(result.original_response_file, "utf8")), {
        symbols: [{ code: "NASDAQ:AAPL", name: "Apple" }],
      });
    } finally {
      process.chdir(cwd);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the requested storage path when filtered stored data is empty", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const outputFile = path.join(outputDir, "symbols.json");

    try {
      const result = await runApiTool({
        toolName: "search_symbols",
        method: "GET",
        pathTemplate: "/symbols",
        args: {
          query: "apple",
          filter: "symbols[code='NASDAQ:MSFT']",
          store: "json",
          output_file: outputFile,
        },
        request: async () => ({
          symbols: [{ code: "NASDAQ:AAPL", name: "Apple" }],
        }),
      });

      assert.equal(result.filtered, null);
      assert.equal(result.original_response_file, outputFile);
      assert.ok(result.message.includes(outputFile));
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stores series CSV and returns filtered data when requested", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const outputFile = path.join(outputDir, "series.csv");

    try {
      const result = await runApiTool({
        toolName: "get_symbol_series",
        method: "GET",
        pathTemplate: "/symbols/{symbol}/series",
        args: {
          symbol: "NASDAQ:AAPL",
          bar_type: "day",
          filter: "series.close",
          store: "csv",
          output_file: outputFile,
        },
        request: async () => ({
          code: "NASDAQ:AAPL",
          bar_type: "1D",
          series: [{ time: 1, close: 10 }],
        }),
      });

      assert.equal(result, 10);
      assert.equal(
        await readFile(outputFile, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid storage before calling the API", async () => {
    const request: ApiToolRequestFn = async () =>
      assert.fail("invalid storage should fail before request");

    await assert.rejects(
      () =>
        runApiTool({
          toolName: "search_symbols",
          method: "GET",
          pathTemplate: "/symbols",
          args: { query: "apple", store: "csv", output_file: "symbols.csv" },
          request,
        }),
      /csv storage is only supported for get_symbol_series/,
    );
  });

  it("rejects invalid storage targets before calling the API", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "insight-runner-"));
    const outputDirFile = path.join(tempDir, "not-a-directory");
    const request: ApiToolRequestFn = async () =>
      assert.fail("invalid storage target should fail before request");

    try {
      await writeFile(outputDirFile, "not a directory", "utf8");

      await assert.rejects(
        () =>
          runApiTool({
            toolName: "search_symbols",
            method: "GET",
            pathTemplate: "/symbols",
            args: {
              query: "apple",
              store: "json",
              output_dir: outputDirFile,
            },
            request,
          }),
        /storage target is not writable/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid symbol codes before calling the API", async () => {
    const request: ApiToolRequestFn = async () =>
      assert.fail("invalid symbol should fail before request");

    await assert.rejects(
      () =>
        runApiTool({
          toolName: "get_symbol_info",
          method: "GET",
          pathTemplate: "/symbols/{symbol}/info",
          args: { symbol: "AAPL" },
          request,
        }),
      /Invalid symbol: expected EXCHANGE:SYMBOL format/,
    );
  });

  it("rejects invalid comma-separated quote codes before calling the API", async () => {
    const request: ApiToolRequestFn = async () =>
      assert.fail("invalid codes should fail before request");

    await assert.rejects(
      () =>
        runApiTool({
          toolName: "get_quotes",
          method: "GET",
          pathTemplate: "/symbols/quotes",
          args: { codes: "NASDAQ:AAPL,AAPL" },
          request,
        }),
      /Invalid codes: AAPL: expected EXCHANGE:SYMBOL format/,
    );
  });

  it("rejects history bar intervals unsupported by the selected bar type before request", async () => {
    const request: ApiToolRequestFn = async () =>
      assert.fail("invalid interval should fail before request");

    await assert.rejects(
      () =>
        runApiTool({
          toolName: "get_symbol_history",
          method: "GET",
          pathTemplate: "/symbols/{symbol}/history",
          args: {
            symbol: "NASDAQ:AAPL",
            bar_type: "hour",
            start_date: "2024-01",
            bar_interval: 25,
          },
          request,
        }),
      /Invalid bar_interval: bar_interval for hour bars must be between 1 and 24/,
    );
  });
});
