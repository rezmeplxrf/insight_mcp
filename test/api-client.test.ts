import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiClient } from "../src/api-client.js";

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
});
