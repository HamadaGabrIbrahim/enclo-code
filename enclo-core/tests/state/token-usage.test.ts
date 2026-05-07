import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE,
  addUsage,
  computeContextUsed,
  computeCostUsd,
  formatCostUsd,
  formatPercent,
  formatTokenCount,
  severityFor,
  type TokenUsageState,
} from "../../src/state/token-usage.js";

describe("addUsage", () => {
  it("starts from EMPTY_USAGE with all zeros", () => {
    expect(EMPTY_USAGE).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      requestCount: 0,
      lastRequestPromptTokens: 0,
    });
  });

  it("accumulates totals across two end events", () => {
    const a = addUsage(EMPTY_USAGE, { prompt_tokens: 100, completion_tokens: 20 });
    const b = addUsage(a, { prompt_tokens: 200, completion_tokens: 50 });
    expect(b.promptTokens).toBe(300);
    expect(b.completionTokens).toBe(70);
    expect(b.requestCount).toBe(2);
    expect(b.lastRequestPromptTokens).toBe(200);
  });

  it("treats undefined fields as zero", () => {
    const next = addUsage(EMPTY_USAGE, { prompt_tokens: 50 });
    expect(next.promptTokens).toBe(50);
    expect(next.completionTokens).toBe(0);
    expect(next.requestCount).toBe(1);
    expect(next.lastRequestPromptTokens).toBe(50);
  });

  it("ignores entirely-zero or undefined usage events (don't bump requestCount)", () => {
    expect(addUsage(EMPTY_USAGE, undefined)).toBe(EMPTY_USAGE);
    expect(
      addUsage(EMPTY_USAGE, { prompt_tokens: 0, completion_tokens: 0 }),
    ).toBe(EMPTY_USAGE);
  });

  it("preserves prior lastRequestPromptTokens when a follow-up has only completion tokens", () => {
    const a = addUsage(EMPTY_USAGE, { prompt_tokens: 200, completion_tokens: 10 });
    const b = addUsage(a, { prompt_tokens: 0, completion_tokens: 5 });
    expect(b.lastRequestPromptTokens).toBe(200);
  });
});

describe("severityFor", () => {
  it.each([
    [0.0, "ok"],
    [0.5, "ok"],
    [0.6, "ok"],
    [0.61, "warn"],
    [0.8, "warn"],
    [0.81, "danger"],
    [0.99, "danger"],
  ] as const)("severityFor(%s) === %s", (frac, expected) => {
    expect(severityFor(frac)).toBe(expected);
  });
});

describe("computeContextUsed", () => {
  const usage = (last: number): TokenUsageState => ({
    ...EMPTY_USAGE,
    lastRequestPromptTokens: last,
    requestCount: last > 0 ? 1 : 0,
  });

  it("returns null when there are no requests yet", () => {
    expect(computeContextUsed(EMPTY_USAGE, 4096)).toBeNull();
  });

  it("returns null when context_length is missing or zero", () => {
    expect(computeContextUsed(usage(100), undefined)).toBeNull();
    expect(computeContextUsed(usage(100), 0)).toBeNull();
  });

  it("computes the fraction and severity for a normal load", () => {
    const r = computeContextUsed(usage(2000), 4000);
    expect(r).not.toBeNull();
    expect(r!.fraction).toBeCloseTo(0.5);
    expect(r!.severity).toBe("ok");
  });

  it("returns warn (yellow) above 60%", () => {
    expect(computeContextUsed(usage(2700), 4000)?.severity).toBe("warn");
  });

  it("returns danger (red) above 80%", () => {
    expect(computeContextUsed(usage(3300), 4000)?.severity).toBe("danger");
  });

  it("clamps fractions above 1 to 1 (still danger)", () => {
    const r = computeContextUsed(usage(8000), 4000);
    expect(r?.fraction).toBe(1);
    expect(r?.severity).toBe("danger");
  });
});

describe("computeCostUsd", () => {
  const usage: TokenUsageState = {
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    requestCount: 3,
    lastRequestPromptTokens: 0,
  };

  it("returns null when either rate is missing", () => {
    expect(computeCostUsd(usage, {})).toBeNull();
    expect(computeCostUsd(usage, { promptPerMillion: 1 })).toBeNull();
    expect(computeCostUsd(usage, { completionPerMillion: 1 })).toBeNull();
  });

  it("returns null when either rate is zero (off by default)", () => {
    expect(
      computeCostUsd(usage, { promptPerMillion: 0, completionPerMillion: 0 }),
    ).toBeNull();
    expect(
      computeCostUsd(usage, { promptPerMillion: 1, completionPerMillion: 0 }),
    ).toBeNull();
  });

  it("computes total cost when both rates are positive", () => {
    const cost = computeCostUsd(usage, {
      promptPerMillion: 3,
      completionPerMillion: 6,
    });
    expect(cost).toBeCloseTo(3 + 3); // 1M*$3 + 0.5M*$6
  });
});

describe("formatters", () => {
  it("formatTokenCount uses commas under 10k and abbreviates above", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(123)).toBe("123");
    expect(formatTokenCount(1234)).toBe("1,234");
    expect(formatTokenCount(9999)).toBe("9,999");
    expect(formatTokenCount(12345)).toBe("12.3k");
    expect(formatTokenCount(15000)).toBe("15k");
    expect(formatTokenCount(1234567)).toBe("1.2M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });

  it("formatTokenCount handles edge cases", () => {
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(NaN)).toBe("0");
  });

  it("formatPercent rounds to nearest integer percent", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(0.674)).toBe("67%");
    expect(formatPercent(0.999)).toBe("100%");
  });

  it("formatCostUsd picks precision by magnitude", () => {
    expect(formatCostUsd(1.234)).toBe("$1.23");
    expect(formatCostUsd(0.123)).toBe("$0.123");
    expect(formatCostUsd(0.0023)).toBe("$0.0023");
    expect(formatCostUsd(0.00001)).toBe("$0.000010");
  });
});
