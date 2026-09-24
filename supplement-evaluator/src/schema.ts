import { z } from "zod";
import { GOALS } from "./catalog";

// Fixed dropdown of common blood work markers (Open Decision #3: dropdown, not free text).
// Each marker carries its own unit so the client never has to submit one.
export const BLOOD_MARKERS = [
  { key: "vitamin_d", label: "Vitamin D (25-OH)", unit: "ng/mL" },
  { key: "vitamin_b12", label: "Vitamin B12", unit: "pg/mL" },
  { key: "ferritin", label: "Ferritin", unit: "ng/mL" },
  { key: "omega3_index", label: "Omega-3 Index", unit: "%" },
] as const;

export type BloodMarkerKey = (typeof BLOOD_MARKERS)[number]["key"];

const BLOOD_MARKER_KEYS = BLOOD_MARKERS.map((m) => m.key) as [BloodMarkerKey, ...BloodMarkerKey[]];

export function markerLabel(key: BloodMarkerKey): string {
  return BLOOD_MARKERS.find((m) => m.key === key)!.label;
}

export function markerUnit(key: BloodMarkerKey): string {
  return BLOOD_MARKERS.find((m) => m.key === key)!.unit;
}

// Newlines and other control characters have no place in an ingredient name or
// goal; inside the prompt they let injected text ("\nSYSTEM NOTE: ...") pose
// as a separate instruction line. Reject with a clean 400 instead.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const trimmedNonEmpty = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((text) => !CONTROL_CHARS.test(text), "must be a single line without control characters");

// Goals must be exact entries from the curated goal list in catalog.json — the
// same list the UI's dropdown offers — with no trimming or case folding. The
// server never trusts that the dropdown was used.
export const GoalSchema = z.enum(GOALS as [string, ...string[]]);

export const BudgetSchema = z
  .object({
    amount: z.number().positive().max(100000),
    period: z.enum(["week", "month", "year"]),
    currency: z.string().trim().min(1).max(10),
  })
  .strict();

export const BloodWorkEntrySchema = z
  .object({
    marker: z.enum(BLOOD_MARKER_KEYS),
    value: z.number().finite().nonnegative(),
  })
  .strict();

// Step 1: intake validation. .strict() on every object guarantees no hidden
// field (e.g. "diet") can sneak in anywhere in the payload.
export const IntakeSchema = z
  .object({
    stack: z.array(trimmedNonEmpty).max(15).default([]),
    goals: z.array(GoalSchema).min(1).max(5),
    budget: BudgetSchema,
    candidates: z.array(trimmedNonEmpty).max(5).default([]),
    bloodWork: z.array(BloodWorkEntrySchema).max(BLOOD_MARKERS.length).default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.stack.length + data.candidates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stack and candidates cannot both be empty",
        path: ["stack"],
      });
    }
  });

export type Intake = z.infer<typeof IntakeSchema>;
export type Budget = z.infer<typeof BudgetSchema>;

export interface RejectedEntry {
  field: "stack" | "candidates" | "goals";
  value: string;
}

// Goals that aren't on the goal list, from a failed IntakeSchema parse. Other
// enum fields (blood work marker, budget period) stay ordinary invalid_request errors.
export function findOffListGoals(error: z.ZodError): RejectedEntry[] {
  const rejected: RejectedEntry[] = [];
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.invalid_enum_value && issue.path[0] === "goals") {
      rejected.push({ field: "goals", value: String(issue.received) });
    }
  }
  return rejected;
}

const MONTHS_PER_PERIOD: Record<Budget["period"], number> = { week: 12 / 52, month: 1, year: 12 };

export function monthlyBudget(budget: Budget): number {
  return budget.amount / MONTHS_PER_PERIOD[budget.period];
}
export type BloodWorkEntry = z.infer<typeof BloodWorkEntrySchema>;

