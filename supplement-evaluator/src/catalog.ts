// The curated catalog lives in public/ so the browser can fetch it as a static
// asset; the Worker imports the same file so there is one source of truth.
import catalog from "../public/catalog.json";

export interface CatalogIngredient {
  name: string;
  aliases: string[];
}

export const INGREDIENTS: CatalogIngredient[] = catalog.ingredients;
export const GOALS: string[] = catalog.goals;
export const BRANDS: string[] = catalog.brands;

// Keep in sync with normalizeTerm in public/app.js.
export function normalizeTerm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.\-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BY_TERM = new Map<string, CatalogIngredient>();
for (const ingredient of INGREDIENTS) {
  for (const term of [ingredient.name, ...ingredient.aliases]) {
    BY_TERM.set(normalizeTerm(term), ingredient);
  }
}

// Exact name-or-alias lookup: "vit D" -> vitamin D3, "creatine" -> creatine monohydrate.
export function findIngredient(text: string): CatalogIngredient | undefined {
  return BY_TERM.get(normalizeTerm(text));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const BRAND_PATTERN = new RegExp(`\\b(${BRANDS.map(escapeRegExp).join("|")})\\b`, "i");
