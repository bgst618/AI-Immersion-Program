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

  // Matched by id, never by name: the model may legitimately rename an item
  // ("creatine" -> "creatine monohydrate"), which used to fail every time.
  const byId = new Map(compiledItems.map((item) => [item.id, item] as const));
  const seen = new Set<string>();

  for (const out of output.items) {
    const expected = byId.get(out.id);
    if (!expected) {
      return { ok: false, message: `Item id "${out.id}" was not in the input list.` };
    }
    if (seen.has(out.id)) {
      return { ok: false, message: `Item id "${out.id}" was returned more than once.` };
    }
    seen.add(out.id);
    const label = `Item ${out.id} ("${expected.name}")`;

    if (out.status !== expected.status) {
      return {
        ok: false,
        message: `${label} has status "${out.status}" but was submitted as "${expected.status}".`,
      };
    }

    const allowedVerdicts = VALID_VERDICTS_BY_STATUS[expected.status];
    if (!allowedVerdicts.includes(out.verdict)) {
      return {
        ok: false,
        message: `${label} (${expected.status}) has verdict "${out.verdict}"; must be one of ${allowedVerdicts.join(" or ")}.`,
      };
    }

    const goalCheck = checkGoalTieIn(label, out.goalsAddressed, out.reason, goals);
    if (!goalCheck.ok) return goalCheck;
  }

  if (seen.size !== compiledItems.length) {
    return { ok: false, message: "Not every input item was covered exactly once." };
  }

  return { ok: true };
}

const STOPWORDS = new Set(["a", "an", "and", "for", "in", "my", "of", "on", "or", "the", "to", "with", "your"]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function stem(word: string): string {
  return word.replace(/(ing|ed|es|s|e)$/, "") || word;
}

// A reason "names" a goal when every content word of the goal appears in it,
// allowing inflection: "building muscle" names "build muscle", "improves
// sleep quality" names "improve sleep quality".
export function reasonNamesGoal(reason: string, goal: string): boolean {
  const goalStems = words(goal)
    .filter((w) => !STOPWORDS.has(w))
    .map(stem);
  if (goalStems.length === 0) return reason.toLowerCase().includes(goal.toLowerCase());
  const reasonWords = words(reason);
  return goalStems.every((s) => reasonWords.some((w) => w.startsWith(s)));
}

function checkGoalTieIn(
  label: string,
  goalsAddressed: string[],
  reason: string,
  goals: string[],
): StructureCheckResult {
  const goalSet = new Set(goals);
  for (const g of goalsAddressed) {
    if (!goalSet.has(g)) {
      return {
        ok: false,
        message: `${label} lists goalsAddressed "${g}" which is not one of the user's stated goals.`,
      };
    }
  }
  // The reason must name the goal it's judged against. Fall back to the full
  // goal list for Insufficient-evidence items, whose goalsAddressed is often empty.
  const goalsToName = goalsAddressed.length > 0 ? goalsAddressed : goals;
  if (!goalsToName.some((g) => reasonNamesGoal(reason, g))) {
    return {
      ok: false,
      message: `${label}'s reason does not name the goal it's judged against (use the exact wording of one of: ${goalsToName.join(", ")}).`,
    };
  }
  return { ok: true };
}

const DIET_PATTERN = /\bdiet(ary|s)?\b/i;
// Best-effort list of common supplement/vitamin brand names. Not exhaustive
// (see PLAN.md step 6), but any hit here is a hard failure, not a log line.
const BRAND_PATTERN =
  /\b(optimum nutrition|gnc|now foods|nature made|thorne|life extension|garden of life|nordic naturals|kirkland|centrum|nutricost|bulk supplements|transparent labs)\b/i;

// Rule 6: no diet/brand mentions in reason, mechanism, or evidenceType. This
// is a structural check like validateStructure — a hit triggers the one
// allowed retry in claude.ts instead of silently shipping the violation
// (e.g. a live "...in individuals with adequate diet." reason).
export function checkContentGuard(output: ClaudeToolOutput): StructureCheckResult {
  for (const item of output.items) {
    const text = `${item.reason} ${item.mechanism} ${item.evidenceType}`;
    if (DIET_PATTERN.test(text)) {
      return { ok: false, message: `Item ${item.id} mentions "diet" in reason, mechanism, or evidenceType — not allowed.` };
    }
    if (BRAND_PATTERN.test(text)) {
      return {
        ok: false,
        message: `Item ${item.id} mentions a brand/product name in reason, mechanism, or evidenceType — not allowed.`,
      };
    }
  }
  return { ok: true };
}

// Rule 11: normalize capitalization deterministically rather than retrying
// for it — cheap, safe, and never worth burning an API call over.
function capitalizeFirstLetter(text: string): string {
  const match = text.match(/[a-zA-Z]/);
  if (!match) return text;
  const index = text.indexOf(match[0]);
  return text.slice(0, index) + match[0].toUpperCase() + text.slice(index + 1);
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
  const byId = new Map(output.items.map((item) => [item.id, item] as const));

  const items: ItemReport[] = compiledItems.map((compiled) => {
    const raw = byId.get(compiled.id)!;
    const corrected = applyOverrides(raw);
    return {
      name: compiled.name,
      status: compiled.status,
      verdict: corrected.verdict,
      confidence: corrected.confidence,
      goalsAddressed: corrected.goalsAddressed,
      evidenceType: corrected.evidenceType,
      budgetFlag: corrected.budgetFlag,
      reason: capitalizeFirstLetter(corrected.reason),
      mechanism: corrected.mechanism,
    };
  });

  const evaluation: EvaluationResponse = { items, disclaimer: DISCLAIMER };
  return EvaluationResponseSchema.parse(evaluation);
}
