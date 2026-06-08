import { getConfigLocation, resolveApiKeyWithSource } from "./config.js";

export type AuthKeySource = "environment" | "config" | "none";

export interface AuthStatus {
  authenticated: boolean;
  source: AuthKeySource;
  config_path: string;
  key_present: boolean;
  key_format_valid: boolean;
  subject?: string;
  expires_at?: string;
  expired?: boolean;
  message: string;
}

export interface WhoamiResult {
  ok: boolean;
  identity?: string;
  error?: string;
}

interface JwtPayload {
  uuid?: string;
  email?: string;
  exp?: number;
}

export function getAuthStatus(): AuthStatus {
  const { apiKey, source } = resolveApiKeyWithSource();
  return getAuthStatusForKey(apiKey, source, getConfigLocation());
}

export function getWhoami(): WhoamiResult {
  const { apiKey, source } = resolveApiKeyWithSource();
  return getWhoamiForKey(apiKey, source);
}

export function getWhoamiForKey(apiKey: string | undefined, _source: AuthKeySource): WhoamiResult {
  const token = apiKey?.trim();
  if (!token) return { ok: false, error: "No API key found." };

  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {
      ok: false,
      error: "API key is not a valid InsightSentry JWT.",
    };
  }

  const identity = getPayloadIdentity(payload);
  if (!identity) {
    return {
      ok: false,
      error: "API key JWT does not include email or uuid.",
    };
  }

  return { ok: true, identity };
}

export function validateApiKeyForLogin(apiKey: string): WhoamiResult {
  const token = apiKey.trim();
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {
      ok: false,
      error: "API key is not a valid InsightSentry JWT.",
    };
  }

  const identity = getPayloadIdentity(payload);
  if (!identity) {
    return {
      ok: false,
      error: "API key JWT must include email or uuid.",
    };
  }

  return { ok: true, identity };
}

export function getAuthStatusForKey(
  apiKey: string | undefined,
  source: AuthKeySource,
  configPath: string,
  now = new Date(),
): AuthStatus {
  const token = apiKey?.trim();
  const sourceLabel = source === "environment" ? "INSIGHTSENTRY_API_KEY" : "saved config";
  if (!token) {
    return {
      authenticated: false,
      source: "none",
      config_path: configPath,
      key_present: false,
      key_format_valid: false,
      message: "Logged out. No API key found.",
    };
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    return {
      authenticated: false,
      source,
      config_path: configPath,
      key_present: true,
      key_format_valid: false,
      message: `Logged out. API key from ${sourceLabel} is not a valid API key. InsightSentry API keys are JWT tokens.`,
    };
  }

  const expiresAt = payload.exp ? new Date(payload.exp * 1000) : undefined;
  const expired = expiresAt ? expiresAt.getTime() <= now.getTime() : undefined;
  const identity = getPayloadIdentity(payload);
  if (!identity) {
    return {
      authenticated: false,
      source,
      config_path: configPath,
      key_present: true,
      key_format_valid: false,
      message: `Logged out. API key from ${sourceLabel} must include email or uuid.`,
    };
  }

  return {
    authenticated: expired !== true,
    source,
    config_path: configPath,
    key_present: true,
    key_format_valid: true,
    subject: identity,
    expires_at: expiresAt?.toISOString(),
    expired,
    message:
      expired === true
        ? `Logged out. API key from ${sourceLabel} is expired.`
        : `Logged in using ${sourceLabel}.`,
  };
}

export function isJwt(token: string): boolean {
  return decodeJwtPayload(token) !== null;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function getPayloadIdentity(payload: JwtPayload): string | undefined {
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  const uuid = typeof payload.uuid === "string" ? payload.uuid.trim() : "";
  return email || uuid || undefined;
}
