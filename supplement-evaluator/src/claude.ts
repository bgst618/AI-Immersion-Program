import { checkContentGuard, validateStructure } from "./assemble";
import type { CompiledItem, Intake } from "./schema";
import { ClaudeToolOutputSchema, type ClaudeToolOutput, markerLabel, markerUnit } from "./schema";

// NVIDIA's build.nvidia.com endpoint is OpenAI-compatible (Chat Completions API).
const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MAX_TOKENS = 4000;
const TEMPERATURE = 0;
const TOOL_NAME = "submit_evaluation";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_BASE_MS = 1000;

// meta/llama-3.1-70b-instruct was retired from NVIDIA's catalog; this has
// reliable, well-documented function/tool calling support. Override without
// a code change via the MODEL env var (Worker: wrangler.jsonc `vars.MODEL` /
// a secret; eval script: process.env.MODEL or .dev.vars) — an empty MODEL is
// treated as unset (see resolveModel below / eval/run-eval.ts).
export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

// Empty string counts as "unset" — a blank workflow_dispatch input or an
// unset-but-present wrangler var both resolve to "", which must fall back to
// DEFAULT_MODEL rather than being sent to the API literally.
export function resolveModel(candidate: string | undefined | null): string {
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : DEFAULT_MODEL;
}

const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description:
      "Submit the per-item supplement evaluation. Must include exactly one entry for every item provided, in the same order.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The item's id exactly as given in the input list, e.g. \"item_1\"." },
              name: { type: "string", description: "Optional, informational only. The id is what identifies the item." },
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
              "id",
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
2. Use human evidence only. If an ingredient is niche or has been studied only in animals/cells, set isMainstreamHumanTested=false and confidence="Insufficient evidence to rate".
3. Name the evidence type in "reason" (e.g. "multiple independent RCTs", "a few small industry-funded trials", "animal studies only") and pick confidence with this fixed rubric. Confidence means how confident we are in the VERDICT, based on the quality and quantity of human evidence behind it — for or against:
   - Strong: multiple independent RCTs or meta-analyses show a consistent, meaningful result for this goal — either a clear benefit (Keep/Take) or a clear lack of benefit (Remove/Don't). Nothing less qualifies.
   - Moderate: human RCTs point the same way but the evidence is limited — trials are small, few, or mostly industry-funded, or effects are modest. Small, few, or industry-funded trials CAP at Moderate no matter how positive their results look.
   - Weak: human evidence exists but is low quality or inconsistent (e.g. observational data only, tiny pilot studies, conflicting results).
   - Insufficient evidence to rate: little or no human research exists on THIS ingredient for THIS goal.
   Keep "Insufficient" and "evidence of no effect" strictly separate. If human studies of this ingredient for this goal exist and show no meaningful benefit, that is NOT Insufficient — it is evidence of no effect: verdict Remove/Don't with Moderate or Strong confidence (per the rubric above). Use Insufficient only when the studies themselves are largely missing.
4. Use blood work only when a marker is directly relevant to an item (e.g. low vitamin D supports a vitamin D verdict). Cite the specific value in "reason" when you use it.
5. Budget rule: the user's budget is an ingredient-level estimate, not product pricing. Estimate a typical monthly ingredient-level cost range for each item. If the total estimated cost of everything with a Keep/Take-leaning verdict would exceed the user's stated budget, the items with the weakest evidence (Weak or Insufficient evidence to rate) are the first to be flagged Remove/Don't. When budget was the deciding factor for an item's verdict, set budgetFlag=true on that item and say so in "reason"; otherwise set budgetFlag=false.
6. Never mention brand names, product names, or diet/dietary advice — not the user's diet, not "if you eat enough X", nothing. This applies to "reason" AND "mechanism" AND "evidenceType" equally; a mention in any of those three fields is a failure.
7. Keep "mechanism" to 1-3 plain-language sentences.
8. status determines which verdicts are valid: "current" items must use Keep or Remove; "candidate" items must use Take or Don't. Never mix these up.
9. goalsAddressed must only contain goals from the user's exact goal list (or be empty).
10. Return exactly one entry per input item, in the same order, with its "id" copied exactly (e.g. "item_1"). Do not add or omit items. The id identifies the item; you may use a more precise name in your text.
11. "reason" must start with a capital letter and name the goal it's judged against using the goal's exact wording, e.g. "For your goal to build muscle, ...". Never leave the reader to infer which goal a reason is about.

Call the ${TOOL_NAME} tool with your evaluation. Do not respond with plain text.`;
}

function buildUserMessage(intake: Intake, items: CompiledItem[]): string {
  const itemLines = items.map((item) => `- [${item.id}] ${item.name} (${item.status})`).join("\n");
  return `Items to evaluate:
${itemLines}

User's goals:
${intake.goals.map((g) => `- ${g}`).join("\n")}

Budget: ${formatBudget(intake)}

Blood work:
${formatBloodWork(intake)}`;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export class ClaudeCallError extends Error {}
// Upstream hiccups worth retrying (overloaded/rate-limited API, or a response
// that simply omitted the forced tool call). Subclass so callers that only
// know ClaudeCallError still map an exhausted retry to "upstream_error".
export class TransientModelError extends ClaudeCallError {}
export class ClaudeValidationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

async function callNvidia(apiKey: string, model: string, messages: OpenAIMessage[]): Promise<any> {
  const response = await fetch(NVIDIA_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const ErrorClass = RETRYABLE_STATUSES.has(response.status) ? TransientModelError : ClaudeCallError;
    throw new ErrorClass(`NVIDIA API error ${response.status}: ${body}`);
  }

  return response.json();
}

function extractToolCall(apiResponse: any): { id: string; rawArguments: string; input: unknown } {
  const toolCalls = apiResponse?.choices?.[0]?.message?.tool_calls ?? [];
  const call = toolCalls.find((tc: any) => tc.type === "function" && tc.function?.name === TOOL_NAME);
  if (!call) {
    throw new TransientModelError("Model response did not include the expected tool call");
  }
  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments);
  } catch (error) {
    throw new ClaudeCallError(`Model tool call arguments were not valid JSON: ${(error as Error).message}`);
  }
  return { id: call.id, rawArguments: call.function.arguments, input };
}

// One logical model turn: call + extract the tool call, retrying transient
// failures with exponential backoff (1s, 2s). Independent of the one
// validation retry in evaluateWithClaude, which only fires on bad content.
async function requestToolCall(apiKey: string, model: string, messages: OpenAIMessage[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return extractToolCall(await callNvidia(apiKey, model, messages));
    } catch (error) {
      if (!(error instanceof TransientModelError) || attempt >= MAX_TRANSIENT_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_BACKOFF_BASE_MS * 2 ** attempt));
    }
  }
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
  const contentGuard = checkContentGuard(parsed.data);
  if (!contentGuard.ok) {
    return { ok: false, message: contentGuard.message! };
  }
  return { ok: true, data: parsed.data };
}

// Steps 3-6: one model call, forced tool/function calling, validated (schema
// + structure) and retried once on failure per PLAN.md §5/§9 (fixture 7).
export async function evaluateWithClaude(
  apiKey: string,
  model: string,
  intake: Intake,
  items: CompiledItem[],
): Promise<ClaudeToolOutput> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserMessage(intake, items) },
  ];

  const firstCall = await requestToolCall(apiKey, model, messages);
  const firstResult = validate(items, intake.goals, firstCall.input);
  if (firstResult.ok) return firstResult.data;

  // Retry once with the validation error appended, per spec.
  const retryMessages: OpenAIMessage[] = [
    ...messages,
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: firstCall.id, type: "function", function: { name: TOOL_NAME, arguments: firstCall.rawArguments } }],
    },
    {
      role: "tool",
      tool_call_id: firstCall.id,
      content: `Your submission failed validation: ${firstResult.message}. Call ${TOOL_NAME} again with corrected input that satisfies the schema exactly.`,
    },
  ];

  const secondCall = await requestToolCall(apiKey, model, retryMessages);
  const secondResult = validate(items, intake.goals, secondCall.input);
  if (secondResult.ok) return secondResult.data;

  throw new ClaudeValidationError(secondResult.message);
}
