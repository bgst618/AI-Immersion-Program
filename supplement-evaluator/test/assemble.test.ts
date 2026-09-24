import { describe, expect, it } from "vitest";
import {
  assembleReports,
  checkContentGuard,
  reasonNamesGoal,
  validateStructure,
  validateSuggestions,
} from "../src/assemble";
import {
  ClaudeToolOutputSchema,
  monthlyBudget,
  type Budget,
  type ClaudeItemOutput,
  type ClaudeSuggestionOutput,
  type ClaudeToolOutput,
  type CompiledItem,
} from "../src/schema";

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
    const output: ClaudeToolOutput = { suggestions: [], items: [item()] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(true);
  });

  it("fails when item count doesn't match", () => {
    const output: ClaudeToolOutput = { suggestions: [], items: [item(), item({ id: "item_2" })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when a current item uses a candidate verdict (fixture 7)", () => {
    const currentCompiled: CompiledItem[] = [{ id: "item_1", name: "magnesium", status: "current" }];
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item({ name: "magnesium", status: "current", verdict: "Take" })],
    };
    expect(validateStructure(currentCompiled, ["improve sleep quality"], output).ok).toBe(false);
  });

  it("fails when goalsAddressed contains a goal the user never stated", () => {
    const output: ClaudeToolOutput = { suggestions: [], items: [item({ goalsAddressed: ["lose weight"] })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when an id outside the input list is returned", () => {
    const output: ClaudeToolOutput = { suggestions: [], items: [item({ id: "item_99" })] };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("fails when the reason never names the goal it's judged against", () => {
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item({ reason: "Well supported by many human RCTs and meta-analyses for this purpose." })],
    };
    expect(validateStructure(compiled, ["build muscle"], output).ok).toBe(false);
  });

  it("passes when goalsAddressed is empty but the reason names a goal from the full list", () => {
    const output: ClaudeToolOutput = {
      suggestions: [],
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
    suggestions: [],
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
    const output: ClaudeToolOutput = { suggestions: [], items: [item()] };
    expect(checkContentGuard(output).ok).toBe(true);
  });

  it("fails on a diet mention in the mechanism, not just the reason", () => {
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item({ mechanism: "May offer modest benefit in individuals with adequate diet." })],
    };
    const result = checkContentGuard(output);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/diet/i);
  });

  it("fails on a diet mention in the reason", () => {
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item({ reason: "Works well for build muscle when paired with a good diet." })],
    };
    expect(checkContentGuard(output).ok).toBe(false);
  });

  it("fails on a brand mention in evidenceType", () => {
    const output: ClaudeToolOutput = { suggestions: [], items: [item({ evidenceType: "Studied using Thorne's formulation" })] };
    const result = checkContentGuard(output);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/brand/i);
  });
});

describe("assembleReports", () => {
  it("forces Don't + Insufficient for a non-mainstream candidate", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "obscure compound", status: "candidate" }];
    const output: ClaudeToolOutput = {
      suggestions: [],
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
      suggestions: [],
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
      suggestions: [],
      items: [item({ confidence: "Insufficient evidence to rate", verdict: "Take" })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Don't");
  });

  it("leaves a well-supported candidate untouched", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = { suggestions: [], items: [item()] };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.verdict).toBe("Take");
    expect(result.items[0]!.confidence).toBe("Strong");
  });

  it("includes the disclaimer", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = { suggestions: [], items: [item()] };
    const result = assembleReports(compiled, output);
    expect(result.disclaimer).toMatch(/not medical advice/i);
  });

  it("passes through budgetFlag=true when no override fires", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "magnesium glycinate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      suggestions: [],
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
      suggestions: [],
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
      suggestions: [],
      items: [item({ confidence: "Insufficient evidence to rate", verdict: "Take", budgetFlag: true })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.budgetFlag).toBe(false);
  });

  it("capitalizes the first letter of the reason", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item({ reason: "supports build muscle per multiple human RCTs." })],
    };
    const result = assembleReports(compiled, output);
    expect(result.items[0]!.reason).toBe("Supports build muscle per multiple human RCTs.");
  });
});

function suggestion(overrides: Partial<ClaudeSuggestionOutput> = {}): ClaudeSuggestionOutput {
  return {
    name: "whey protein",
    goalsAddressed: ["build muscle"],
    confidence: "Moderate",
    evidenceType: "meta-analysis of 49 RCTs",
    estimatedMonthlyCost: 30,
    reason: "For your goal to build muscle, adds modest lean-mass gains in RCTs.",
    mechanism: "Supplies leucine-rich protein that stimulates muscle protein synthesis.",
    ...overrides,
  };
}

