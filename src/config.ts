import { homedir, platform } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";

interface Config {
  apiKey?: string;
}

function getConfigDir(): string {
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
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
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
  return process.env.INSIGHTSENTRY_API_KEY?.trim() || loadConfig().apiKey;
}

export function getConfigLocation(): string {
  return getConfigPath();
}
