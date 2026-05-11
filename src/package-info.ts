import { readFileSync } from "node:fs";

export interface PackageInfo {
  name: string;
  version: string;
}

export const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageInfo;
