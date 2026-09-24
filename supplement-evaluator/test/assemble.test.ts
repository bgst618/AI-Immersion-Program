import { describe, expect, it } from "vitest";
import { assembleReports, checkContentGuard, reasonNamesGoal, validateStructure } from "../src/assemble";
import type { ClaudeItemOutput, ClaudeToolOutput, CompiledItem } from "../src/schema";

function item(overrides: Partial<ClaudeItemOutput> = {}): ClaudeItemOutput {
  return {
    id: "item_1",
    status: "candidate",
    isMainstreamHumanTested: true,
    evidenceType: "multiple human RCTs and meta-analyses",
    goalsAddressed: ["build muscle"],
    verdict: "Take",
    confidence: "Strong",
    budgetFlag: false,
    reason: "Consistently improves strength gains from resistance training toward 'build muscle'.",
    mechanism: "Increases phosphocreatine stores in muscle, supporting ATP regeneration during high-intensity effort.",
    ...overrides,
  };
}

describe("validateStructure", () => {
  const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];

  it("passes for a well-formed matching output", () => {
    const output: ClaudeToolOutput = { items: [item()] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(true);
  });

  it("fails when item count doesn't match", () => {
    const output: ClaudeToolOutput = { items: [item(), item({ id: "item_2" })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when a current item uses a candidate verdict (fixture 7)", () => {
    const currentCompiled: CompiledItem[] = [{ id: "item_1", name: "magnesium", status: "current" }];
    const output: ClaudeToolOutput = {
      items: [item({ name: "magnesium", status: "current", verdict: "Take" })],
    };
    expect(validateStructure(currentCompiled, ["improve sleep quality"], output).ok).toBe(false);
  });

  it("fails when goalsAddressed contains a goal the user never stated", () => {
    const output: ClaudeToolOutput = { items: [item({ goalsAddressed: ["lose weight"] })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when an id outside the input list is returned", () => {
    const output: ClaudeToolOutput = { items: [item({ id: "item_99" })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when the reason never names the goal it's judged against", () => {
    const output: ClaudeToolOutput = {
      items: [item({ reason: "Well supported by many human RCTs and meta-analyses for this purpose." })],
    };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("passes when goalsAddressed is empty but the reason names a goal from the full list", () => {
    const output: ClaudeToolOutput = {
      items: [
        item({
          goalsAddressed: [],
          confidence: "Insufficient evidence to rate",
          reason: "No meaningful human evidence exists for your goal to build muscle.",
        }),
      ],
    };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(true);
  });
});

describe("renamed items (short names like \"creatine\")", () => {
  const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine", status: "current" }];
  const renamed: ClaudeToolOutput = {
    items: [
      item({
        name: "creatine monohydrate",
        status: "current",
        verdict: "Keep",
        reason: "Building muscle: creatine monohydrate is backed by multiple independent RCTs.",
      }),
    ],
  };

  it("passes validation when the model renames the item but keeps its id", () => {
    expect(validateStructure(compiled, ["build muscle"], renamed).ok).toBe(true);
  });

  it("restores the user's original name from the id", () => {
    expect(assembleReports(compiled, renamed).items[0]!.name).toBe("creatine");
  });
});

describe("reasonNamesGoal", () => {
  it("accepts inflected forms of the goal's words", () => {
    expect(reasonNamesGoal("Building muscle: strong evidence.", "build muscle")).toBe(true);
    expect(reasonNamesGoal("It improves sleep quality in RCTs.", "improve sleep quality")).toBe(true);
    expect(reasonNamesGoal("Lowers triglyceride levels.", "lower triglycerides")).toBe(true);
  });

  it("rejects a reason missing one of the goal's content words", () => {
    expect(reasonNamesGoal("No evidence it improves sleep.", "improve sleep quality")).toBe(false);
    expect(reasonNamesGoal("Strong evidence for strength gains.", "build muscle")).toBe(false);
  });
});

describe("checkContentGuard", () => {
  it("passes clean output", () => {
    const output: ClaudeToolOutput = { items: [item()] };
    expect(checkContentGuard(output).ok).toBe(true);
  });

  it("fails on a diet mention in the mechanism, not just the reason", () => {
    const output: ClaudeToolOutput = {
      items: [item({ mechanism: "May offer modest benefit in individuals with adequate diet." })],
    };
    const result = checkContentGuard(output);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/diet/i);
  });

  it("fails on a diet mention in the reason", () => {
    const output: ClaudeToolOutput = {
      items: [item({ reason: "Works well for build muscle when paired with a good diet." })],
    };
    expect(checkContentGuard(output).ok).toBe(false);
  });

  it("fails on a brand mention in evidenceType", () => {
    const output: ClaudeToolOutput = { items: [item({ evidenceType: "Studied using Thorne's formulation" })] };
    const result = checkContentGuard(output);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/brand/i);
  });
});

describe("assembleReports", () => {
  it("forces Don't + Insufficient for a non-mainstream candidate", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "obscure compound", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [
        item({
          name: "obscure compound",
          isMainstreamHumanTested: false,
          verdict: "Take",
          confidence: "Weak",
        }),
      ],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Don't");
    expect(result.items[0]!.confidence).toBe("Insufficient evidence to rate");
  });

  it("forces Remove for a current item with insufficient evidence", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "magnesium", status: "current" }];
    const output: ClaudeToolOutput = {
      items: [
        item({
          name: "magnesium",
          status: "current",
          verdict: "Keep",
          confidence: "Insufficient evidence to rate",
        }),
      ],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Remove");
  });

  it("forces Don't for a candidate with insufficient evidence", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [item({ confidence: "Insufficient evidence to rate", verdict: "Take" })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Don't");
  });

  it("leaves a well-supported candidate untouched", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = { items: [item()] };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Take");
    expect(result.items[0]!.confidence).toBe("Strong");
  });

  it("includes the disclaimer", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = { items: [item()] };
    const result = assembleReports(compiled, output);
    expect(result.disclaimer).toMatch(/not medical advice/i);
  });

  it("passes through budgetFlag=true when no override fires", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "magnesium glycinate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [
        item({
          name: "magnesium glycinate",
          confidence: "Moderate",
          verdict: "Take",
          budgetFlag: true,
        }),
      ],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.budgetFlag).toBe(true);
  });

  it("clears budgetFlag when the niche-candidate override fires", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "obscure compound", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [
        item({
          name: "obscure compound",
          isMainstreamHumanTested: false,
          verdict: "Take",
          confidence: "Weak",
          budgetFlag: true,
        }),
      ],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.budgetFlag).toBe(false);
  });

  it("clears budgetFlag when the insufficient-evidence override fires", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [item({ confidence: "Insufficient evidence to rate", verdict: "Take", budgetFlag: true })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.budgetFlag).toBe(false);
  });

  it("capitalizes the first letter of the reason", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [item({ reason: "supports build muscle per multiple human RCTs." })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.reason).toBe("Supports build muscle per multiple human RCTs.");
  });
});
