import { ZodError } from "zod";
import { assembleReports } from "./assemble";
import { ClaudeCallError, ClaudeValidationError, evaluateWithClaude } from "./claude";
import type { Env } from "./env";
import { findFirstVagueGoal } from "./goals";
import { compileItems } from "./items";
import { IntakeSchema } from "./schema";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handleEvaluate(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Step 1: validate intake. .strict() schemas reject unknown keys (e.g. "diet").
  const parsed = IntakeSchema.safeParse(body);
  if (!parsed.success) {
    const err = parsed.error as ZodError;
    return json({ error: "invalid_request", details: err.issues }, 400);
  }
  const intake = parsed.data;

  // Step 1: reject vague, untestable goals.
  const vague = findFirstVagueGoal(intake.goals);
  if (vague) {
    return json({ error: "vague_goal", goal: vague.goal, suggestion: vague.suggestion }, 400);
  }

  // Step 2: compile + flag items.
  const items = compileItems(intake.stack, intake.candidates);
  if (items.length === 0) {
    return json({ error: "invalid_request", details: "stack and candidates cannot both be empty" }, 400);
  }

  // Steps 3-7: one Claude call (forced tool use) + code-side enforcement.
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "server_misconfigured" }, 502);
  }

  try {
    const claudeOutput = await evaluateWithClaude(env.ANTHROPIC_API_KEY, intake, items);
    const evaluation = assembleReports(items, claudeOutput);
    return json(evaluation, 200);
  } catch (error) {
    if (error instanceof ClaudeValidationError) {
      console.error("Claude output failed validation after retry:", error.message);
      return json({ error: "model_output_invalid" }, 502);
    }
    if (error instanceof ClaudeCallError) {
      console.error("Claude API call failed:", error.message);
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
