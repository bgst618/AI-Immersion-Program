import { describe, expect, it } from "vitest";
import { checkGoal, findFirstVagueGoal } from "../src/goals";

describe("checkGoal", () => {
  it("rejects vague wellness goals", () => {
    expect(checkGoal("be healthier").vague).toBe(true);
    expect(checkGoal("general health").vague).toBe(true);
    expect(checkGoal("overall wellness").vague).toBe(true);
    expect(checkGoal("feel better").vague).toBe(true);
  });

  it("rejects inflected and related forms, not just exact words (red-team #6)", () => {
    for (const goal of ["get healthy", "healthy", "Be Healthy", "be well", "wellbeing", "improve well-being", "live longer", "living longer", "longevity", "extend lifespan", "generally feel good", "be better"]) {
      expect(checkGoal(goal).vague, goal).toBe(true);
    }
  });

  it("rejects a bare or generic 'better', but not 'better' attached to a specific target", () => {
    for (const goal of ["feel better", "feeling better", "get better", "better", "a better me", "live better"]) {
      expect(checkGoal(goal).vague, goal).toBe(true);
    }
    for (const goal of ["sleep better", "recover better between sessions", "focus better at work", "better sleep quality"]) {
      expect(checkGoal(goal).vague, goal).toBe(false);
    }
  });

  it("does not reject specific goals that merely contain a stem mid-word", () => {
    expect(checkGoal("reduce swelling").vague).toBe(false);
    expect(checkGoal("reduce knee swelling after runs").vague).toBe(false);
  });

  it("accepts specific, testable goals", () => {
    expect(checkGoal("build muscle").vague).toBe(false);
    expect(checkGoal("improve sleep quality").vague).toBe(false);
    expect(checkGoal("lower resting heart rate").vague).toBe(false);
  });

  it("provides a suggestion when vague", () => {
    const result = checkGoal("be healthier");
    expect(result.suggestion).toMatch(/specific and testable/i);
  });
});

describe("findFirstVagueGoal", () => {
  it("returns null when all goals are specific", () => {
    expect(findFirstVagueGoal(["build muscle", "improve sleep quality"])).toBeNull();
  });

  it("returns the first vague goal found", () => {
    const result = findFirstVagueGoal(["build muscle", "be healthier"]);
    expect(result?.goal).toBe("be healthier");
  });
});
