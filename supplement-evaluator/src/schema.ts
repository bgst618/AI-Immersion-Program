import { z } from "zod";

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

const trimmedNonEmpty = z.string().trim().min(1).max(200);

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
    goals: z.array(trimmedNonEmpty).min(1).max(5),
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
export type BloodWorkEntry = z.infer<typeof BloodWorkEntrySchema>;

export const ItemStatusSchema = z.enum(["current", "candidate"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

// Step 2 output: the compiled, deduped item list handed to Claude.
export const CompiledItemSchema = z.object({
  name: z.string(),
  status: ItemStatusSchema,
});
export type CompiledItem = z.infer<typeof CompiledItemSchema>;

export const ConfidenceSchema = z.enum(["Strong", "Moderate", "Weak", "Insufficient evidence to rate"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

// Raw shape Claude's tool call must produce, before code-side enforcement (step 7 / assemble.ts).
export const ClaudeItemOutputSchema = z
  .object({
    name: z.string().min(1),
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

export const ClaudeToolOutputSchema = z
  .object({
    items: z.array(ClaudeItemOutputSchema),
  })
  .strict();

export type ClaudeItemOutput = z.infer<typeof ClaudeItemOutputSchema>;
export type ClaudeToolOutput = z.infer<typeof ClaudeToolOutputSchema>;

// Final response shape returned to the browser.
export const ItemReportSchema = z.object({
  name: z.string(),
  status: ItemStatusSchema,
  verdict: z.enum(["Keep", "Remove", "Take", "Don't"]),
  confidence: ConfidenceSchema,
  goalsAddressed: z.array(z.string()),
  evidenceType: z.string(),
  budgetFlag: z.boolean(),
  reason: z.string(),
  mechanism: z.string(),
});
export type ItemReport = z.infer<typeof ItemReportSchema>;

export const EvaluationResponseSchema = z.object({
  items: z.array(ItemReportSchema),
  disclaimer: z.string(),
});
export type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

export const DISCLAIMER =
  "Educational information, not medical advice. Talk to a clinician before starting, stopping, or changing supplements — especially if you are pregnant, on medication, or managing a health condition.";
