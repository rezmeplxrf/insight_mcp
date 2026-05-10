import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runApiTool, type ApiToolRequestFn } from "../src/tool-runner.js";

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
      assert.equal(await readFile(outputFile, "utf8"), "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid storage before calling the API", async () => {
    const request: ApiToolRequestFn = async () => assert.fail("invalid storage should fail before request");

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
});
