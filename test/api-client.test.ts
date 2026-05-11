import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiClient, isTerminalApiError } from "../src/api-client.js";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/g, "");

  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

describe("ApiClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks /history requests before fetch for plans below ultra", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "pro" }));

    await assert.rejects(
      () =>
        client.request("GET", "/v3/symbols/{symbol}/history", {
          symbol: "NASDAQ:AAPL",
          bar_type: "minute",
          start_date: "2026-01",
        }),
      /history endpoint requires an Ultra, Mega, or Enterprise plan/,
    );
    assert.equal(fetchCalled, false);
  });

  it("allows /history requests for ultra, mega, and enterprise plans", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    for (const plan of ["ultra", "mega", "enterprise"]) {
      const client = new ApiClient(jwt({ uuid: "user@example.com", plan }));
      await client.request("GET", "/v3/symbols/{symbol}/history", {
        symbol: "NASDAQ:AAPL",
        bar_type: "minute",
        start_date: "2026-01",
      });
    }

    assert.equal(requestedUrls.length, 3);
  });

  it("does not require an archive plan for non-history endpoints", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "pro" }));

    await client.request("GET", "/v3/symbols/{symbol}/series", {
      symbol: "NASDAQ:AAPL",
      bar_type: "day",
    });

    assert.equal(fetchCalled, true);
  });

  it("blocks tick /series requests before fetch for plans below mega", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    for (const plan of ["pro", "ultra"]) {
      const client = new ApiClient(jwt({ uuid: "user@example.com", plan }));

      await assert.rejects(
        () =>
          client.request("GET", "/v3/symbols/{symbol}/series", {
            symbol: "NASDAQ:AAPL",
            bar_type: "tick",
          }),
        /\/series tick option requires a Mega or Enterprise plan/,
      );
    }
    assert.equal(fetchCalled, false);
  });

  it("allows tick /series requests for mega and enterprise plans", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    for (const plan of ["mega", "enterprise"]) {
      const client = new ApiClient(jwt({ uuid: "user@example.com", plan }));
      await client.request("GET", "/v3/symbols/{symbol}/series", {
        symbol: "NASDAQ:AAPL",
        bar_type: "tick",
      });
    }

    assert.equal(requestedUrls.length, 2);
  });

  it("does not require a mega plan for non-tick /series requests", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "ultra" }));

    await client.request("GET", "/v3/symbols/{symbol}/series", {
      symbol: "NASDAQ:AAPL",
      bar_type: "day",
    });

    assert.equal(fetchCalled, true);
  });

  it("classifies 4xx API errors as terminal and 5xx API errors as retryable", async () => {
    assert.equal(isTerminalApiError(new Error("API error (400): Bad Request")), true);
    assert.equal(isTerminalApiError(new Error("API error (403): Forbidden")), true);
    assert.equal(isTerminalApiError(new Error("API error (500): Internal Server Error")), false);
    assert.equal(isTerminalApiError(new Error("API error (503): Service Unavailable")), false);
  });

  it("retries 5xx API errors with delay before succeeding", async () => {
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ message: "temporary upstream failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    assert.deepEqual(await client.request("GET", "/v3/symbols/search", { query: "apple" }), {
      ok: true,
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);
  });

  it("retries transient fetch failures with delay before succeeding", async () => {
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("ECONNRESET");
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    assert.deepEqual(await client.request("GET", "/v3/symbols/search", { query: "apple" }), {
      ok: true,
    });
    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);
  });

  it("does not retry terminal 400 API errors", async () => {
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "invalid request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await assert.rejects(
      () => client.request("GET", "/v3/symbols/search", { query: "apple" }),
      /API error \(400\): invalid request/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });

  it("retries /history rate limits once after one minute", async () => {
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    assert.deepEqual(
      await client.request("GET", "/v3/symbols/{symbol}/history", {
        symbol: "NASDAQ:AAPL",
        bar_type: "minute",
        start_date: "2026-01",
      }),
      { ok: true },
    );
    assert.equal(calls, 2);
    assert.deepEqual(delays, [60_000]);
  });

  it("shares one /history rate-limit pause across concurrent requests", async () => {
    const callsByStartDate = new Map<string, number>();
    const delays: number[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const startDate = url.searchParams.get("start_date") ?? "";
      const calls = (callsByStartDate.get(startDate) ?? 0) + 1;
      callsByStartDate.set(startDate, calls);

      if (calls === 1) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ startDate }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    const [first, second] = await Promise.all([
      client.request("GET", "/v3/symbols/{symbol}/history", {
        symbol: "NASDAQ:AAPL",
        bar_type: "minute",
        start_date: "2026-01",
      }),
      client.request("GET", "/v3/symbols/{symbol}/history", {
        symbol: "NASDAQ:AAPL",
        bar_type: "minute",
        start_date: "2026-02",
      }),
    ]);

    assert.deepEqual(first, { startDate: "2026-01" });
    assert.deepEqual(second, { startDate: "2026-02" });
    assert.deepEqual(delays, [60_000]);
    assert.equal(callsByStartDate.get("2026-01"), 2);
    assert.equal(callsByStartDate.get("2026-02"), 2);
  });

  it("does not retry non-history rate limits", async () => {
    let calls = 0;
    const delays: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await assert.rejects(
      () => client.request("GET", "/v3/symbols/search", { query: "apple" }),
      /API error \(429\): Rate limit exceeded/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });

  it("does not retry other /history 429 errors", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "Other quota exhausted" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new ApiClient(jwt({ uuid: "user@example.com", plan: "enterprise" }), {
      sleep: async () => {},
    });

    await assert.rejects(
      () =>
        client.request("GET", "/v3/symbols/{symbol}/history", {
          symbol: "NASDAQ:AAPL",
          bar_type: "minute",
          start_date: "2026-01",
        }),
      /API error \(429\): Other quota exhausted/,
    );
    assert.equal(calls, 1);
  });
});
