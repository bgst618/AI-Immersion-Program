import { describe, expect, it } from "vitest";
import { MARKER_TARGETS, markerAtTarget, markerForItem } from "../src/bloodwork";
import { BLOOD_MARKERS } from "../src/schema";

describe("markerForItem", () => {
  it("links supplements to the marker they raise, including aliases", () => {
    expect(markerForItem("vitamin D3")).toBe("vitamin_d");
    expect(markerForItem("cholecalciferol")).toBe("vitamin_d");
    expect(markerForItem("vit d")).toBe("vitamin_d");
    expect(markerForItem("methylcobalamin")).toBe("vitamin_b12");
    expect(markerForItem("B12")).toBe("vitamin_b12");
    expect(markerForItem("ferrous bisglycinate")).toBe("ferritin");
    expect(markerForItem("iron")).toBe("ferritin");
    expect(markerForItem("fish oil")).toBe("omega3_index");
    expect(markerForItem("omega-3")).toBe("omega3_index");
    expect(markerForItem("krill oil")).toBe("omega3_index");
  });

  it("returns undefined for items with no directly related marker", () => {
    expect(markerForItem("creatine monohydrate")).toBeUndefined();
    expect(markerForItem("magnesium glycinate")).toBeUndefined();
  });
});

describe("markerAtTarget", () => {
  it("has a target for every dropdown marker", () => {
    for (const m of BLOOD_MARKERS) expect(MARKER_TARGETS[m.key], m.key).toBeGreaterThan(0);
  });

  it("fires at or above the target, not below", () => {
    expect(markerAtTarget("fish oil", [{ marker: "omega3_index", value: 13 }])).toEqual({ marker: "omega3_index", value: 13, target: 8 });
    expect(markerAtTarget("fish oil", [{ marker: "omega3_index", value: 8 }])).toBeDefined();
    expect(markerAtTarget("fish oil", [{ marker: "omega3_index", value: 7.9 }])).toBeUndefined();
    expect(markerAtTarget("vitamin D3", [{ marker: "vitamin_d", value: 29 }])).toBeUndefined();
    expect(markerAtTarget("vitamin D3", [{ marker: "vitamin_d", value: 30 }])).toBeDefined();
  });

  it("ignores blood work for a different marker", () => {
    expect(markerAtTarget("fish oil", [{ marker: "vitamin_d", value: 80 }])).toBeUndefined();
    expect(markerAtTarget("fish oil", [])).toBeUndefined();
  });
});
