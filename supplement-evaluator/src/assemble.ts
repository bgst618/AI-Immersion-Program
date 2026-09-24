import { atTargetNote, markerAtTarget } from "./bloodwork";
import type {
  BloodWorkEntry,
  Budget,
  ClaudeItemOutput,
  ClaudeToolOutput,
  CompiledItem,
  ItemReport,
  SuggestionReport,
} from "./schema";
import { BRAND_PATTERN, findIngredient, normalizeTerm } from "./catalog";
import { findHazard, type Hazard } from "./hazards";
import { DISCLAIMER, EvaluationResponseSchema, KNOWN_HAZARD, monthlyBudget, type EvaluationResponse } from "./schema";

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

// Suggestions must be catalog ingredients (mainstream, never a brand) that the
// user isn't already taking or considering, tied to a stated goal, and
// affordable in total. Confidence (Strong/Moderate) and count (<= 3) are
// enforced by the zod schema. Failures trigger the retry like validateStructure.
export function validateSuggestions(
  compiledItems: CompiledItem[],
  goals: string[],
  budget: Budget,
  output: ClaudeToolOutput,
): StructureCheckResult {
  const alreadyListed = new Set<string>();
  for (const item of compiledItems) {
    alreadyListed.add(normalizeTerm(item.name));
    const known = findIngredient(item.name);
    if (known) alreadyListed.add(normalizeTerm(known.name));
  }

  const seen = new Set<string>();
  let totalCost = 0;
  for (const suggestion of output.suggestions) {
    const label = `Suggestion "${suggestion.name}"`;
    const ingredient = findIngredient(suggestion.name);
    if (!ingredient) {
      return { ok: false, message: `${label} is not in the allowed ingredient list.` };
    }
    const key = normalizeTerm(ingredient.name);
    if (alreadyListed.has(key)) {
      return { ok: false, message: `${label} is already in the user's stack or candidates.` };
    }
    if (seen.has(key)) {
      return { ok: false, message: `${label} is suggested more than once.` };
    }
    seen.add(key);

    const goalCheck = checkGoalTieIn(label, suggestion.goalsAddressed, suggestion.reason, goals);
    if (!goalCheck.ok) return goalCheck;
    totalCost += suggestion.estimatedMonthlyCost;
  }

  const limit = monthlyBudget(budget);
  if (totalCost > limit) {
    return {
      ok: false,
      message: `Suggestions cost about ${totalCost.toFixed(2)} ${budget.currency}/month in total, over the user's ${limit.toFixed(2)} ${budget.currency}/month budget.`,
    };
  }
  return { ok: true };
}

const DIET_PATTERN = /\bdiet(ary|s)?\b/i;
// Brand names come from public/catalog.json (shared with the UI's brand warning).
// Not exhaustive, but any hit is a hard failure, not a log line.

// Rule 6: no diet/brand mentions in reason, mechanism, or evidenceType. This
// is a structural check like validateStructure — a hit triggers the one
// allowed retry in claude.ts instead of silently shipping the violation
// (e.g. a live "...in individuals with adequate diet." reason).
export function checkContentGuard(output: ClaudeToolOutput): StructureCheckResult {
  const entries = [
    ...output.items.map((item) => ({ label: `Item ${item.id}`, fields: item })),
    ...output.suggestions.map((s) => ({ label: `Suggestion "${s.name}"`, fields: s })),
  ];
  for (const { label, fields } of entries) {
    const text = `${fields.reason} ${fields.mechanism} ${fields.evidenceType}`;
    if (DIET_PATTERN.test(text)) {
      return { ok: false, message: `${label} mentions "diet" in reason, mechanism, or evidenceType — not allowed.` };
    }
    if (BRAND_PATTERN.test(text)) {
      return {
        ok: false,
        message: `${label} mentions a brand/product name in reason, mechanism, or evidenceType — not allowed.`,
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

// Known hazards (hazards.ts) replace the model's report wholesale — verdict,
// confidence, and every text field — so no model wording can frame a toxic
// substance as an ordinary weak-evidence supplement. Runs last, after every
// other rule, so nothing can soften it.
function hazardReport(compiled: CompiledItem, hazard: Hazard): ItemReport {
  return {
    name: compiled.name,
    status: compiled.status,
    verdict: compiled.status === "current" ? "Remove" : "Don't",
    confidence: KNOWN_HAZARD,
    goalsAddressed: [],
    evidenceType: "documented human toxicity, including deaths",
    budgetFlag: false,
    reason: `Known hazard, whatever your goals: ${hazard.name} is not a supplement. ${hazard.hazard} Do not take it.`,
    mechanism: hazard.mechanism,
  };
}

// Blood work already at/above target (bloodwork.ts): a Keep/Take can't be
// Strong — the user may not need more — and the reason must cite the value.
// Remove/Don't is left alone ("Remove, Strong: already at 13%" is a sound answer).
function applyBloodWorkCap(compiled: CompiledItem, item: ClaudeItemOutput, bloodWork: BloodWorkEntry[]): ClaudeItemOutput {
  if (item.verdict !== "Keep" && item.verdict !== "Take") return item;
  const atTarget = markerAtTarget(compiled.name, bloodWork);
  if (!atTarget) return item;
  return {
    ...item,
    confidence: item.confidence === "Strong" ? "Moderate" : item.confidence,
    reason: `${item.reason.trimEnd()} ${atTargetNote(atTarget)}`,
  };
}

export function assembleReports(
  compiledItems: CompiledItem[],
  output: ClaudeToolOutput,
  bloodWork: BloodWorkEntry[] = [],
): EvaluationResponse {
  const byId = new Map(output.items.map((item) => [item.id, item] as const));

  const items: ItemReport[] = compiledItems.map((compiled) => {
    const hazard = findHazard(compiled.name);
    if (hazard) return hazardReport(compiled, hazard);

    const raw = byId.get(compiled.id)!;
    const corrected = applyBloodWorkCap(compiled, applyOverrides(raw), bloodWork);
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

  const suggestions: SuggestionReport[] = output.suggestions.map((s) => ({
    name: findIngredient(s.name)?.name ?? s.name,
    status: "suggested",
    verdict: "Take",
    confidence: s.confidence,
    goalsAddressed: s.goalsAddressed,
    evidenceType: s.evidenceType,
    estimatedMonthlyCost: s.estimatedMonthlyCost,
    reason: capitalizeFirstLetter(s.reason),
    mechanism: s.mechanism,
  }));

  const evaluation: EvaluationResponse = { items, suggestions, disclaimer: DISCLAIMER };
  return EvaluationResponseSchema.parse(evaluation);
}
