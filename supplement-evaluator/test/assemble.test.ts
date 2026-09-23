import { describe, expect, it } from "vitest";
import { assembleReports, validateStructure } from "../src/assemble";
import type { ClaudeItemOutput, ClaudeToolOutput, CompiledItem } from "../src/schema";

function item(overrides: Partial<ClaudeItemOutput> = {}): ClaudeItemOutput {
  return {
    name: "creatine monohydrate",
    status: "candidate",
    isMainstreamHumanTested: true,
    evidenceType: "multiple human RCTs and meta-analyses",
    goalsAddressed: ["build muscle"],
    verdict: "Take",
    confidence: "Strong",
    reason: "Consistently improves strength gains from resistance training toward 'build muscle'.",
    mechanism: "Increases phosphocreatine stores in muscle, supporting ATP regeneration during high-intensity effort.",
    ...overrides,
  };
}

describe("validateStructure", () => {
  const compiled: CompiledItem[] = [{ name: "creatine monohydrate", status: "candidate" }];

  it("passes for a well-formed matching output", () => {
    const output: ClaudeToolOutput = { items: [item()] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(true);
  });

  it("fails when item count doesn't match", () => {
    const output: ClaudeToolOutput = { items: [item(), item({ name: "extra thing" })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when a current item uses a candidate verdict (fixture 7)", () => {
    const currentCompiled: CompiledItem[] = [{ name: "magnesium", status: "current" }];
    const output: ClaudeToolOutput = {
      items: [item({ name: "magnesium", status: "current", verdict: "Take" })],
    };
    expect(validateStructure(currentCompiled, ["improve sleep quality"], output).ok).toBe(false);
  });

  it("fails when goalsAddressed contains a goal the user never stated", () => {
    const output: ClaudeToolOutput = { items: [item({ goalsAddressed: ["lose weight"] })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when an item outside the input list is returned", () => {
    const output: ClaudeToolOutput = { items: [item({ name: "unknown ingredient" })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });
});

describe("assembleReports", () => {
  it("forces Don't + Insufficient for a non-mainstream candidate", () => {
    const compiled: CompiledItem[] = [{ name: "obscure compound", status: "candidate" }];
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
    const compiled: CompiledItem[] = [{ name: "magnesium", status: "current" }];
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
    const compiled: CompiledItem[] = [{ name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      items: [item({ confidence: "Insufficient evidence to rate", verdict: "Take" })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Don't");
  });

  it("leaves a well-supported candidate untouched", () => {
    const compiled: CompiledItem[] = [{ name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = { items: [item()] };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Take");
    expect(result.items[0]!.confidence).toBe("Strong");
  });

  it("includes the disclaimer", () => {
    const compiled: CompiledItem[] = [{ name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = { items: [item()] };
    const result = assembleReports(compiled, output);
    expect(result.disclaimer).toMatch(/not medical advice/i);
  });
});
