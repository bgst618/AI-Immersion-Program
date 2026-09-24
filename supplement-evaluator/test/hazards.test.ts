import { describe, expect, it } from "vitest";
import { findHazard } from "../src/hazards";

describe("findHazard", () => {
  it("matches DNP by name, abbreviation, and punctuation variants", () => {
    for (const input of ["DNP", "dnp", "2,4-dinitrophenol", "2,4-Dinitrophenol", "2 4 dinitrophenol", "dinitrophenol", "2,4 DNP"]) {
      expect(findHazard(input)?.name, input).toBe("DNP (2,4-dinitrophenol)");
    }
  });

  it("matches the hazard as a whole word inside longer input", () => {
    expect(findHazard("DNP 200mg capsules")).toBeDefined();
    expect(findHazard("fat burner (DNP)")).toBeDefined();
  });

  it("does not match ordinary ingredients or words that merely contain the letters", () => {
    for (const input of ["creatine monohydrate", "fish oil", "vitamin D3", "dnpx", "adnp"]) {
      expect(findHazard(input), input).toBeUndefined();
    }
  });
});
