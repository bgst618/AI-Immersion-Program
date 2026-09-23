// Step 1 enforcement: reject vague, untestable goals in code so the model
// never has to make this judgment call. Extend VAGUE_PATTERNS to broaden coverage.
const VAGUE_PATTERNS: RegExp[] = [
  /\bwellness\b/i,
  /\bhealthier\b/i,
  /\bhealth\b/i,
  /\bfeel better\b/i,
  /\boverall\b/i,
  /\bgeneral\b/i,
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
