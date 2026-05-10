import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { coerceArgs, flexibleInputSchema } from "../src/arg-coercion.js";

describe("arg coercion", () => {
  const schema = {
    count: z.number().int().min(1),
    enabled: z.boolean(),
    fields: z.array(z.string()),
    symbol: z.string(),
  };

  it("treats numeric strings and numbers the same", () => {
    assert.deepEqual(coerceArgs({ count: "4" }, schema), { count: 4 });
    assert.deepEqual(coerceArgs({ count: 4 }, schema), { count: 4 });
  });

  it("treats boolean strings and booleans the same", () => {
    assert.deepEqual(coerceArgs({ enabled: "true" }, schema), { enabled: true });
    assert.deepEqual(coerceArgs({ enabled: true }, schema), { enabled: true });
    assert.deepEqual(coerceArgs({ enabled: "false" }, schema), { enabled: false });
    assert.deepEqual(coerceArgs({ enabled: false }, schema), { enabled: false });
  });

  it("accepts arrays as JSON strings, comma strings, or arrays", () => {
    assert.deepEqual(coerceArgs({ fields: '["close","volume"]' }, schema), {
      fields: ["close", "volume"],
    });
    assert.deepEqual(coerceArgs({ fields: "close,volume" }, schema), {
      fields: ["close", "volume"],
    });
    assert.deepEqual(coerceArgs({ fields: ["close", "volume"] }, schema), {
      fields: ["close", "volume"],
    });
  });

  it("lets MCP schemas parse string and typed inputs equivalently", () => {
    const flexible = z.object(flexibleInputSchema(schema));

    assert.deepEqual(
      flexible.parse({ count: "4", enabled: "false", fields: "close,volume", symbol: 123 }),
      {
        count: 4,
        enabled: false,
        fields: ["close", "volume"],
        symbol: "123",
      },
    );
    assert.deepEqual(
      flexible.parse({ count: 4, enabled: false, fields: ["close"], symbol: "NASDAQ:AAPL" }),
      {
        count: 4,
        enabled: false,
        fields: ["close"],
        symbol: "NASDAQ:AAPL",
      },
    );
  });

  it("preserves optional fields while adding flexible parsing", () => {
    const flexible = z.object(
      flexibleInputSchema({
        count: z.number().int().optional(),
        enabled: z.boolean().default(true).optional(),
      }),
    );

    assert.deepEqual(flexible.parse({}), { enabled: true });
    assert.deepEqual(flexible.parse({ count: "4", enabled: "false" }), {
      count: 4,
      enabled: false,
    });
  });
});
