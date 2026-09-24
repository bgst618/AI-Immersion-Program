import { describe, expect, it } from "vitest";
import { BRAND_PATTERN, GOALS, INGREDIENTS, findIngredient, normalizeTerm } from "../src/catalog";
import { isVagueGoal } from "../src/goals";

describe("catalog", () => {
  it("every goal on the allowlist is specific (passes the vague-goal patterns)", () => {
    for (const goal of GOALS) expect(isVagueGoal(goal), goal).toBe(false);
  });

  it("has no duplicate goals", () => {
    expect(new Set(GOALS.map(normalizeTerm)).size).toBe(GOALS.length);
  });

  it("no name or alias maps to two different ingredients", () => {
    const owner = new Map<string, string>();
    for (const ingredient of INGREDIENTS) {
      for (const term of [ingredient.name, ...ingredient.aliases]) {
        const key = normalizeTerm(term);
        expect(owner.get(key) ?? ingredient.name, `"${term}"`).toBe(ingredient.name);
        owner.set(key, ingredient.name);
      }
    }
  });

  it("no ingredient name or alias looks like a brand", () => {
    for (const ingredient of INGREDIENTS) {
      for (const term of [ingredient.name, ...ingredient.aliases]) {
        expect(BRAND_PATTERN.test(term), term).toBe(false);
      }
    }
  });

  it("resolves aliases to the standard name", () => {
    expect(findIngredient("vit D")?.name).toBe("vitamin D3");
    expect(findIngredient("Creatine")?.name).toBe("creatine monohydrate");
    expect(findIngredient("beta alanine")?.name).toBe("beta-alanine");
    expect(findIngredient("turkesterone")).toBeUndefined();
  });

  it("detects brand names inside longer input", () => {
    expect(BRAND_PATTERN.test("Optimum Nutrition Gold Standard Whey")).toBe(true);
    expect(BRAND_PATTERN.test("whey protein")).toBe(false);
  });
});
