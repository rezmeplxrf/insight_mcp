import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAuthStatusForKey, getWhoamiForKey } from "../src/auth-status.js";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/g, "");

  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("auth status", () => {
  it("reports missing credentials as logged out", () => {
    const status = getAuthStatusForKey(undefined, "none", "/tmp/insightsentry/config.json");

    assert.equal(status.authenticated, false);
    assert.equal(status.source, "none");
    assert.equal(status.key_present, false);
    assert.equal(status.key_format_valid, false);
    assert.match(status.message, /No API key found/);
  });

  it("decodes configured JWT identity and expiry without calling the API", () => {
    const status = getAuthStatusForKey(
      jwt({
        uuid: "support@insightsentry.com",
        plan: "enterprise",
        newsfeed_enabled: true,
        websocket_symbols: 200,
        websocket_connections: 50,
        exp: 1_780_272_000,
      }),
      "environment",
      "/tmp/insightsentry/config.json",
    );

    assert.equal(status.authenticated, true);
    assert.equal(status.source, "environment");
    assert.equal(status.key_present, true);
    assert.equal(status.key_format_valid, true);
    assert.equal(status.subject, "support@insightsentry.com");
    assert.equal(status.expires_at, "2026-06-01T00:00:00.000Z");
    assert.equal(status.expired, false);
  });

  it("returns the uuid for whoami", () => {
    const result = getWhoamiForKey(
      jwt({ uuid: "support@insightsentry.com", plan: "enterprise" }),
      "environment",
    );

    assert.equal(result.ok, true);
    assert.equal(result.identity, "support@insightsentry.com");
  });

  it("falls back to email then sub for whoami", () => {
    assert.equal(
      getWhoamiForKey(jwt({ email: "email@example.com" }), "config").identity,
      "email@example.com",
    );
    assert.equal(getWhoamiForKey(jwt({ sub: "subject-id" }), "config").identity, "subject-id");
  });

  it("marks malformed keys as not authenticated", () => {
    const status = getAuthStatusForKey("not-a-jwt", "config", "/tmp/insightsentry/config.json");

    assert.equal(status.authenticated, false);
    assert.equal(status.source, "config");
    assert.equal(status.key_present, true);
    assert.equal(status.key_format_valid, false);
    assert.match(status.message, /not a valid API key/);
  });
});
