import { findIngredient, normalizeTerm } from "./catalog";
import { markerLabel, markerUnit, type BloodMarkerKey, type BloodWorkEntry } from "./schema";

// Hardcoded sufficiency targets for each dropdown marker (Decision #3). A value
// at or above the target means the user is already where supplementation
// would aim to get them. Record<> forces a target for every marker.
export const MARKER_TARGETS: Record<BloodMarkerKey, number> = {
  vitamin_d: 30, // ng/mL 25-OH vitamin D; common sufficiency cutoff
  vitamin_b12: 300, // pg/mL; below ~300 is borderline/low
  ferritin: 50, // ng/mL; Vaucher 2012 fatigue benefit was in women below 50
  omega3_index: 8, // %; >= 8% is the desirable range
};

// Which marker an item's supplement directly raises. Matched on the user's
// name and on the catalog's standard name, so aliases ("cholecalciferol",
// "omega-3") resolve too.
const ITEM_MARKER_PATTERNS: { marker: BloodMarkerKey; pattern: RegExp }[] = [
  { marker: "vitamin_d", pattern: /\b(vitamin d[23]?|vit d[23]?|d3|cholecalciferol|ergocalciferol)\b/ },
  { marker: "vitamin_b12", pattern: /\b(vitamin b12|vit b12|b12|(methyl|cyano|hydroxo|adenosyl)?cobalamin)\b/ },
  { marker: "ferritin", pattern: /\b(iron|ferrous|ferric)\b/ },
  { marker: "omega3_index", pattern: /\b(fish oil|omega 3|krill oil|cod liver oil|algae oil|algal oil|epa|dha)\b/ },
];

export function markerForItem(itemName: string): BloodMarkerKey | undefined {
  const names = [normalizeTerm(itemName)];
  const known = findIngredient(itemName);
  if (known) names.push(normalizeTerm(known.name));
  return ITEM_MARKER_PATTERNS.find(({ pattern }) => names.some((n) => pattern.test(n)))?.marker;
}

export interface MarkerAtTarget {
  marker: BloodMarkerKey;
  value: number;
  target: number;
}

// The user's blood-work entry for this item's marker, if it's already at/above target.
export function markerAtTarget(itemName: string, bloodWork: BloodWorkEntry[]): MarkerAtTarget | undefined {
  const marker = markerForItem(itemName);
  if (!marker) return undefined;
  const entry = bloodWork.find((e) => e.marker === marker);
  const target = MARKER_TARGETS[marker];
  if (!entry || entry.value < target) return undefined;
  return { marker, value: entry.value, target };
}

function withUnit(value: number, marker: BloodMarkerKey): string {
  const unit = markerUnit(marker);
  return unit === "%" ? `${value}%` : `${value} ${unit}`;
}

export function atTargetNote({ marker, value, target }: MarkerAtTarget): string {
  return `Note: your ${markerLabel(marker)} is ${withUnit(value, marker)}, already at or above the typical target of ${withUnit(target, marker)}, so the benefit of adding more is uncertain and confidence is capped at Moderate.`;
}
