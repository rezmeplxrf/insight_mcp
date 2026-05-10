import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

interface Config {
  apiKey?: string;
}

type ApiKeySource = "environment" | "config" | "none";

function getConfigDir(): string {
  const override = process.env.INSIGHTSENTRY_CONFIG_DIR?.trim();
  if (override) return override;

  const p = platform();
  if (p === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "insightsentry");
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "insightsentry");
  }
  // Linux / others: XDG_CONFIG_HOME or ~/.config
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "insightsentry");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(getConfigPath(), "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function deleteConfig(): void {
  try {
    unlinkSync(getConfigPath());
  } catch {
    // already gone
  }
}

/** Returns the API key from env var (priority) or stored config */
export function resolveApiKey(): string | undefined {
  return resolveApiKeyWithSource().apiKey;
}

/** Returns the API key and where it came from. Env var takes priority over saved config. */
export function resolveApiKeyWithSource(): { apiKey?: string; source: ApiKeySource } {
  const envKey = process.env.INSIGHTSENTRY_API_KEY?.trim();
  if (envKey) return { apiKey: envKey, source: "environment" };

  const configKey = loadConfig().apiKey?.trim();
  if (configKey) return { apiKey: configKey, source: "config" };

  return { source: "none" };
}

export function getConfigLocation(): string {
  return getConfigPath();
}
