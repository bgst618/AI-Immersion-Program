// Vague-goal patterns. No longer on the request path: goals must be exact
// entries from the curated goal list (catalog.json, enforced by GoalSchema in
// schema.ts), so nothing off-list can be submitted. Kept as defense-in-depth
// on the list itself — test/catalog.test.ts fails if a vague goal is ever
// added to it. Extend VAGUE_PATTERNS to broaden coverage.
// Stems match at the start of a word with any ending, so "health" also catches
// "healthy"/"healthier" and "well" catches "wellness"/"well-being" — exact
// words let "get healthy" through (red-team #6). Word-start only, so
// "reduce swelling" is not caught by "well". "better" is only vague with
// nothing specific attached ("feel better", "be better"); "sleep better" and
// "recover better" name a testable target and pass.
const VAGUE_PATTERNS: RegExp[] = [
  /\bhealth/i,
  /\bwell/i,
  /\boverall/i,
  /\bgeneral/i,
  /\b(feel|be|get|do|live|look)(ing)?\s+better\b/i,
  /^\s*(a\s+)?better(\s+(me|myself|life|living|overall))?\s*$/i,
  /\blongevity/i,
  /\blifespan/i,
  /\bliv(e|ing) long/i,
];

export function isVagueGoal(goal: string): boolean {
  return VAGUE_PATTERNS.some((pattern) => pattern.test(goal));
}
