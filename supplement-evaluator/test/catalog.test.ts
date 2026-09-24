import { describe, expect, it } from "vitest";
import { BRAND_PATTERN, GOALS, INGREDIENTS, findIngredient, normalizeTerm } from "../src/catalog";
import { checkGoal } from "../src/goals";

describe("catalog", () => {
  it("every curated goal passes the vague-goal filter", () => {
    for (const goal of GOALS) expect(checkGoal(goal).vague, goal).toBe(false);
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
