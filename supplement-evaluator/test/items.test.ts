import { describe, expect, it } from "vitest";
import { compileItems } from "../src/items";

describe("compileItems", () => {
  it("flags stack items as current and candidates as candidate", () => {
    const items = compileItems(["multivitamin", "fish oil"], ["creatine monohydrate"]);
    expect(items).toEqual([
      { name: "multivitamin", status: "current" },
      { name: "fish oil", status: "current" },
      { name: "creatine monohydrate", status: "candidate" },
    ]);
  });

  it("dedupes case-insensitively within stack", () => {
    const items = compileItems(["Fish Oil", "fish oil"], []);
    expect(items).toHaveLength(1);
  });

  it("treats an item already in the stack as current, not candidate", () => {
    const items = compileItems(["creatine monohydrate"], ["Creatine Monohydrate"]);
    expect(items).toEqual([{ name: "creatine monohydrate", status: "current" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(compileItems([], [])).toEqual([]);
  });
});
