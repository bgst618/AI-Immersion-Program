import type { CompiledItem } from "./schema";

// Step 2: build the deduped item list the model will evaluate, with stable ids.
// - stack entries dedupe case-insensitively against each other.
// - candidate entries dedupe case-insensitively against each other AND against
//   the stack: if the user already takes it, it's "current", not a candidate.
export function compileItems(stack: string[], candidates: string[]): CompiledItem[] {
  const items: CompiledItem[] = [];
  const seen = new Set<string>();

  for (const raw of stack) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    items.push({ id: `item_${items.length + 1}`, name, status: "current" });
  }

  for (const raw of candidates) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    items.push({ id: `item_${items.length + 1}`, name, status: "candidate" });
  }

  return items;
}
