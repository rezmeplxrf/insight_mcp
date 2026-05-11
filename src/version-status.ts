import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PackageInfo } from "./package-info.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const VERSION_LOOKUP_TIMEOUT_MS = 3000;
export const VERSION_STATUS_CACHE_TTL_MS = 10 * 60 * 1000;

export type LatestVersionProvider = (packageName: string) => Promise<string>;

export interface VersionStatus {
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  error?: string;
}

export interface VersionStatusOptions {
  cachePath?: string;
  cacheTtlMs?: number;
  now?: () => number;
}

interface CachedVersionStatus {
  packageName: string;
  latestVersion: string;
  checkedAt: number;
}

export async function fetchLatestPackageVersion(packageName: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERSION_LOOKUP_TIMEOUT_MS);

  try {
    const packagePath = encodeURIComponent(packageName);
    const response = await fetch(`${NPM_REGISTRY_URL}/${packagePath}/latest`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status}`);
    }

    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.trim() === "") {
      throw new Error("npm registry response did not include a version");
    }
    return body.version.trim();
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("npm registry lookup timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getVersionStatus(
  packageInfo: PackageInfo,
  latestVersionProvider: LatestVersionProvider = fetchLatestPackageVersion,
  options: VersionStatusOptions = {},
): Promise<VersionStatus> {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? VERSION_STATUS_CACHE_TTL_MS;
  const cached = options.cachePath ? readCachedVersionStatus(options.cachePath) : null;

  if (cached && cached.packageName === packageInfo.name && cached.checkedAt + cacheTtlMs > now()) {
    return buildVersionStatus(packageInfo, cached.latestVersion);
  }

  try {
    const latestVersion = await latestVersionProvider(packageInfo.name);
    if (options.cachePath) {
      writeCachedVersionStatus(options.cachePath, {
        packageName: packageInfo.name,
        latestVersion,
        checkedAt: now(),
      });
    }
    return buildVersionStatus(packageInfo, latestVersion);
  } catch (error: any) {
    return {
      packageName: packageInfo.name,
      currentVersion: packageInfo.version,
      error: error?.message ?? String(error),
    };
  }
}

export function formatUpgradeNotice(status: VersionStatus): string | null {
  if (!status.updateAvailable || !status.latestVersion) return null;
  return `InsightSentry CLI/MCP ${status.latestVersion} is available (current ${status.currentVersion}). Run \`insight update\`.`;
}

export function formatVersionStatus(status: VersionStatus): string {
  const lines = [`${status.packageName} ${status.currentVersion}`];

  if (!status.latestVersion) {
    lines.push(`Latest: unavailable${status.error ? ` (${status.error})` : ""}`);
    lines.push("Could not check for updates. Try again later or run `insight update`.");
    return lines.join("\n");
  }

  lines.push(`Latest: ${status.latestVersion}`);
  if (status.updateAvailable) {
    lines.push("Update available: run `insight update`.");
  } else if (comparePackageVersions(status.currentVersion, status.latestVersion) > 0) {
    lines.push("Local version is newer than the latest published version.");
  } else {
    lines.push("You are on the latest version.");
  }

  return lines.join("\n");
}

function buildVersionStatus(packageInfo: PackageInfo, latestVersion: string): VersionStatus {
  return {
    packageName: packageInfo.name,
    currentVersion: packageInfo.version,
    latestVersion,
    updateAvailable: comparePackageVersions(latestVersion, packageInfo.version) > 0,
  };
}

function readCachedVersionStatus(cachePath: string): CachedVersionStatus | null {
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedVersionStatus;
    if (
      typeof cached.packageName !== "string" ||
      typeof cached.latestVersion !== "string" ||
      typeof cached.checkedAt !== "number"
    ) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function writeCachedVersionStatus(cachePath: string, status: CachedVersionStatus): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Version checks should never make a successful tool command fail.
  }
}

export function comparePackageVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);

  for (let index = 0; index < 3; index++) {
    const delta = parsedLeft.core[index] - parsedRight.core[index];
    if (delta !== 0) return Math.sign(delta);
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0;
  if (parsedLeft.prerelease.length === 0) return 1;
  if (parsedRight.prerelease.length === 0) return -1;

  const count = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < count; index++) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const comparison = comparePrereleasePart(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function parseVersion(version: string): { core: [number, number, number]; prerelease: string[] } {
  const normalized = version.trim().replace(/^v/, "").split("+", 1)[0];
  const [coreValue, prereleaseValue = ""] = normalized.split("-", 2);
  const coreParts = coreValue.split(".").map((part) => Number.parseInt(part, 10));

  return {
    core: [
      Number.isFinite(coreParts[0]) ? coreParts[0] : 0,
      Number.isFinite(coreParts[1]) ? coreParts[1] : 0,
      Number.isFinite(coreParts[2]) ? coreParts[2] : 0,
    ],
    prerelease: prereleaseValue ? prereleaseValue.split(".") : [],
  };
}

function comparePrereleasePart(left: string, right: string): number {
  const leftNumber = numericPrereleasePart(left);
  const rightNumber = numericPrereleasePart(right);

  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return Math.sign(left.localeCompare(right));
}

function numericPrereleasePart(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  return Number.parseInt(value, 10);
}
