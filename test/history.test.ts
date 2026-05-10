import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { downloadHistory, planHistoryRequests, responseToCsv } from "../src/history.js";

function requireMergedFile(result: { merged_file?: string }): string {
  assert.ok(result.merged_file);
  return result.merged_file;
}

describe("planHistoryRequests", () => {
  it("plans one monthly request per month for minute and hour history", async () => {
    const plan = await planHistoryRequests(
      {
        symbol: "NASDAQ:AAPL",
        from: "2024-01-15",
        to: "2024-03-02",
        bar_type: "minute",
        output_dir: "data",
      },
      { request: async () => assert.fail("regular symbols should not fetch contracts") },
    );

    assert.deepEqual(
      plan.requests.map((request) => request.params.start_date),
      ["2024-01", "2024-02", "2024-03"],
    );
    assert.equal(plan.mode, "regular");
  });

  it("plans one daily request per day for second history", async () => {
    const plan = await planHistoryRequests(
      {
        symbol: "NASDAQ:AAPL",
        from: "2024-06-01",
        to: "2024-06-03",
        bar_type: "second",
        output_dir: "data",
      },
      { request: async () => assert.fail("regular symbols should not fetch contracts") },
    );

    assert.deepEqual(
      plan.requests.map((request) => request.params.start_date),
      ["2024-06-01", "2024-06-02", "2024-06-03"],
    );
  });

  it("auto-expands continuous futures ending in 1! into specific contracts", async () => {
    const plan = await planHistoryRequests(
      {
        symbol: "CME_MINI:NQ1!",
        from: "2026-01",
        to: "2026-02",
        bar_type: "hour",
        output_dir: "data",
        contract_lookback_months: 3,
      },
      {
        request: async (method, pathTemplate, params) => {
          assert.equal(method, "GET");
          assert.equal(pathTemplate, "/v3/symbols/{symbol}/contracts");
          assert.deepEqual(params, { symbol: "CME_MINI:NQ1!" });
          return {
            base_code: "CME_MINI:NQ",
            contracts: [
              { code: "NQH2026", settlement_date: "20260320" },
              { code: "NQM2026", settlement_date: "20260619" },
            ],
          };
        },
      },
    );

    assert.equal(plan.mode, "futures");
    assert.deepEqual(
      plan.requests.map((request) => ({
        symbol: request.params.symbol,
        start_date: request.params.start_date,
      })),
      [
        { symbol: "CME_MINI:NQH2026", start_date: "2026-01" },
        { symbol: "CME_MINI:NQH2026", start_date: "2026-02" },
      ],
    );
  });

  it("auto-expands continuous futures ending in 2! into specific contracts", async () => {
    const plan = await planHistoryRequests(
      {
        symbol: "CME_MINI:NQ2!",
        from: "2026-01",
        to: "2026-01",
        bar_type: "hour",
        output_dir: "data",
        contract_lookback_months: 3,
      },
      {
        request: async (_method, _pathTemplate, params) => {
          assert.deepEqual(params, { symbol: "CME_MINI:NQ2!" });
          return {
            base_code: "CME_MINI:NQ",
            contracts: [{ code: "NQH2026", settlement_date: "20260320" }],
          };
        },
      },
    );

    assert.equal(plan.mode, "futures");
    assert.deepEqual(
      plan.requests.map((request) => request.params.symbol),
      ["CME_MINI:NQH2026"],
    );
  });

  it("passes only API-supported optional history query params", async () => {
    const plan = await planHistoryRequests(
      {
        symbol: "NASDAQ:AAPL",
        from: "2024-01",
        to: "2024-01",
        bar_type: "minute",
        output_dir: "data",
        bar_interval: 5,
        extended: false,
        dadj: true,
        badj: false,
        split: false,
        settlement: true,
      },
      { request: async () => assert.fail("regular symbols should not fetch contracts") },
    );

    assert.deepEqual(plan.requests[0].params, {
      symbol: "NASDAQ:AAPL",
      bar_type: "minute",
      start_date: "2024-01",
      bar_interval: 5,
      extended: false,
      dadj: true,
      badj: false,
      split: false,
      settlement: true,
    });
  });

  it("routes day/week/month downloads through /series with one request", async () => {
    for (const bar_type of ["day", "week", "month"] as const) {
      const plan = await planHistoryRequests(
        {
          symbol: "NASDAQ:AAPL",
          from: "2020-01-01",
          to: "2024-12-31",
          bar_type,
          output_dir: "data",
        },
        { request: async () => assert.fail("regular series symbols should not fetch contracts") },
      );

      assert.equal(plan.mode, "regular");
      assert.deepEqual(
        plan.requests.map((request) => request.params),
        [
          {
            symbol: "NASDAQ:AAPL",
            bar_type,
            dp: 30000,
          },
        ],
      );
    }
  });

  it("rejects invalid date shapes instead of truncating them", async () => {
    await assert.rejects(
      () =>
        planHistoryRequests(
          {
            symbol: "NASDAQ:AAPL",
            from: "2024-02-99",
            to: "2024-03",
            bar_type: "minute",
            output_dir: "data",
          },
          { request: async () => assert.fail("regular symbols should not fetch contracts") },
        ),
      /Invalid day/,
    );

    await assert.rejects(
      () =>
        planHistoryRequests(
          {
            symbol: "NASDAQ:AAPL",
            from: "2024-13",
            to: "2024-13",
            bar_type: "second",
            output_dir: "data",
          },
          { request: async () => assert.fail("regular symbols should not fetch contracts") },
        ),
      /Invalid month/,
    );
  });

  it("rejects bar intervals above the /history schema limit", async () => {
    await assert.rejects(
      () =>
        planHistoryRequests(
          {
            symbol: "NASDAQ:AAPL",
            from: "2024-01",
            to: "2024-01",
            bar_type: "minute",
            bar_interval: 1441,
            output_dir: "data",
          },
          { request: async () => assert.fail("regular symbols should not fetch contracts") },
        ),
      /bar_interval/,
    );
  });

  it("rejects bar intervals unsupported by the selected history bar type", async () => {
    await assert.rejects(
      () =>
        planHistoryRequests(
          {
            symbol: "NASDAQ:AAPL",
            from: "2024-01-01",
            to: "2024-01-01",
            bar_type: "second",
            bar_interval: 2,
            output_dir: "data",
          },
          { request: async () => assert.fail("regular symbols should not fetch contracts") },
        ),
      /second.*1, 5, 10, 15, 30, 45/,
    );

    await assert.rejects(
      () =>
        planHistoryRequests(
          {
            symbol: "NASDAQ:AAPL",
            from: "2024-01",
            to: "2024-01",
            bar_type: "hour",
            bar_interval: 25,
            output_dir: "data",
          },
          { request: async () => assert.fail("regular symbols should not fetch contracts") },
        ),
      /hour.*1 and 24/,
    );
  });
});

