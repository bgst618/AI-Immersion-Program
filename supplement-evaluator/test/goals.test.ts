import { describe, expect, it } from "vitest";
import { isVagueGoal } from "../src/goals";

describe("isVagueGoal", () => {
  it("rejects vague wellness goals", () => {
    expect(isVagueGoal("be healthier")).toBe(true);
    expect(isVagueGoal("general health")).toBe(true);
    expect(isVagueGoal("overall wellness")).toBe(true);
    expect(isVagueGoal("feel better")).toBe(true);
  });

  it("rejects inflected and related forms, not just exact words (red-team #6)", () => {
    for (const goal of ["get healthy", "healthy", "Be Healthy", "be well", "wellbeing", "improve well-being", "live longer", "living longer", "longevity", "extend lifespan", "generally feel good", "be better"]) {
      expect(isVagueGoal(goal), goal).toBe(true);
    }
  });

  it("rejects a bare or generic 'better', but not 'better' attached to a specific target", () => {
    for (const goal of ["feel better", "feeling better", "get better", "better", "a better me", "live better"]) {
      expect(isVagueGoal(goal), goal).toBe(true);
    }
    for (const goal of ["sleep better", "recover better between sessions", "focus better at work", "better sleep quality"]) {
      expect(isVagueGoal(goal), goal).toBe(false);
    }
  });

  it("does not reject specific goals that merely contain a stem mid-word", () => {
    expect(isVagueGoal("reduce swelling")).toBe(false);
    expect(isVagueGoal("reduce knee swelling after runs")).toBe(false);
  });

  it("accepts specific, testable goals", () => {
    expect(isVagueGoal("build muscle")).toBe(false);
    expect(isVagueGoal("improve sleep quality")).toBe(false);
    expect(isVagueGoal("lower resting heart rate")).toBe(false);
  });
});
