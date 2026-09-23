import type { ClaudeItemOutput, ClaudeToolOutput, CompiledItem, ItemReport } from "./schema";
import { DISCLAIMER, EvaluationResponseSchema, type EvaluationResponse } from "./schema";

export interface StructureCheckResult {
  ok: boolean;
  message?: string;
}

const VALID_VERDICTS_BY_STATUS: Record<CompiledItem["status"], ReadonlyArray<ClaudeItemOutput["verdict"]>> = {
  current: ["Keep", "Remove"],
  candidate: ["Take", "Don't"],
};

// Step 7 (part 1): structural checks the model can violate. Any failure here
// should trigger the one allowed retry in claude.ts, not silent correction.
export function validateStructure(
  compiledItems: CompiledItem[],
  goals: string[],
  output: ClaudeToolOutput,
): StructureCheckResult {
  if (output.items.length !== compiledItems.length) {
    return {
      ok: false,
      message: `Expected exactly ${compiledItems.length} item(s), got ${output.items.length}.`,
    };
  }

  const byKey = new Map(compiledItems.map((item) => [item.name.toLowerCase(), item] as const));
  const seen = new Set<string>();

  for (const out of output.items) {
    const key = out.name.toLowerCase();
    const expected = byKey.get(key);
    if (!expected) {
      return { ok: false, message: `Item "${out.name}" was not in the input list.` };
    }
    if (seen.has(key)) {
      return { ok: false, message: `Item "${out.name}" was returned more than once.` };
    }
    seen.add(key);

    if (out.status !== expected.status) {
      return {
        ok: false,
        message: `Item "${out.name}" has status "${out.status}" but was submitted as "${expected.status}".`,
      };
    }

    const allowedVerdicts = VALID_VERDICTS_BY_STATUS[expected.status];
    if (!allowedVerdicts.includes(out.verdict)) {
      return {
        ok: false,
        message: `Item "${out.name}" (${expected.status}) has verdict "${out.verdict}"; must be one of ${allowedVerdicts.join(" or ")}.`,
      };
    }

    const goalSet = new Set(goals);
    for (const g of out.goalsAddressed) {
      if (!goalSet.has(g)) {
        return {
          ok: false,
          message: `Item "${out.name}" lists goalsAddressed "${g}" which is not one of the user's stated goals.`,
        };
      }
    }
  }

  if (seen.size !== compiledItems.length) {
    return { ok: false, message: "Not every input item was covered exactly once." };
  }

  return { ok: true };
}

const DIET_PATTERN = /\bdiet(ary|s)?\b/i;
// Best-effort list of common supplement/vitamin brand names. Not exhaustive;
// this is a flag-and-log guard, not a guarantee (see PLAN.md step 6).
const BRAND_PATTERN =
  /\b(optimum nutrition|gnc|now foods|nature made|thorne|life extension|garden of life|nordic naturals|kirkland|centrum|nutricost|bulk supplements|transparent labs)\b/i;

function flagContentGuard(item: ClaudeItemOutput): void {
  const text = `${item.reason} ${item.mechanism} ${item.evidenceType}`;
  if (DIET_PATTERN.test(text)) {
    console.warn(`content guard: "diet" mentioned for item "${item.name}"`);
  }
  if (BRAND_PATTERN.test(text)) {
    console.warn(`content guard: possible brand name mentioned for item "${item.name}"`);
  }
}

// Step 7 (part 2): deterministic overrides the model doesn't get to negotiate.
function applyOverrides(item: ClaudeItemOutput): ClaudeItemOutput {
  let { verdict, confidence, budgetFlag } = item;

  // Niche candidate rule: no mainstream human testing -> forced Don't / Insufficient.
  // The evidence gap is now the deciding factor, not budget, even if the model thought otherwise.
  if (item.status === "candidate" && !item.isMainstreamHumanTested) {
    verdict = "Don't";
    confidence = "Insufficient evidence to rate";
    budgetFlag = false;
  }

  // Open Decision #2: Insufficient evidence always resolves to Remove/Don't —
  // "no support found", not "proven harmful". Same reasoning: evidence, not budget, decided this.
  if (confidence === "Insufficient evidence to rate") {
    verdict = item.status === "current" ? "Remove" : "Don't";
    budgetFlag = false;
  }

  return { ...item, verdict, confidence, budgetFlag };
}

export function assembleReports(compiledItems: CompiledItem[], output: ClaudeToolOutput): EvaluationResponse {
  const byKey = new Map(output.items.map((item) => [item.name.toLowerCase(), item] as const));

  const items: ItemReport[] = compiledItems.map((compiled) => {
    const raw = byKey.get(compiled.name.toLowerCase())!;
    flagContentGuard(raw);
    const corrected = applyOverrides(raw);
    return {
      name: compiled.name,
      status: compiled.status,
      verdict: corrected.verdict,
      confidence: corrected.confidence,
      goalsAddressed: corrected.goalsAddressed,
      evidenceType: corrected.evidenceType,
      budgetFlag: corrected.budgetFlag,
      reason: corrected.reason,
      mechanism: corrected.mechanism,
    };
  });

  const evaluation: EvaluationResponse = { items, disclaimer: DISCLAIMER };
  return EvaluationResponseSchema.parse(evaluation);
}
