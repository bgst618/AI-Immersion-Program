import { describe, expect, it } from "vitest";
import { IntakeSchema } from "../src/schema";

const validBudget = { amount: 40, period: "month", currency: "USD" };

describe("IntakeSchema", () => {
  it("accepts a well-formed intake", () => {
    const result = IntakeSchema.safeParse({
      stack: ["multivitamin", "fish oil"],
      goals: ["build muscle"],
      budget: validBudget,
      candidates: ["creatine monohydrate"],
      bloodWork: [{ marker: "vitamin_d", value: 18 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level keys (e.g. diet)", () => {
    const result = IntakeSchema.safeParse({
      goals: ["build muscle"],
      budget: validBudget,
      diet: "keto",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys nested in budget", () => {
    const result = IntakeSchema.safeParse({
      goals: ["build muscle"],
      budget: { ...validBudget, productName: "Brand X" },
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one goal", () => {
    const result = IntakeSchema.safeParse({ goals: [], budget: validBudget });
    expect(result.success).toBe(false);
  });

  it("rejects when stack and candidates are both empty", () => {
    const result = IntakeSchema.safeParse({
      stack: [],
      goals: ["build muscle"],
      budget: validBudget,
      candidates: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bloodwork marker not in the fixed dropdown", () => {
    const result = IntakeSchema.safeParse({
      goals: ["build muscle"],
      stack: ["multivitamin"],
      budget: validBudget,
      bloodWork: [{ marker: "not_a_real_marker", value: 5 }],
    });
    expect(result.success).toBe(false);
  });
});
