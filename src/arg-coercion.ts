import { z } from "zod";

export function coerceArgs(
  args: Record<string, any>,
  schema: Record<string, z.ZodTypeAny>,
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(args)) {
    const zodType = schema[key];
    result[key] = zodType ? coerceValue(value, zodType) : value;
  }

  return result;
}

export function flexibleInputSchema(
  schema: Record<string, z.ZodTypeAny>,
): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, zodType]) => [key, makeFlexibleZodType(zodType)]),
  );
}

export function getZodTypeName(t: z.ZodTypeAny): string {
  return resolveZodDef(t).type;
}

export function isOptionalZodType(t: z.ZodTypeAny): boolean {
  const def = getZodDef(t);
  const type = getDefType(def);
  if (type === "optional" || type === "default") return true;
  return typeof (t as any).isOptional === "function" && (t as any).isOptional();
}

export function getZodEnumValues(t: z.ZodTypeAny): string[] {
  const { type, def } = resolveZodDef(t);
  if (type === "enum" && def.entries) {
    return Object.values(def.entries) as string[];
  }
  return [];
}

function makeFlexibleZodType(t: z.ZodTypeAny): z.ZodTypeAny {
  const def = getZodDef(t);
  const type = getDefType(def);

  if ((type === "optional" || type === "default") && def.innerType) {
    const inner = makeFlexibleZodType(def.innerType);
    if (type === "default") {
      return inner.default(def.defaultValue);
    }
    return inner.optional();
  }

  if (["number", "boolean", "array", "string", "enum"].includes(type)) {
    return z.preprocess((value) => coerceValue(value, t), t);
  }

  return t;
}

function coerceValue(value: any, zodType: z.ZodTypeAny): any {
  if (value === undefined || value === null) return value;

  const typeName = getZodTypeName(zodType);
  if (typeName === "number") return coerceNumber(value);
  if (typeName === "boolean") return coerceBoolean(value);
  if (typeName === "array") return coerceArray(value);
  if (typeName === "string" || typeName === "enum") return coerceString(value);
  return value;
}

function coerceNumber(value: any): any {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const numeric = Number(trimmed);
  return Number.isNaN(numeric) ? value : numeric;
}

function coerceBoolean(value: any): any {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
      return true;
    case "false":
    case "0":
    case "no":
      return false;
    default:
      return value;
  }
}

function coerceArray(value: any): any {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to comma splitting.
    }
  }

  return value.split(",").map((part) => part.trim());
}

function coerceString(value: any): any {
  if (typeof value === "string") return value;
  return String(value);
}

function resolveZodDef(t: z.ZodTypeAny): { type: string; def: any } {
  const def = getZodDef(t);
  const type = getDefType(def);
  if ((type === "optional" || type === "default") && def.innerType) {
    return resolveZodDef(def.innerType);
  }
  return { type, def };
}

function getZodDef(t: z.ZodTypeAny): any {
  return (t as any)._zod?.def ?? (t as any)._def ?? {};
}

function getDefType(def: any): string {
  return def.type ?? def.typeName ?? "";
}
