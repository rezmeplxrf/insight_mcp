const FUTURES_CONTRACT_PATTERN = /(\d{4}|[12]!)$/;
const CONTINUOUS_FUTURES_PATTERN = /[12]!$/;
const EQUITY_ONLY_PARAMS = new Set(["split", "dadj"]);
const FALSE_BOOLEAN_INPUTS = new Set(["false", "0", "no"]);

function getSymbolPart(code: string): string {
  return code.includes(":") ? (code.split(":").at(1) ?? code) : code;
}

export function isFuturesSymbol(code: string): boolean {
  return Boolean(code) && FUTURES_CONTRACT_PATTERN.test(getSymbolPart(code));
}

export function isContinuousFutures(code: string): boolean {
  return Boolean(code) && CONTINUOUS_FUTURES_PATTERN.test(getSymbolPart(code));
}

export function analyzeSymbolCodes(raw: string): {
  hasSymbol: boolean;
  hasEquity: boolean;
  hasFutures: boolean;
  hasContinuous: boolean;
} {
  const codes = raw
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);

  let hasEquity = false;
  let hasFutures = false;
  let hasContinuous = false;
  for (const code of codes) {
    if (isContinuousFutures(code)) {
      hasContinuous = true;
      hasFutures = true;
    } else if (isFuturesSymbol(code)) {
      hasFutures = true;
    } else {
      hasEquity = true;
    }
  }

  return {
    hasSymbol: codes.length > 0,
    hasEquity,
    hasFutures,
    hasContinuous,
  };
}

export function shouldPromptSymbolScopedParam(
  paramName: string,
  args: Record<string, string | undefined>,
): boolean {
  const lower = paramName.toLowerCase();
  if (
    !EQUITY_ONLY_PARAMS.has(lower) &&
    lower !== "badj" &&
    lower !== "settlement" &&
    lower !== "extended"
  ) {
    return true;
  }

  const rawSymbol = args.symbol ?? args.code ?? args.codes ?? "";
  const { hasSymbol, hasEquity, hasFutures, hasContinuous } = analyzeSymbolCodes(rawSymbol);
  if (!hasSymbol) return true;

  const allFutures = hasFutures && !hasEquity;
  if (allFutures && EQUITY_ONLY_PARAMS.has(lower)) return false;
  if (lower === "badj") return hasContinuous;
  if (lower === "settlement") return hasFutures;
  if (lower === "extended") return !allFutures;
  if (lower === "dadj" && isFalseBooleanInput(args.split)) return false;
  return true;
}

function isFalseBooleanInput(value: string | undefined): boolean {
  return value !== undefined && FALSE_BOOLEAN_INPUTS.has(value.trim().toLowerCase());
}
