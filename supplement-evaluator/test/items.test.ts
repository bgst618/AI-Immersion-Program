import { describe, expect, it } from "vitest";
import { compileItems, isRecognizedIngredient } from "../src/items";

describe("compileItems", () => {
  it("flags stack items as current and candidates as candidate", () => {
    const items = compileItems(["multivitamin", "fish oil"], ["creatine monohydrate"]);
    expect(items).toEqual([
      { id: "item_1", name: "multivitamin", status: "current" },
      { id: "item_2", name: "fish oil", status: "current" },
      { id: "item_3", name: "creatine monohydrate", status: "candidate" },
    ]);
  });

  it("dedupes case-insensitively within stack", () => {
    const items = compileItems(["Fish Oil", "fish oil"], []);
    expect(items).toHaveLength(1);
  });

  it("treats an item already in the stack as current, not candidate", () => {
    const items = compileItems(["creatine monohydrate"], ["Creatine Monohydrate"]);
    expect(items).toEqual([{ id: "item_1", name: "creatine monohydrate", status: "current" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(compileItems([], [])).toEqual([]);
  });
});

describe("synonym merge (red-team #7)", () => {
  it("merges vitamin D3 (current) and cholecalciferol (candidate) into one current item, keeping both visible", () => {
    expect(compileItems(["vitamin D3"], ["cholecalciferol"])).toEqual([
      { id: "item_1", name: "vitamin D3", status: "current", alsoSubmittedAs: [{ name: "cholecalciferol", status: "candidate" }] },
    ]);
  });

  it("merges the other common aliases: B12/cobalamin, fish oil/omega-3", () => {
    expect(compileItems(["B12", "fish oil"], ["cobalamin", "omega-3"])).toEqual([
      { id: "item_1", name: "B12", status: "current", alsoSubmittedAs: [{ name: "cobalamin", status: "candidate" }] },
      { id: "item_2", name: "fish oil", status: "current", alsoSubmittedAs: [{ name: "omega-3", status: "candidate" }] },
    ]);
  });

  it("merges synonyms within the same list and keeps ids sequential", () => {
    expect(compileItems(["cholecalciferol", "vit d", "magnesium glycinate"], [])).toEqual([
      { id: "item_1", name: "cholecalciferol", status: "current", alsoSubmittedAs: [{ name: "vit d", status: "current" }] },
      { id: "item_2", name: "magnesium glycinate", status: "current" },
    ]);
  });

  it("merges two candidate synonyms into one candidate", () => {
    const items = compileItems([], ["vitamin D3", "cholecalciferol"]);
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe("candidate");
  });

  it("doesn't list the same text typed twice as a synonym", () => {
    expect(compileItems(["Vitamin D3"], ["vitamin d3"])).toEqual([{ id: "item_1", name: "Vitamin D3", status: "current" }]);
  });
});

describe("ingredient recognition pre-check (red-team #4)", () => {
  it("flags a made-up ingredient as unrecognized, leaving known ones unflagged", () => {
    expect(compileItems(["fish oil"], ["zorbitrex-9"])).toEqual([
      { id: "item_1", name: "fish oil", status: "current" },
      { id: "item_2", name: "zorbitrex-9", status: "candidate", unrecognized: true },
    ]);
  });

  it("recognizes catalog names, aliases, the wider reference list, and hazards", () => {
    for (const name of ["creatine", "cholecalciferol", "omega-3", "tongkat ali", "lion's mane", "turkesterone", "BPC-157", "DNP"]) {
      expect(isRecognizedIngredient(name), name).toBe(true);
    }
  });

  it("tolerates doses, forms, and small typos (fuzzy match)", () => {
    for (const name of ["Magnesium Glycinate 400mg capsules", "creatine monohydrate 5g", "ashwaganda", "vitamn d3", "berberin"]) {
      expect(isRecognizedIngredient(name), name).toBe(true);
    }
  });

  it("does not fuzzy-match invented names or very short near-misses", () => {
    for (const name of ["zorbitrex-9", "Quantaflex Neuroplex", "florbium", "glimmerroot extract", "zync"]) {
      expect(isRecognizedIngredient(name), name).toBe(false);
    }
  });
});
