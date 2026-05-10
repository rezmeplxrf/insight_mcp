import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { storeResponse, validateResponseStorage } from "../src/response-storage.js";

describe("response storage", () => {
  it("returns null when storage is not requested", async () => {
    const result = await storeResponse({ ok: true }, { toolName: "search_symbols" });
    assert.equal(result, null);
  });

  it("stores JSON using request-specific filenames", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-store-"));

    try {
      const first = await storeResponse(
        { symbols: [{ code: "NASDAQ:AAPL" }] },
        { toolName: "search_symbols", store: "json", output_dir: outputDir, requestParams: { query: "apple" } },
      );
      const second = await storeResponse(
        { symbols: [{ code: "NASDAQ:TSLA" }] },
        { toolName: "search_symbols", store: "json", output_dir: outputDir, requestParams: { query: "tesla" } },
      );

      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.stored_file, second.stored_file);
      assert.deepEqual(JSON.parse(await readFile(first.stored_file, "utf8")), {
        symbols: [{ code: "NASDAQ:AAPL" }],
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite repeated output directory requests with identical params", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-store-"));

    try {
      const options = {
        toolName: "search_symbols",
        store: "json" as const,
        output_dir: outputDir,
        requestParams: { query: "apple" },
      };
      const first = await storeResponse({ symbols: [{ code: "NASDAQ:AAPL" }] }, options);
      const second = await storeResponse({ symbols: [{ code: "NASDAQ:AAPL" }] }, options);

      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.stored_file, second.stored_file);
      assert.ok(second.stored_file.endsWith("-1.json"));
      assert.deepEqual(JSON.parse(await readFile(first.stored_file, "utf8")), {
        symbols: [{ code: "NASDAQ:AAPL" }],
      });
      assert.deepEqual(JSON.parse(await readFile(second.stored_file, "utf8")), {
        symbols: [{ code: "NASDAQ:AAPL" }],
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("stores series CSV for the shared CLI/MCP storage path", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-store-"));

    try {
      const stored = await storeResponse(
        { code: "NASDAQ:AAPL", bar_type: "1D", series: [{ time: 1, close: 10 }] },
        {
          toolName: "get_symbol_series",
          store: "csv",
          output_dir: outputDir,
          requestParams: { symbol: "NASDAQ:AAPL", bar_type: "day" },
        },
      );

      assert.ok(stored);
      assert.equal(await readFile(stored.stored_file, "utf8"), "code,bar_type,time,close\nNASDAQ:AAPL,1D,1,10\n");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects CSV storage for non-series tools", () => {
    assert.throws(
      () => validateResponseStorage({ toolName: "search_symbols", store: "csv", output_file: "symbols.csv" }),
      /csv storage is only supported for get_symbol_series/,
    );
  });
});
