const VALID_SECOND_INTERVALS = new Set([1, 5, 10, 15, 30, 45]);

export function validateHistoryBarInterval(barType: unknown, barInterval: unknown): string | null {
  if (barInterval === undefined || barInterval === null || barInterval === "") return null;

  const interval = typeof barInterval === "number" ? barInterval : Number(barInterval);
  if (!Number.isInteger(interval)) return "bar_interval must be an integer";

  const type = typeof barType === "string" ? barType.toLowerCase() : "";
  if (type === "second") {
    return VALID_SECOND_INTERVALS.has(interval)
      ? null
      : "bar_interval for second bars must be one of: 1, 5, 10, 15, 30, 45";
  }

  if (type === "hour") {
    return interval >= 1 && interval <= 24
      ? null
      : "bar_interval for hour bars must be between 1 and 24";
  }

  if (interval < 1 || interval > 1440) {
    return "bar_interval must be an integer between 1 and 1440";
  }

  return null;
}

export function validateHistoryIntervalArgs(
  toolName: string,
  args: Record<string, unknown>,
): { key: "bar_interval"; error: string } | null {
  if (toolName !== "get_symbol_history" && toolName !== "download_history") return null;
  const error = validateHistoryBarInterval(args.bar_type, args.bar_interval);
  return error ? { key: "bar_interval", error } : null;
}