describe("responseToCsv", () => {
  it("converts object series and abbreviated array series", () => {
    assert.equal(
      responseToCsv({
        code: "NASDAQ:AAPL",
        bar_type: "1m",
        series: [{ time: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 }],
      }),
      "code,bar_type,time,open,high,low,close,volume\nNASDAQ:AAPL,1m,1,10,11,9,10.5,100\n",
    );

    assert.equal(
      responseToCsv({
        code: "NASDAQ:AAPL",
        bar_type: "1m",
        series_keys: ["time", "open", "close"],
        series: [[1, 10, 10.5]],
      }),
      "code,bar_type,time,open,close\nNASDAQ:AAPL,1m,1,10,10.5\n",
    );
  });
});

describe("downloadHistory", () => {
  it("validates the output directory before making API requests", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));
    const outputFile = path.join(tempDir, "not-a-directory");

    try {
      await writeFile(outputFile, "not a directory", "utf8");
      await assert.rejects(
        () =>
          downloadHistory(
            {
              symbol: "CME_MINI:NQ1!",
              from: "2024-01",
              to: "2024-01",
              bar_type: "hour",
              output_dir: outputFile,
              format: "json",
            },
            {
              request: async () =>
                assert.fail("invalid output_dir should fail before API requests"),
            },
          ),
        /output_dir is not writable/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("saves requested history as CSV and reports progress", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));
    const progress: string[] = [];
    const calls: Record<string, any>[] = [];

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-02",
          bar_type: "minute",
          output_dir: outputDir,
          format: "csv",
          keep_chunks: true,
          concurrency: 10,
        },
        {
          request: async (method, pathTemplate, params) => {
            calls.push({ method, pathTemplate, params });
            return {
              code: params.symbol,
              bar_type: "1m",
              series: [
                {
                  time: params.start_date === "2024-01" ? 1 : 2,
                  open: 10,
                  high: 11,
                  low: 9,
                  close: 10.5,
                  volume: 100,
                },
              ],
            };
          },
          onProgress: (event) => progress.push(`${event.completed}/${event.total}:${event.status}`),
        },
      );

      assert.equal(result.total, 2);
      assert.equal(result.completed, 2);
      assert.equal(result.failed, 0);
      assert.equal(result.concurrency, 10);
      assert.equal(calls.length, 2);
      assert.ok(progress.includes("1/2:saved"));
      assert.ok(progress.includes("2/2:saved"));

      const firstFile = path.join(outputDir, "NASDAQ_AAPL", "1m", "2024-01.csv");
      const firstCsv = await readFile(firstFile, "utf8");
      assert.equal(
        firstCsv,
        "code,bar_type,time,open,high,low,close,volume\nNASDAQ:AAPL,1m,1,10,11,9,10.5,100\n",
      );
      const mergedCsv = await readFile(requireMergedFile(result), "utf8");
      assert.equal(
        mergedCsv,
        "code,bar_type,time,open,high,low,close,volume\nNASDAQ:AAPL,1m,1,10,11,9,10.5,100\nNASDAQ:AAPL,1m,2,10,11,9,10.5,100\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("can disable merged CSV output", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-02",
          bar_type: "minute",
          output_dir: outputDir,
          format: "csv",
          merge: false,
          concurrency: 2,
        },
        {
          request: async (_method, _pathTemplate, params) => ({
            code: params.symbol,
            bar_type: "1m",
            series: [
              {
                time: params.start_date === "2024-01" ? 1 : 2,
                open: 10,
                high: 11,
                low: 9,
                close: 10.5,
                volume: 100,
              },
            ],
          }),
        },
      );

      assert.equal(result.merged_file, undefined);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("defaults to CSV output with a merged CSV", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-01",
          bar_type: "minute",
          output_dir: outputDir,
        },
        {
          request: async () => ({
            code: "NASDAQ:AAPL",
            bar_type: "1m",
            series: [{ time: 1, close: 10 }],
          }),
        },
      );

      assert.ok(result.merged_file?.endsWith("merged.csv"));
      assert.deepEqual(result.files, [result.merged_file]);
      await assert.rejects(
        () => readFile(path.join(outputDir, "NASDAQ_AAPL", "1m", "2024-01.csv"), "utf8"),
        /ENOENT/,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses the API response bar_type for output folders", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));
    const calls: Record<string, any>[] = [];

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01-01",
          to: "2024-01-02",
          bar_type: "month",
          output_dir: outputDir,
          format: "csv",
          keep_chunks: true,
        },
        {
          request: async (method, pathTemplate, params) => {
            calls.push({ method, pathTemplate, params });
            return {
              code: "NASDAQ:AAPL",
              bar_type: "1M",
              series: [{ time: Date.UTC(2024, 0, 1) / 1000, close: 10 }],
            };
          },
        },
      );

      assert.deepEqual(calls, [
        {
          method: "GET",
          pathTemplate: "/v3/symbols/{symbol}/series",
          params: {
            symbol: "NASDAQ:AAPL",
            bar_type: "month",
            dp: 30000,
          },
        },
      ]);
      const responseNamedChunk = path.join(
        outputDir,
        "NASDAQ_AAPL",
        "1M",
        "2024-01-01_2024-01-02.csv",
      );
      assert.ok(result.files.includes(responseNamedChunk));
      assert.equal(result.merged_file, path.join(outputDir, "NASDAQ_AAPL", "1M", "merged.csv"));
      await assert.rejects(
        () =>
          readFile(
            path.join(outputDir, "NASDAQ_AAPL", "1M-local-wrong", "2024-01-01_2024-01-02.csv"),
            "utf8",
          ),
        /ENOENT/,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("downloads day data from /series and filters output rows by from/to", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));
    const calls: Record<string, any>[] = [];

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01-02",
          to: "2024-01-03",
          bar_type: "day",
          output_dir: outputDir,
          format: "csv",
        },
        {
          request: async (method, pathTemplate, params) => {
            calls.push({ method, pathTemplate, params });
            return {
              code: "NASDAQ:AAPL",
              bar_type: "1D",
              series: [
                { time: Date.UTC(2024, 0, 1) / 1000, close: 9 },
                { time: Date.UTC(2024, 0, 2) / 1000, close: 10 },
                { time: Date.UTC(2024, 0, 3) / 1000, close: 11 },
                { time: Date.UTC(2024, 0, 4) / 1000, close: 12 },
              ],
            };
          },
        },
      );

      assert.deepEqual(calls, [
        {
          method: "GET",
          pathTemplate: "/v3/symbols/{symbol}/series",
          params: { symbol: "NASDAQ:AAPL", bar_type: "day", dp: 30000 },
        },
      ]);
      const mergedCsv = await readFile(requireMergedFile(result), "utf8");
      assert.equal(
        mergedCsv,
        `code,bar_type,time,close\nNASDAQ:AAPL,1D,${Date.UTC(2024, 0, 2) / 1000},10\nNASDAQ:AAPL,1D,${Date.UTC(2024, 0, 3) / 1000},11\n`,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("deduplicates merged CSV rows by code, bar_type, and time with latest row winning", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-02",
          bar_type: "minute",
          output_dir: outputDir,
          format: "csv",
        },
        {
          request: async (_method, _pathTemplate, params) => ({
            code: params.symbol,
            bar_type: "1m",
            series: [
              { time: 1, close: params.start_date === "2024-01" ? 10 : 99 },
              { time: params.start_date === "2024-01" ? 2 : 3, close: 20 },
            ],
          }),
        },
      );

      const mergedCsv = await readFile(requireMergedFile(result), "utf8");
      assert.equal(
        mergedCsv,
        "code,bar_type,time,close\nNASDAQ:AAPL,1m,1,99\nNASDAQ:AAPL,1m,2,20\nNASDAQ:AAPL,1m,3,20\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not remove pre-existing chunk files after merge", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));
    const chunkPath = path.join(outputDir, "NASDAQ_AAPL", "1m", "2024-01.csv");

    try {
      await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-01",
          bar_type: "minute",
          output_dir: outputDir,
          format: "csv",
          keep_chunks: true,
        },
        {
          request: async () => ({
            code: "NASDAQ:AAPL",
            bar_type: "1m",
            series: [{ time: 1, close: 10 }],
          }),
        },
      );

      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-01",
          bar_type: "minute",
          output_dir: outputDir,
          format: "csv",
        },
        {
          request: async () => assert.fail("existing chunk should be reused without fetching"),
        },
      );

      assert.deepEqual(result.files, [result.merged_file]);
      assert.equal(
        await readFile(chunkPath, "utf8"),
        "code,bar_type,time,close\nNASDAQ:AAPL,1m,1,10\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("merges CSV chunks with different headers using a union header", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-02",
          bar_type: "minute",
          output_dir: outputDir,
          format: "csv",
        },
        {
          request: async (_method, _pathTemplate, params) => ({
            code: params.symbol,
            bar_type: "1m",
            series:
              params.start_date === "2024-01"
                ? [{ time: 1, close: 10 }]
                : [{ time: 2, close: 20, volume: 200 }],
          }),
        },
      );

      const mergedCsv = await readFile(requireMergedFile(result), "utf8");
      assert.equal(
        mergedCsv,
        "code,bar_type,time,close,volume\nNASDAQ:AAPL,1m,1,10,\nNASDAQ:AAPL,1m,2,20,200\n",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("treats responses with both message and series as successful data", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "insight-history-"));
    const progress: string[] = [];

    try {
      const result = await downloadHistory(
        {
          symbol: "NASDAQ:AAPL",
          from: "2024-01",
          to: "2024-01",
          bar_type: "minute",
          output_dir: outputDir,
          format: "json",
        },
        {
          request: async () => ({
            code: "NASDAQ:AAPL",
            bar_type: "1m",
            message: "partial upstream note",
            series: [{ time: 1, close: 10 }],
          }),
          onProgress: (event) => progress.push(`${event.status}:${event.error ?? ""}`),
        },
      );

      assert.equal(result.completed, 1);
      assert.equal(result.skipped, 0);
      assert.equal(result.failed, 0);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(progress, ["saved:"]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
