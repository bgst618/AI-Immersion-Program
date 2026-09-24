// Drugs that aren't supplements: controlled substances, and prescription-only
// medications that turn up in supplement stacks. Unlike hazards.ts (toxic
// compounds sold as supplements, which still get a forced warning card), these
// are refused outright: IntakeSchema rejects the request with 400
// denied_substance before the model sees it. Every other name —
// niche, misspelled, or made up — still goes to the model, flagged
// [unrecognized] by items.ts when it isn't on the known-ingredient list.
//
// Keep it short and unambiguous. Terms match as whole words anywhere in the
// user's input ("nicotine gum", "Adderall 20mg"); terms longer than 5 letters
// also tolerate a small typo ("cocain", "c0caine"), and spacing is ignored as
// a fallback ("c o c a i n e"). test/denylist.test.ts checks that no catalog
// or known ingredient trips a match — run it after adding a term.
import { withinEditDistance } from "./items";

export type DeniedKind = "controlled" | "prescription";

export interface DeniedSubstance {
  name: string; // shown in the error message
  kind: DeniedKind; // picks the message the user sees
  terms: string[]; // lowercase generic names, abbreviations, and brand names
}

type Entry = Omit<DeniedSubstance, "kind">;

// Controlled substances and recreational drugs.
const CONTROLLED: Entry[] = [
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

// Prescription-only medications. The safety concern is the controlled-
// substance kind, not "weak evidence": rated like a supplement, a prescribed
// drug could come back "Not needed for your goals". They're refused with
// their own message — don't start, stop, or change it without your
// prescriber. Not exhaustive: an unlisted drug still goes to the model.
const PRESCRIPTION: Entry[] = [
  { name: "metformin", terms: ["metformin", "glucophage"] },
  { name: "rapamycin", terms: ["rapamycin", "sirolimus"] },
  { name: "acarbose", terms: ["acarbose"] },
  {
    name: "a GLP-1 medication",
    terms: ["semaglutide", "tirzepatide", "liraglutide", "ozempic", "wegovy", "rybelsus", "mounjaro", "zepbound", "saxenda"],
  },
  {
    name: "a statin",
    terms: ["statin", "atorvastatin", "rosuvastatin", "simvastatin", "pravastatin", "lipitor", "crestor", "zocor"],
  },
  { name: "a 5-alpha-reductase inhibitor", terms: ["finasteride", "dutasteride", "propecia", "proscar", "avodart"] },
  { name: "a PDE5 inhibitor", terms: ["sildenafil", "tadalafil", "vardenafil", "viagra", "cialis"] },
  {
    name: "a hormone-modulating drug",
    terms: ["clomiphene", "enclomiphene", "clomid", "tamoxifen", "nolvadex", "anastrozole", "arimidex", "letrozole", "hcg"],
  },
  { name: "a thyroid medication", terms: ["levothyroxine", "synthroid", "liothyronine", "cytomel"] },
  {
    name: "a blood thinner",
    terms: ["warfarin", "apixaban", "eliquis", "rivaroxaban", "xarelto", "clopidogrel", "plavix"],
  },
  {
    name: "an antidepressant",
    terms: ["sertraline", "zoloft", "fluoxetine", "prozac", "escitalopram", "lexapro", "citalopram", "paroxetine", "bupropion", "wellbutrin"],
  },
];

export const DENIED_SUBSTANCES: DeniedSubstance[] = [
  ...CONTROLLED.map((entry) => ({ ...entry, kind: "controlled" as const })),
  ...PRESCRIPTION.map((entry) => ({ ...entry, kind: "prescription" as const })),
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
