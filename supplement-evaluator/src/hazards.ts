// Substances with documented human lethality/toxicity independent of any goal.
// These are not "thin evidence" cases: claude.ts never sends a match to the
// model, and assemble.ts writes its verdict, confidence, and text in code, so
// nothing the model writes can soften the warning.
//
// To extend: add an entry with the standard name, every common alias (matched
// as whole words anywhere in the user's input, case- and punctuation-
// insensitive, so "DNP 200mg" still matches), and one factual sentence each
// for `hazard` and `mechanism`. Only add a substance when the toxicity is
// documented in humans (case reports of deaths, regulator warnings) — not for
// ordinary weak-evidence or interaction concerns, which stay the model's job.

export interface Hazard {
  name: string;
  aliases: string[];
  hazard: string;
  mechanism: string;
}

export const HAZARDS: Hazard[] = [
  {
    name: "DNP (2,4-dinitrophenol)",
    aliases: ["DNP", "2,4-dinitrophenol", "2,4 DNP", "dinitrophenol"],
    hazard:
      "It is an industrial chemical sold illegally as a fat burner, with many documented deaths from uncontrollable overheating, and no safe dose has been established.",
    mechanism:
      "It uncouples energy production in cells, so fuel is burned as heat instead of being stored as usable energy. Body temperature can rise uncontrollably, and there is no antidote.",
  },
];

// Lowercase, and turn all punctuation into spaces: "2,4-Dinitrophenol" -> "2 4 dinitrophenol".
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const TERMS: { term: string; hazard: Hazard }[] = HAZARDS.flatMap((hazard) =>
  [hazard.name, ...hazard.aliases].map((alias) => ({ term: normalize(alias), hazard })),
);

export function findHazard(itemName: string): Hazard | undefined {
  const padded = ` ${normalize(itemName)} `;
  return TERMS.find(({ term }) => padded.includes(` ${term} `))?.hazard;
}
