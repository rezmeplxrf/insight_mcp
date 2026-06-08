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
        email: "support@insightsentry.com",
        newsfeed_enabled: true,
        websocket_symbols: 200,
        websocket_connections: 50,
        exp: 1_780_272_000,
      }),
      "environment",
      "/tmp/insightsentry/config.json",
      new Date("2026-05-01T00:00:00.000Z"),
    );

    assert.equal(status.authenticated, true);
    assert.equal(status.source, "environment");
    assert.equal(status.key_present, true);
    assert.equal(status.key_format_valid, true);
    assert.equal(status.subject, "support@insightsentry.com");
    assert.equal(status.expires_at, "2026-06-01T00:00:00.000Z");
    assert.equal(status.expired, false);
  });

  it("treats non-expiring InsightSentry JWTs as authenticated", () => {
    const status = getAuthStatusForKey(
      jwt({
        email: "support@insightsentry.com",
        newsfeed_enabled: true,
        websocket_symbols: 200,
        websocket_connections: 50,
      }),
      "config",
      "/tmp/insightsentry/config.json",
    );

    assert.equal(status.authenticated, true);
    assert.equal(status.subject, "support@insightsentry.com");
    assert.equal(status.expires_at, undefined);
    assert.equal(status.expired, undefined);
  });

  it("returns the email for whoami", () => {
    const result = getWhoamiForKey(
      jwt({ email: "support@insightsentry.com", uuid: "user-id" }),
      "environment",
    );

    assert.equal(result.ok, true);
    assert.equal(result.identity, "support@insightsentry.com");
  });

  it("falls back to uuid for whoami when email is missing", () => {
    const result = getWhoamiForKey(jwt({ uuid: "user-id" }), "config");

    assert.equal(result.ok, true);
    assert.equal(result.identity, "user-id");
  });

  it("falls back to string uuid when email is not a string", () => {
    const result = getWhoamiForKey(jwt({ email: 123, uuid: "user-id" }), "config");

    assert.equal(result.ok, true);
    assert.equal(result.identity, "user-id");
  });

  it("requires email or uuid for whoami", () => {
    const result = getWhoamiForKey(jwt({ sub: "subject-id" }), "config");

    assert.equal(result.ok, false);
    assert.equal(result.error, "API key JWT does not include email or uuid.");
  });

  it("marks malformed keys as not authenticated", () => {
    const status = getAuthStatusForKey("not-a-jwt", "config", "/tmp/insightsentry/config.json");

    assert.equal(status.authenticated, false);
    assert.equal(status.source, "config");
    assert.equal(status.key_present, true);
    assert.equal(status.key_format_valid, false);
    assert.match(status.message, /not a valid API key/);
    assert.match(status.message, /saved config/);
  });

  it("marks JWTs without email or uuid as not authenticated", () => {
    const status = getAuthStatusForKey(
      jwt({ plan: "enterprise" }),
      "environment",
      "/tmp/insightsentry/config.json",
    );

    assert.equal(status.authenticated, false);
    assert.equal(status.key_format_valid, false);
    assert.match(status.message, /must include email or uuid/);
  });

  it("marks JWTs with non-string identity claims as not authenticated", () => {
    const status = getAuthStatusForKey(
      jwt({ email: 123, uuid: 456 }),
      "config",
      "/tmp/insightsentry/config.json",
    );

    assert.equal(status.authenticated, false);
    assert.equal(status.key_format_valid, false);
    assert.match(status.message, /must include email or uuid/);
  });
});
