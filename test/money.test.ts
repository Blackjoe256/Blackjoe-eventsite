import { describe, expect, it } from "vitest";
import { formatMinorUnits, toBigInt, toMinorUnits } from "../src/ledger/money.js";

describe("money", () => {
  it("parses decimal strings into minor units", () => {
    expect(toMinorUnits("13.313806", "USDT")).toBe(13_313_806n);
    expect(toMinorUnits("10", "USDT")).toBe(10_000_000n);
    expect(toMinorUnits("0.000001", "USDT")).toBe(1n);
    expect(toMinorUnits("50000", "UGX")).toBe(50_000n);
    expect(toMinorUnits("-2.5", "USDT")).toBe(-2_500_000n);
  });

  it("rejects more precision than the currency supports", () => {
    expect(() => toMinorUnits("1.0000001", "USDT")).toThrow(RangeError);
    expect(() => toMinorUnits("100.5", "UGX")).toThrow(RangeError);
  });

  it("rejects things that are not plain decimals", () => {
    for (const bad of ["", "abc", "1e6", "1,000", "1.", ".5", "--1"]) {
      expect(() => toMinorUnits(bad, "USDT")).toThrow(RangeError);
    }
  });

  it("formats minor units and round-trips", () => {
    expect(formatMinorUnits(13_313_806n, "USDT")).toBe("13.313806");
    expect(formatMinorUnits(1n, "USDT")).toBe("0.000001");
    expect(formatMinorUnits(-2_500_000n, "USDT")).toBe("-2.500000");
    expect(formatMinorUnits(36_445n, "UGX")).toBe("36445");
    for (const s of ["0.000000", "123456789.123456", "-0.000042"]) {
      expect(formatMinorUnits(toMinorUnits(s, "USDT"), "USDT")).toBe(s);
    }
  });

  it("shows why floats are banned", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toMinorUnits("0.1", "USDT") + toMinorUnits("0.2", "USDT")).toBe(toMinorUnits("0.3", "USDT"));
  });

  it("normalises driver BIGINT values", () => {
    expect(toBigInt("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(toBigInt(5n)).toBe(5n);
    expect(toBigInt(42)).toBe(42n);
    expect(() => toBigInt(1.5)).toThrow(TypeError);
  });
});
