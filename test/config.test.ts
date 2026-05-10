import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  deleteConfig,
  getConfigLocation,
  loadConfig,
  resolveApiKeyWithSource,
  saveConfig,
} from "../src/config.js";

describe("config", () => {
  let tempConfigDir: string | null = null;
  const originalConfigDir = process.env.INSIGHTSENTRY_CONFIG_DIR;
  const originalApiKey = process.env.INSIGHTSENTRY_API_KEY;

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.INSIGHTSENTRY_CONFIG_DIR;
    } else {
      process.env.INSIGHTSENTRY_CONFIG_DIR = originalConfigDir;
    }
    if (originalApiKey === undefined) {
      delete process.env.INSIGHTSENTRY_API_KEY;
    } else {
      process.env.INSIGHTSENTRY_API_KEY = originalApiKey;
    }
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = null;
    }
  });

  it("uses INSIGHTSENTRY_CONFIG_DIR as the config directory override", async () => {
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "insight-config-"));
    process.env.INSIGHTSENTRY_CONFIG_DIR = tempConfigDir;
    delete process.env.INSIGHTSENTRY_API_KEY;

    assert.equal(getConfigLocation(), path.join(tempConfigDir, "config.json"));

    saveConfig({ apiKey: "saved-key" });

    assert.deepEqual(loadConfig(), { apiKey: "saved-key" });
    assert.deepEqual(resolveApiKeyWithSource(), {
      apiKey: "saved-key",
      source: "config",
    });
    assert.equal(
      await readFile(path.join(tempConfigDir, "config.json"), "utf8"),
      '{\n  "apiKey": "saved-key"\n}\n',
    );

    deleteConfig();

    assert.deepEqual(loadConfig(), {});
  });

  it("does not treat an empty INSIGHTSENTRY_CONFIG_DIR as an override", async () => {
    tempConfigDir = await mkdtemp(path.join(tmpdir(), "insight-config-empty-"));
    process.env.INSIGHTSENTRY_CONFIG_DIR = "   ";

    await mkdir(tempConfigDir, { recursive: true });

    assert.notEqual(getConfigLocation(), path.join(tempConfigDir, "config.json"));
  });
});
