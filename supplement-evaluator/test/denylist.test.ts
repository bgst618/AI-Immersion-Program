import { describe, expect, it } from "vitest";
import { INGREDIENTS } from "../src/catalog";
import { findDeniedSubstance } from "../src/denylist";
import { HAZARDS } from "../src/hazards";
import { KNOWN_INGREDIENTS } from "../src/ingredients-known";

describe("findDeniedSubstance", () => {
  it("matches the named drugs, their brand names, and common phrasings", () => {
    const cases: [string, string][] = [
      ["cocaine", "cocaine"],
      ["Cocaine", "cocaine"],
      ["nicotine", "nicotine"],
      ["nicotine gum", "nicotine"],
      ["Nicotine pouches 6mg", "nicotine"],
      ["meth", "methamphetamine"],
      ["crystal meth", "methamphetamine"],
      ["Crystal-Meth", "methamphetamine"],
      ["Adderall 20mg", "amphetamine"],
      ["xanax", "a benzodiazepine"],
      ["oxycodone", "an opioid"],
      ["opioids", "an opioid"],
      ["magic mushroom", "a psychedelic"],
      ["delta-8 THC gummies", "THC (cannabis)"],
      ["anabolic steroids", "an anabolic steroid"],
      ["modafinil", "modafinil"],
    ];
    for (const [input, name] of cases) expect(findDeniedSubstance(input)?.name, input).toBe(name);
  });

  it("denies prescription-only medications as their own kind", () => {
    const cases: [string, string][] = [
      ["metformin", "metformin"],
      ["Metformin ER 500mg", "metformin"],
      ["metformn", "metformin"], // one edit; a transposed pair ("metfromin") counts as two
      ["rapamycin", "rapamycin"],
      ["Ozempic", "a GLP-1 medication"],
      ["semaglutide", "a GLP-1 medication"],
      ["rosuvastatin", "a statin"],
      ["finasteride", "a 5-alpha-reductase inhibitor"],
      ["Cialis", "a PDE5 inhibitor"],
      ["clomid", "a hormone-modulating drug"],
      ["levothyroxine", "a thyroid medication"],
      ["warfarin", "a blood thinner"],
      ["sertraline", "an antidepressant"],
    ];
    for (const [input, name] of cases) {
      expect(findDeniedSubstance(input), input).toMatchObject({ name, kind: "prescription" });
    }
    expect(findDeniedSubstance("cocaine")?.kind).toBe("controlled");
  });

  it("tolerates small typos, digit swaps, and spacing tricks on longer names", () => {
    for (const input of ["cocain", "c0caine", "nicotin", "methamphetamin", "adderal", "c o c a i n e", "crystalmeth"]) {
      expect(findDeniedSubstance(input), input).toBeDefined();
    }
  });

  it("matches short names exactly only", () => {
    for (const input of ["moly", "meh", "xanx", "thca"]) expect(findDeniedSubstance(input), input).toBeUndefined();
  });

  it("never denies a catalog ingredient, a known ingredient, or a hazard", () => {
    const names = [
      ...INGREDIENTS.flatMap((i) => [i.name, ...i.aliases]),
      ...KNOWN_INGREDIENTS,
      ...HAZARDS.flatMap((h) => [h.name, ...h.aliases]),
    ];
    for (const name of names) expect(findDeniedSubstance(name)?.name, name).toBeUndefined();
  });

  it("leaves near-miss supplement names alone", () => {
    for (const input of [
      "panax ginseng", // "panax" is one letter from "xanax"
      "nicotinic acid",
      "nicotinamide riboside",
      "horny goat weed",
      "beta-hydroxybutyrate",
      "delta tocopherol",
      "testosterone booster",
      "methylcobalamin",
      "l-methionine",
      "cocoa flavanols",
      "valine",
      "turkesterone",
      "BPC-157",
      "zorbitrex-9",
      "red yeast rice", // a supplement, even though it contains a natural statin
      "saw palmetto",
      "berberine",
      "coumarin",
    ]) {
      expect(findDeniedSubstance(input), input).toBeUndefined();
    }
  });
});
