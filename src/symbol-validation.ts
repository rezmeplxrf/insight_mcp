export const SYMBOL_CODE_FORMAT_MESSAGE = "expected EXCHANGE:SYMBOL format, e.g. NASDAQ:AAPL";
export const SYMBOL_CODE_REGEX = /^[A-Z0-9_./-]+:[A-Z0-9_./!-]+$/;

export function validateSymbolLikeArg(key: string, value: unknown): string | null {
  if (key === "symbol" || key === "code") return validateSymbolCodeValue(value);
  if (key !== "codes") return null;
  if (typeof value !== "string") return SYMBOL_CODE_FORMAT_MESSAGE;

  const invalid = value
    .split(",")
    .map((code) => code.trim())
    .find((code) => validateSymbolCode(code) !== null);
  return invalid ? `${invalid}: ${SYMBOL_CODE_FORMAT_MESSAGE}` : null;
}

export function validateSymbolLikeArgs(
  args: Record<string, unknown>,
): { key: string; error: string } | null {
  for (const [key, value] of Object.entries(args)) {
    const error = validateSymbolLikeArg(key, value);
    if (error) return { key, error };
  }
  return null;
}

function validateSymbolCodeValue(value: unknown): string | null {
  if (typeof value !== "string") return SYMBOL_CODE_FORMAT_MESSAGE;
  return validateSymbolCode(value);
}

function validateSymbolCode(value: string): string | null {
  return SYMBOL_CODE_REGEX.test(value) ? null : SYMBOL_CODE_FORMAT_MESSAGE;
}