describe("validateSuggestions", () => {
  const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine", status: "current" }];
  const goals = ["build muscle"];
  const budget: Budget = { amount: 60, period: "month", currency: "USD" };
  const check = (suggestions: ClaudeSuggestionOutput[], b: Budget = budget) =>
    validateSuggestions(compiled, goals, b, { items: [item()], suggestions });

  it("accepts an empty list and a valid catalog suggestion", () => {
    expect(check([]).ok).toBe(true);
    expect(check([suggestion()]).ok).toBe(true);
  });

  it("rejects an ingredient outside the catalog", () => {
    expect(check([suggestion({ name: "turkesterone" })]).ok).toBe(false);
  });

  it("rejects something the user already takes, even under another name", () => {
    const result = check([suggestion({ name: "creatine monohydrate" })]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already/);
  });

  it("rejects duplicates, including alias duplicates", () => {
    expect(check([suggestion(), suggestion({ name: "whey" })]).ok).toBe(false);
  });

  it("rejects goals the user didn't state, and reasons that don't name the goal", () => {
    expect(check([suggestion({ goalsAddressed: ["lower triglycerides"] })]).ok).toBe(false);
    expect(check([suggestion({ reason: "Adds modest lean-mass gains in RCTs." })]).ok).toBe(false);
  });

  it("rejects suggestions whose combined cost exceeds the monthly budget", () => {
    expect(check([suggestion({ estimatedMonthlyCost: 40 }), suggestion({ name: "casein protein", estimatedMonthlyCost: 30 })]).ok).toBe(false);
    expect(check([suggestion({ estimatedMonthlyCost: 30 })], { amount: 10, period: "week", currency: "USD" }).ok).toBe(true);
    expect(check([suggestion({ estimatedMonthlyCost: 30 })], { amount: 1, period: "month", currency: "USD" }).ok).toBe(false);
  });

  it("converts weekly and yearly budgets to monthly", () => {
    expect(monthlyBudget({ amount: 12, period: "week", currency: "USD" })).toBeCloseTo(52);
    expect(monthlyBudget({ amount: 120, period: "year", currency: "USD" })).toBeCloseTo(10);
  });
});

describe("known-hazard override", () => {
  const goals = ["lose body fat"];

  it("forces Remove + Known hazard for a current DNP item the model rated like weak evidence", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "DNP", status: "current" }];
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [
        item({
          status: "current",
          verdict: "Remove",
          confidence: "Moderate",
          goalsAddressed: goals,
          evidenceType: "a few small human trials",
          reason: "For your goal to lose body fat, evidence is limited and side effects are possible.",
          mechanism: "Raises metabolic rate, increasing energy expenditure.",
        }),
      ],
    };
    const report = assembleReports(compiled, output).items[0]!;
    expect(report.verdict).toBe("Remove");
    expect(report.confidence).toBe("Known hazard");
    expect(report.goalsAddressed).toEqual([]);
    expect(report.budgetFlag).toBe(false);
    expect(report.reason).toMatch(/known hazard/i);
    expect(report.reason).toMatch(/deaths/i);
    expect(report.reason).not.toMatch(/evidence is limited/i);
    expect(report.mechanism).not.toBe("Raises metabolic rate, increasing energy expenditure.");
    expect(report.evidenceType).toMatch(/toxicity/i);
    expect(report.name).toBe("DNP");
  });

  it("forces Don't for a candidate even when the model said Take/Strong with budgetFlag", () => {
    const compiled: CompiledItem[] = [{ id: "item_1", name: "2,4-dinitrophenol", status: "candidate" }];
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item({ verdict: "Take", confidence: "Strong", budgetFlag: true, goalsAddressed: [] })],
    };
    const report = assembleReports(compiled, output).items[0]!;
    expect(report.verdict).toBe("Don't");
    expect(report.confidence).toBe("Known hazard");
    expect(report.budgetFlag).toBe(false);
  });

  it("leaves non-hazard items in the same request untouched", () => {
    const compiled: CompiledItem[] = [
      { id: "item_1", name: "creatine monohydrate", status: "candidate" },
      { id: "item_2", name: "DNP", status: "candidate" },
    ];
    const output: ClaudeToolOutput = {
      suggestions: [],
      items: [item(), item({ id: "item_2", verdict: "Don't", confidence: "Weak", goalsAddressed: [] })],
    };
    const [creatine, dnp] = assembleReports(compiled, output).items;
    expect(creatine!.confidence).toBe("Strong");
    expect(dnp!.confidence).toBe("Known hazard");
  });

  it("the model itself cannot emit Known hazard (code-only value)", () => {
    const parsed = ClaudeToolOutputSchema.safeParse({ suggestions: [], items: [item({ confidence: "Known hazard" as never })] });
    expect(parsed.success).toBe(false);
  });
});

describe("suggestion schema", () => {
  it("only allows Strong or Moderate confidence and at most 3 suggestions", () => {
    const base = { items: [item()] };
    expect(ClaudeToolOutputSchema.safeParse({ ...base, suggestions: [{ ...suggestion(), confidence: "Weak" }] }).success).toBe(false);
    expect(ClaudeToolOutputSchema.safeParse({ ...base, suggestions: Array(4).fill(suggestion()) }).success).toBe(false);
    expect(ClaudeToolOutputSchema.safeParse({ ...base, suggestions: [suggestion()] }).success).toBe(true);
  });
});

describe("suggestions in assembleReports and the content guard", () => {
  const compiled: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];

  it("returns suggestions as Take cards with the catalog's standard name", () => {
    const result = assembleReports(compiled, { items: [item()], suggestions: [suggestion({ name: "whey", reason: "for your goal to build muscle, helps." })] });
    expect(result.suggestions).toEqual([
      expect.objectContaining({ name: "whey protein", status: "suggested", verdict: "Take", reason: "For your goal to build muscle, helps." }),
    ]);
  });

  it("flags diet mentions in a suggestion's mechanism", () => {
    const output = { items: [item()], suggestions: [suggestion({ mechanism: "Helps if your diet is low in protein." })] };
    expect(checkContentGuard(output).ok).toBe(false);
  });
});
