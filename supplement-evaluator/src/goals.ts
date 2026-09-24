// Step 1 enforcement: reject vague, untestable goals in code so the model
// never has to make this judgment call. Extend VAGUE_PATTERNS to broaden coverage.
// Stems match at the start of a word with any ending, so "health" also catches
// "healthy"/"healthier" and "well" catches "wellness"/"well-being" — exact
// words let "get healthy" through (red-team #6). Word-start only, so
// "reduce swelling" is not caught by "well".
// Keep in sync with VAGUE_PATTERNS in public/app.js.
const VAGUE_PATTERNS: RegExp[] = [
  /\bhealth/i,
  /\bwell/i,
  /\boverall/i,
  /\bgeneral/i,
  /\bbetter/i,
  /\blongevity/i,
  /\blifespan/i,
  /\bliv(e|ing) long/i,
];

export interface VagueGoalResult {
  vague: boolean;
  suggestion?: string;
}

export function checkGoal(goal: string): VagueGoalResult {
  const isVague = VAGUE_PATTERNS.some((pattern) => pattern.test(goal));
  if (!isVague) return { vague: false };
  return {
    vague: true,
    suggestion:
      "Try something specific and testable, e.g. 'improve sleep quality', 'build muscle', or 'lower resting heart rate'.",
  };
}

export function findFirstVagueGoal(goals: string[]): { goal: string; suggestion: string } | null {
  for (const goal of goals) {
    const result = checkGoal(goal);
    if (result.vague) {
      return { goal, suggestion: result.suggestion! };
    }
  }
  return null;
}
