import { assembleReports } from "./assemble";
import { ClaudeCallError, ClaudeValidationError, evaluateWithClaude, resolveModel } from "./claude";
import type { Env } from "./env";
import { compileItems } from "./items";
import { IntakeSchema, findDeniedItems, findOffListGoals, type RejectedEntry } from "./schema";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function quoteList(rejected: RejectedEntry[]): string {
  return rejected.map((r) => `"${r.value}" (${r.field})`).join(", ");
}

async function handleEvaluate(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Step 1: validate intake. .strict() schemas reject unknown keys (e.g. "diet");
  // goals must be exact entries from the curated goal list; items can't be
  // denylisted drugs. Nothing rejected here ever reaches the model.
  const parsed = IntakeSchema.safeParse(body);
  if (!parsed.success) {
    const deniedItems = findDeniedItems(parsed.error);
    if (deniedItems.length > 0) {
      const prescriptionNote = deniedItems.some((r) => r.kind === "prescription")
        ? " Don't start, stop, or change a prescription medication without your prescriber."
        : "";
      return json(
        {
          error: "denied_substance",
          message: `Only supplements can be evaluated, not controlled substances or prescription medications. Remove: ${quoteList(deniedItems)}.${prescriptionNote}`,
          rejected: deniedItems,
        },
        400,
      );
    }
    const offListGoals = findOffListGoals(parsed.error);
    if (offListGoals.length > 0) {
      return json(
        {
          error: "not_on_allowlist",
          message: `Only goals from the supported list are accepted. Not on the list: ${quoteList(offListGoals)}.`,
          rejected: offListGoals,
        },
        400,
      );
    }
    return json({ error: "invalid_request", details: parsed.error.issues }, 400);
  }
  const intake = parsed.data;

  // Step 2: compile + flag items.
  const items = compileItems(intake.stack, intake.candidates);
  if (items.length === 0) {
    return json({ error: "invalid_request", details: "stack and candidates cannot both be empty" }, 400);
  }

  // Steps 3-7: one model call (forced tool/function calling) + code-side enforcement.
  if (!env.NVIDIA_API_KEY) {
    return json({ error: "server_misconfigured" }, 502);
  }

  try {
    const claudeOutput = await evaluateWithClaude(env.NVIDIA_API_KEY, resolveModel(env.MODEL), intake, items);
    const evaluation = assembleReports(items, claudeOutput, intake.bloodWork);
    return json(evaluation, 200);
  } catch (error) {
    if (error instanceof ClaudeValidationError) {
      console.error("Model output failed validation after retry:", error.message);
      return json({ error: "model_output_invalid" }, 502);
    }
    if (error instanceof ClaudeCallError) {
      console.error("Model API call failed:", error.message);
      return json({ error: "upstream_error" }, 502);
    }
    console.error("Unexpected error evaluating stack:", error);
    return json({ error: "internal_error" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/evaluate") {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }
      return handleEvaluate(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
