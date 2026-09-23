import { describe, expect, it } from "vitest";
import { checkGoal, findFirstVagueGoal } from "../src/goals";

describe("checkGoal", () => {
  it("rejects vague wellness goals", () => {
    expect(checkGoal("be healthier").vague).toBe(true);
    expect(checkGoal("general health").vague).toBe(true);
    expect(checkGoal("overall wellness").vague).toBe(true);
    expect(checkGoal("feel better").vague).toBe(true);
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
