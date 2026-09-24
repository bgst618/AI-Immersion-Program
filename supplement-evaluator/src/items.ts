import { INGREDIENTS } from "./catalog";
import { HAZARDS } from "./hazards";
import { KNOWN_INGREDIENTS } from "./ingredients-known";
import type { CompiledItem } from "./schema";

// Step 2: build the deduped item list the model will evaluate, with stable ids.
// - stack entries dedupe case-insensitively against each other.
// - candidate entries dedupe case-insensitively against each other AND against
//   the stack: if the user already takes it, it's "current", not a candidate.
// - items that don't resemble any known ingredient are flagged `unrecognized`
//   so the model must confirm the substance exists before rating it (rule 15).
export function compileItems(stack: string[], candidates: string[]): CompiledItem[] {
  const items: CompiledItem[] = [];
  const seen = new Set<string>();

  for (const raw of stack) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    items.push(withRecognition({ id: `item_${items.length + 1}`, name, status: "current" }));
  }

  for (const raw of candidates) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    items.push(withRecognition({ id: `item_${items.length + 1}`, name, status: "candidate" }));
  }

  return items;
}

function withRecognition(item: CompiledItem): CompiledItem {
  return isRecognizedIngredient(item.name) ? item : { ...item, unrecognized: true };
}

// --- Recognition pre-check (red-team #4) -----------------------------------

// Lowercase, punctuation -> spaces, and drop dose/form words so
// "Ashwagandha 600mg capsules" is compared as "ashwagandha".
const FILLER_WORDS = new Set([
  "mg", "mcg", "g", "iu", "ml", "capsule", "capsules", "tablet", "tablets", "softgel", "softgels",
  "powder", "gummies", "gummy", "supplement", "extract",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER_WORDS.has(w) && !/^\d+(mg|mcg|g|iu|ml)?$/.test(w))
    .join(" ");
}

// catalog.json names/aliases, hazards.ts names, and the wider reference list.
const KNOWN_TERMS: string[] = [
  ...new Set(
    [
      ...INGREDIENTS.flatMap((i) => [i.name, ...i.aliases]),
      ...HAZARDS.flatMap((h) => [h.name, ...h.aliases]),
      ...KNOWN_INGREDIENTS,
    ]
      .map(normalize)
      .filter(Boolean),
  ),
];
const KNOWN_TERM_SET = new Set(KNOWN_TERMS);

// Typo candidates bucketed by first letter (typos rarely hit it), which keeps
// the edit-distance pass cheap enough for the Worker's CPU budget.
const TERMS_BY_INITIAL = new Map<string, string[]>();
for (const term of KNOWN_TERMS) {
  TERMS_BY_INITIAL.set(term[0]!, [...(TERMS_BY_INITIAL.get(term[0]!) ?? []), term]);
}

// Typo tolerance scales with length: short names must match exactly.
function allowedEdits(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return 2;
}

// Levenshtein distance <= max, bailing out as soon as a row exceeds it.
function withinEditDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length]! <= max;
}

// Fuzzy match: the name is, contains as whole words, or is a near-typo of a
// known ingredient ("vitamin D3", "creatine monohydrate 5g", "ashwaganda").
export function isRecognizedIngredient(name: string): boolean {
  const normalized = normalize(name);
  if (!normalized) return false;
  if (KNOWN_TERM_SET.has(normalized)) return true;

  const padded = ` ${normalized} `;
  if (KNOWN_TERMS.some((term) => padded.includes(` ${term} `))) return true;

  const max = allowedEdits(normalized.length);
  const sameInitial = TERMS_BY_INITIAL.get(normalized[0]!) ?? [];
  return max > 0 && sameInitial.some((term) => withinEditDistance(normalized, term, max));
}
