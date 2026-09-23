import { z } from "zod";
import { validateStructure } from "./assemble";
import type { CompiledItem, Intake } from "./schema";
import { ClaudeToolOutputSchema, type ClaudeToolOutput, markerLabel, markerUnit } from "./schema";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 4000;
const TOOL_NAME = "submit_evaluation";

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Submit the per-item supplement evaluation. Must include exactly one entry for every item provided, in the same order.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact item name as given in the input list." },
            status: { type: "string", enum: ["current", "candidate"] },
            isMainstreamHumanTested: {
              type: "boolean",
              description: "True only if there is meaningful mainstream human research on this ingredient.",
            },
            evidenceType: {
              type: "string",
              description: "e.g. 'multiple human RCTs and meta-analyses', 'limited human data', 'animal studies only'.",
            },
            goalsAddressed: {
              type: "array",
              items: { type: "string" },
              description: "Subset of the user's stated goals this item's evidence actually supports. Empty if none.",
            },
            verdict: { type: "string", enum: ["Keep", "Remove", "Take", "Don't"] },
            confidence: {
              type: "string",
              enum: ["Strong", "Moderate", "Weak", "Insufficient evidence to rate"],
            },
            budgetFlag: {
              type: "boolean",
              description:
                "True only if the user's stated budget was the deciding factor in this item's verdict (rule 5). False otherwise, including when the item simply happens to be cheap or expensive.",
            },
            reason: { type: "string", description: "Tied explicitly to the user's goal(s); names the evidence type." },
            mechanism: { type: "string", description: "1-3 plain-language sentences on what it does and how." },
          },
          required: [
            "name",
            "status",
            "isMainstreamHumanTested",
            "evidenceType",
            "goalsAddressed",
            "verdict",
            "confidence",
            "budgetFlag",
            "reason",
            "mechanism",
          ],
        },
      },
    },
    required: ["items"],
  },
} as const;

function formatBudget(intake: Intake): string {
  return `${intake.budget.amount} ${intake.budget.currency} per ${intake.budget.period}`;
}

function formatBloodWork(intake: Intake): string {
  if (intake.bloodWork.length === 0) return "None provided.";
  return intake.bloodWork
    .map((entry) => `- ${markerLabel(entry.marker)}: ${entry.value} ${markerUnit(entry.marker)}`)
    .join("\n");
}

function buildSystemPrompt(): string {
  return `You are a supplement evidence evaluator. You reason strictly from published human research. You are given a list of items (each already tagged "current" or "candidate") and the user's specific, testable goals.

Rules:
1. Treat each item independently. Evaluate it only against the user's listed goals — ignore any goal it has no plausible relevance to.
2. Use human evidence only. If an ingredient is niche, animal-only, or has thin human data for the relevant goal, set isMainstreamHumanTested=false and confidence="Insufficient evidence to rate".
3. Name the evidence type in "reason" (e.g. "multiple human RCTs", "limited human data", "animal studies only") and pick confidence with this fixed rubric:
   - Strong: multiple human RCTs / meta-analyses with a consistent effect on this goal.
   - Moderate: some human RCTs, mixed or modest effects.
   - Weak: small, few, or low-quality human studies.
   - Insufficient evidence to rate: no meaningful human evidence for THIS goal.
4. Use blood work only when a marker is directly relevant to an item (e.g. low vitamin D supports a vitamin D verdict). Cite the specific value in "reason" when you use it.
5. Budget rule: the user's budget is an ingredient-level estimate, not product pricing. Estimate a typical monthly ingredient-level cost range for each item. If the total estimated cost of everything with a Keep/Take-leaning verdict would exceed the user's stated budget, the items with the weakest evidence (Weak or Insufficient evidence to rate) are the first to be flagged Remove/Don't. When budget was the deciding factor for an item's verdict, set budgetFlag=true on that item and say so in "reason"; otherwise set budgetFlag=false.
6. Never mention brand names, product names, or diet/dietary advice. Never invent citations or study names.
7. Keep "mechanism" to 1-3 plain-language sentences.
8. status determines which verdicts are valid: "current" items must use Keep or Remove; "candidate" items must use Take or Don't. Never mix these up.
9. goalsAddressed must only contain goals from the user's exact goal list (or be empty).
10. Return exactly one item per input item, same names, same order. Do not add or omit items.

Call the ${TOOL_NAME} tool with your evaluation. Do not respond with plain text.`;
}

function buildUserMessage(intake: Intake, items: CompiledItem[]): string {
  const itemLines = items.map((item) => `- ${item.name} (${item.status})`).join("\n");
  return `Items to evaluate:
${itemLines}

User's goals:
${intake.goals.map((g) => `- ${g}`).join("\n")}

Budget: ${formatBudget(intake)}

Blood work:
${formatBloodWork(intake)}`;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: unknown;
}

export class ClaudeCallError extends Error {}
export class ClaudeValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

async function callAnthropic(apiKey: string, messages: AnthropicMessage[]): Promise<any> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
      system: buildSystemPrompt(),
      messages,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: "tool", name: TOOL_NAME },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ClaudeCallError(`Anthropic API error ${response.status}: ${body}`);
  }

  return response.json();
}

function extractToolUse(apiResponse: any): { id: string; input: unknown } {
  const block = (apiResponse?.content ?? []).find((b: any) => b.type === "tool_use" && b.name === TOOL_NAME);
  if (!block) {
    throw new ClaudeCallError("Model response did not include the expected tool_use block");
  }
  return { id: block.id, input: block.input };
}

function validate(
  items: CompiledItem[],
  goals: string[],
  input: unknown,
): { ok: true; data: ClaudeToolOutput } | { ok: false; message: string } {
  const parsed = ClaudeToolOutputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.message };
  }
  const structure = validateStructure(items, goals, parsed.data);
  if (!structure.ok) {
    return { ok: false, message: structure.message! };
  }
  return { ok: true, data: parsed.data };
}

// Steps 3-6: one Claude call, forced tool use, validated (schema + structure)
// and retried once on failure per PLAN.md §5/§9 (fixture 7).
export async function evaluateWithClaude(
  apiKey: string,
  intake: Intake,
  items: CompiledItem[],
): Promise<ClaudeToolOutput> {
  const messages: AnthropicMessage[] = [{ role: "user", content: buildUserMessage(intake, items) }];

  const first = await callAnthropic(apiKey, messages);
  const firstToolUse = extractToolUse(first);
  const firstResult = validate(items, intake.goals, firstToolUse.input);
  if (firstResult.ok) return firstResult.data;

  // Retry once with the validation error appended, per spec.
  const retryMessages: AnthropicMessage[] = [
    ...messages,
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: firstToolUse.id,
          is_error: true,
          content: `Your submission failed validation: ${firstResult.message}. Call ${TOOL_NAME} again with corrected input that satisfies the schema exactly.`,
        },
      ],
    },
  ];

  const second = await callAnthropic(apiKey, retryMessages);
  const secondToolUse = extractToolUse(second);
  const secondResult = validate(items, intake.goals, secondToolUse.input);
  if (secondResult.ok) return secondResult.data;

  throw new ClaudeValidationError(secondResult.message);
}
