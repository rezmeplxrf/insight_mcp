import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  comparePackageVersions,
  formatUpgradeNotice,
  formatVersionStatus,
  getVersionStatus,
} from "../src/version-status.js";

describe("comparePackageVersions", () => {
  it("orders semantic versions", () => {
    assert.equal(comparePackageVersions("1.4.19", "1.4.18"), 1);
    assert.equal(comparePackageVersions("1.4.18", "1.4.18"), 0);
    assert.equal(comparePackageVersions("1.4.17", "1.4.18"), -1);
  });

  it("orders prereleases below stable releases", () => {
    assert.equal(comparePackageVersions("1.4.18", "1.4.18-beta.1"), 1);
    assert.equal(comparePackageVersions("1.4.18-beta.2", "1.4.18-beta.1"), 1);
    assert.equal(comparePackageVersions("1.4.18-beta.1", "1.4.18"), -1);
  });
});

describe("getVersionStatus", () => {
  it("reports available updates", async () => {
    const status = await getVersionStatus(
      { name: "@insightsentry/mcp", version: "1.4.18" },
      async () => "1.4.19",
    );

    assert.equal(status.currentVersion, "1.4.18");
    assert.equal(status.latestVersion, "1.4.19");
    assert.equal(status.updateAvailable, true);
  });

  it("reports registry lookup failures", async () => {
    const status = await getVersionStatus(
      { name: "@insightsentry/mcp", version: "1.4.18" },
      async () => {
        throw new Error("registry unavailable");
      },
    );

    assert.equal(status.latestVersion, undefined);
    assert.equal(status.updateAvailable, undefined);
    assert.equal(status.error, "registry unavailable");
  });

  it("caches latest version lookups for the configured ttl", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "insight-version-cache-"));
    const cachePath = path.join(tempDir, "version-cache.json");
    let calls = 0;

    try {
      const first = await getVersionStatus(
        { name: "@insightsentry/mcp", version: "1.4.18" },
        async () => {
          calls++;
          return "1.4.19";
        },
        { cachePath, now: () => 1000 },
      );
      const second = await getVersionStatus(
        { name: "@insightsentry/mcp", version: "1.4.18" },
        async () => {
          calls++;
          return "1.4.20";
        },
        { cachePath, now: () => 2000 },
      );

      assert.equal(calls, 1);
      assert.equal(first.latestVersion, "1.4.19");
      assert.equal(second.latestVersion, "1.4.19");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("formatVersionStatus", () => {
  it("tells users how to upgrade when a new version is available", () => {
    const message = formatVersionStatus({
      packageName: "@insightsentry/mcp",
      currentVersion: "1.4.18",
      latestVersion: "1.4.19",
      updateAvailable: true,
    });

    assert.ok(message.includes("@insightsentry/mcp 1.4.18"));
    assert.ok(message.includes("Latest: 1.4.19"));
    assert.ok(message.includes("Update available: run `insight update`."));
  });
});

describe("formatUpgradeNotice", () => {
  it("returns a concise upgrade notice only when an update is available", () => {
    assert.equal(
      formatUpgradeNotice({
        packageName: "@insightsentry/mcp",
        currentVersion: "1.4.18",
        latestVersion: "1.4.19",
        updateAvailable: true,
      }),
      "InsightSentry CLI/MCP 1.4.19 is available (current 1.4.18). Run `insight update`.",
    );
    assert.equal(
      formatUpgradeNotice({
        packageName: "@insightsentry/mcp",
        currentVersion: "1.4.18",
        latestVersion: "1.4.18",
        updateAvailable: false,
      }),
      null,
    );
  });
});
