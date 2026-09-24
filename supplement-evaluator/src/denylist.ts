// Controlled substances and other drugs that aren't supplements. Unlike
// hazards.ts (toxic compounds sold as supplements, which still get a forced
// warning card), these are refused outright: IntakeSchema rejects the request
// with 400 denied_substance before the model sees it. Every other name —
// niche, misspelled, or made up — still goes to the model, flagged
// [unrecognized] by items.ts when it isn't on the known-ingredient list.
//
// Keep it short and unambiguous. Terms match as whole words anywhere in the
// user's input ("nicotine gum", "Adderall 20mg"); terms longer than 5 letters
// also tolerate a small typo ("cocain", "c0caine"), and spacing is ignored as
// a fallback ("c o c a i n e"). test/denylist.test.ts checks that no catalog
// or known ingredient trips a match — run it after adding a term.
import { withinEditDistance } from "./items";

export interface DeniedSubstance {
  name: string; // shown in the error message
  terms: string[]; // lowercase generic names, abbreviations, and brand names
}

export const DENIED_SUBSTANCES: DeniedSubstance[] = [
  { name: "nicotine", terms: ["nicotine", "tobacco", "snus"] },
  { name: "cocaine", terms: ["cocaine"] },
  { name: "methamphetamine", terms: ["methamphetamine", "meth", "crystal meth", "desoxyn"] },
  { name: "amphetamine", terms: ["amphetamine", "dextroamphetamine", "lisdexamfetamine", "adderall", "vyvanse"] },
  { name: "methylphenidate", terms: ["methylphenidate", "ritalin", "concerta"] },
  { name: "modafinil", terms: ["modafinil", "armodafinil", "provigil", "nuvigil"] },
  { name: "MDMA", terms: ["mdma", "ecstasy", "molly"] },
  {
    name: "an opioid",
    terms: ["opioid", "heroin", "fentanyl", "oxycodone", "oxycontin", "hydrocodone", "morphine", "codeine", "tramadol", "opium"],
  },
  {
    name: "a benzodiazepine",
    terms: ["benzodiazepine", "alprazolam", "xanax", "diazepam", "valium", "clonazepam", "klonopin", "lorazepam", "ativan"],
  },
  { name: "THC (cannabis)", terms: ["thc", "marijuana", "delta 8", "delta 9"] },
  { name: "a psychedelic", terms: ["lsd", "psilocybin", "magic mushrooms", "dmt", "mescaline", "ayahuasca"] },
  { name: "ketamine", terms: ["ketamine"] },
  { name: "GHB", terms: ["ghb", "gamma hydroxybutyrate"] },
  {
    name: "an anabolic steroid",
    terms: [
      "anabolic steroid",
      "trenbolone",
      "nandrolone",
      "oxandrolone",
      "anavar",
      "stanozolol",
      "winstrol",
      "dianabol",
      "methandrostenolone",
      "testosterone cypionate",
      "testosterone enanthate",
    ],
  },
];

// Lowercase, and turn all punctuation into spaces: "Delta-8 THC" -> "delta 8 thc".
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Stricter than items.ts's recognition budget, since a false match here blocks
// a real supplement: 5 letters or fewer must match exactly ("panax" is one
// letter from "xanax"). Taken from the shorter string, so a short word can't
// fuzzy-match a longer term ("moly" vs "molly"), and near-misses stay clear
// ("nicotinic" vs "nicotine" is two edits, over the budget of one).
function typoBudget(length: number): number {
  if (length <= 5) return 0;
  if (length <= 9) return 1;
  return 2;
}

function close(a: string, b: string): boolean {
  return a === b || withinEditDistance(a, b, typoBudget(Math.min(a.length, b.length)));
}

const TERMS = DENIED_SUBSTANCES.flatMap((substance) =>
  substance.terms.map((term) => {
    const words = normalize(term).split(" ");
    return { words, spaceless: words.join(""), substance };
  }),
);

export function findDeniedSubstance(itemName: string): DeniedSubstance | undefined {
  const normalized = normalize(itemName);
  if (!normalized) return undefined;
  const words = normalized.split(" ");
  const spaceless = words.join("");

  for (const { words: termWords, spaceless: termSpaceless, substance } of TERMS) {
    // Every run of input words as long as the term: "crystal meth 1g" contains "crystal meth".
    for (let i = 0; i + termWords.length <= words.length; i++) {
      const window = words.slice(i, i + termWords.length).join(" ");
      if (close(window, termWords.join(" "))) return substance;
    }
    if (close(spaceless, termSpaceless)) return substance;
  }
  return undefined;
}
