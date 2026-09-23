import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeValidationError, evaluateWithClaude } from "../src/claude";
import type { CompiledItem, Intake } from "../src/schema";

const intake: Intake = {
  stack: [],
  goals: ["build muscle"],
  budget: { amount: 40, period: "month", currency: "USD" },
  candidates: ["creatine monohydrate"],
  bloodWork: [],
};

const items: CompiledItem[] = [{ name: "creatine monohydrate", status: "candidate" }];

function anthropicResponse(toolInput: unknown, toolUseId = "toolu_1") {
  return {
    content: [{ type: "tool_use", id: toolUseId, name: "submit_evaluation", input: toolInput }],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const validItem = {
  name: "creatine monohydrate",
  status: "candidate",
  isMainstreamHumanTested: true,
  evidenceType: "multiple human RCTs and meta-analyses",
  goalsAddressed: ["build muscle"],
  verdict: "Take",
  confidence: "Strong",
  budgetFlag: false,
  reason: "Well supported for build muscle by many human RCTs.",
  mechanism: "Raises phosphocreatine stores, supporting ATP regeneration during resistance training.",
};

describe("evaluateWithClaude", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed output on a valid first response", async () => {
    (fetch as any).mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [validItem] })));

    const result = await evaluateWithClaude("fake-key", intake, items);
    expect(result.items[0]!.name).toBe("creatine monohydrate");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first response fails schema validation, then succeeds", async () => {
    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [{ ...validItem, verdict: "MAYBE" }] })))
      .mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [validItem] })));

    const result = await evaluateWithClaude("fake-key", intake, items);
    expect(result.items[0]!.verdict).toBe("Take");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries once when a current item comes back with a candidate verdict (fixture 7), then fails for good", async () => {
    const currentItems: CompiledItem[] = [{ name: "magnesium", status: "current" }];
    const currentIntake: Intake = { ...intake, candidates: [] };
    const badOutput = {
      ...validItem,
      name: "magnesium",
      status: "current",
      verdict: "Take", // invalid for a "current" item
    };

    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [badOutput] })))
      .mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [badOutput] })));

    await expect(evaluateWithClaude("fake-key", currentIntake, currentItems)).rejects.toBeInstanceOf(
      ClaudeValidationError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws ClaudeValidationError if both attempts fail schema validation", async () => {
    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [{ ...validItem, verdict: "MAYBE" }] })))
      .mockResolvedValueOnce(jsonResponse(anthropicResponse({ items: [{ ...validItem, verdict: "NOPE" }] })));

    await expect(evaluateWithClaude("fake-key", intake, items)).rejects.toBeInstanceOf(ClaudeValidationError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