export const ItemStatusSchema = z.enum(["current", "candidate"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

// A synonym merged into an item (red-team #7), e.g. candidate "cholecalciferol" -> current "vitamin D3".
export const SubmittedNameSchema = z.object({ name: z.string(), status: ItemStatusSchema });

// Step 2 output: the compiled, deduped item list handed to the model. `id` is
// the only key the model has to echo back; `name` is the user's original
// input, restored onto the final report no matter how the model renames it.
export const CompiledItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: ItemStatusSchema,
  // Set by items.ts when the name matches no known ingredient (red-team #4).
  unrecognized: z.literal(true).optional(),
  // Synonyms merged into this item by items.ts, with the status each was entered under.
  alsoSubmittedAs: z.array(SubmittedNameSchema).optional(),
});
export type CompiledItem = z.infer<typeof CompiledItemSchema>;

export const ConfidenceSchema = z.enum(["Strong", "Moderate", "Weak", "Insufficient evidence to rate"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Set only by code (hazards.ts via assemble.ts), never accepted from the model:
// a known-toxic substance isn't an evidence rating at all.
export const KNOWN_HAZARD = "Known hazard";
export const ReportConfidenceSchema = z.enum([...ConfidenceSchema.options, KNOWN_HAZARD]);
export type ReportConfidence = z.infer<typeof ReportConfidenceSchema>;

// Raw shape Claude's tool call must produce, before code-side enforcement (step 7 / assemble.ts).
export const ClaudeItemOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    status: ItemStatusSchema,
    isMainstreamHumanTested: z.boolean(),
    evidenceType: z.string().min(1).max(200),
    goalsAddressed: z.array(z.string()),
    verdict: z.enum(["Keep", "Remove", "Take", "Don't"]),
    confidence: ConfidenceSchema,
    budgetFlag: z.boolean(),
    reason: z.string().min(1).max(1000),
    mechanism: z.string().min(1).max(1000),
  })
  .strict();

export const SuggestionConfidenceSchema = z.enum(["Strong", "Moderate"]);

export const ClaudeSuggestionOutputSchema = z
  .object({
    name: z.string().min(1),
    goalsAddressed: z.array(z.string()).min(1),
    confidence: SuggestionConfidenceSchema,
    evidenceType: z.string().min(1).max(200),
    estimatedMonthlyCost: z.number().finite().nonnegative(),
    reason: z.string().min(1).max(1000),
    mechanism: z.string().min(1).max(1000),
  })
  .strict();

export const MAX_SUGGESTIONS = 3;

export const ClaudeToolOutputSchema = z
  .object({
    items: z.array(ClaudeItemOutputSchema),
    suggestions: z.array(ClaudeSuggestionOutputSchema).max(MAX_SUGGESTIONS),
  })
  .strict();

export type ClaudeItemOutput = z.infer<typeof ClaudeItemOutputSchema>;
export type ClaudeSuggestionOutput = z.infer<typeof ClaudeSuggestionOutputSchema>;
export type ClaudeToolOutput = z.infer<typeof ClaudeToolOutputSchema>;

// Final response shape returned to the browser.
export const ItemReportSchema = z.object({
  name: z.string(),
  status: ItemStatusSchema,
  verdict: z.enum(["Keep", "Remove", "Take", "Don't"]),
  confidence: ReportConfidenceSchema,
  goalsAddressed: z.array(z.string()),
  evidenceType: z.string(),
  budgetFlag: z.boolean(),
  reason: z.string(),
  mechanism: z.string(),
  alsoSubmittedAs: z.array(SubmittedNameSchema).optional(),
});
export type ItemReport = z.infer<typeof ItemReportSchema>;

export const SuggestionReportSchema = z.object({
  name: z.string(),
  status: z.literal("suggested"),
  verdict: z.literal("Take"),
  confidence: SuggestionConfidenceSchema,
  goalsAddressed: z.array(z.string()),
  evidenceType: z.string(),
  estimatedMonthlyCost: z.number(),
  reason: z.string(),
  mechanism: z.string(),
});
export type SuggestionReport = z.infer<typeof SuggestionReportSchema>;

export const EvaluationResponseSchema = z.object({
  items: z.array(ItemReportSchema),
  suggestions: z.array(SuggestionReportSchema),
  disclaimer: z.string(),
});
export type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

export const DISCLAIMER =
  "Educational information, not medical advice. Talk to a clinician before starting, stopping, or changing supplements — especially if you are pregnant, on medication, or managing a health condition.";
