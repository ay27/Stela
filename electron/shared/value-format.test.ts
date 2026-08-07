import assert from "node:assert/strict";
import { formatValue, valueFormatSchema } from "./value-format";

assert.equal(formatValue(null), "NULL");
assert.equal(formatValue(0.125, { kind: "percent", input: "ratio", maximumFractionDigits: 1 }, "en-US"), "12.5%");
assert.equal(formatValue(12.5, { kind: "percent", input: "whole", maximumFractionDigits: 1 }, "en-US"), "12.5%");
assert.match(formatValue(1200, { kind: "currency", currency: "CNY", maximumFractionDigits: 0 }, "zh-CN"), /1,200/);
assert.equal(formatValue(65_000, { kind: "duration", input: "milliseconds", style: "clock" }), "1:05");
assert.equal(formatValue("false", { kind: "boolean", trueLabel: "Yes", falseLabel: "No" }), "No");
assert.throws(() => valueFormatSchema.parse({ kind: "currency", currency: "rmb" }));
assert.throws(() => valueFormatSchema.parse({ kind: "number", minimumFractionDigits: 3, maximumFractionDigits: 1 }), /cannot exceed/);

console.log("value-format tests passed.");
