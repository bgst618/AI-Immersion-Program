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
