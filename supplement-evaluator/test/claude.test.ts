import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeValidationError, DEFAULT_MODEL, evaluateWithClaude, resolveModel } from "../src/claude";
import type { CompiledItem, Intake } from "../src/schema";

const intake: Intake = {
  stack: [],
  goals: ["build muscle"],
  budget: { amount: 40, period: "month", currency: "USD" },
  candidates: ["creatine monohydrate"],
  bloodWork: [],
};

const items: CompiledItem[] = [{ name: "creatine monohydrate", status: "candidate" }];

// Shape of an NVIDIA (OpenAI-compatible Chat Completions) response with a
// forced function call. `arguments` is a JSON string, not a parsed object.
function nvidiaResponse(toolInput: unknown, toolCallId = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolCallId,
              type: "function",
              function: { name: "submit_evaluation", arguments: JSON.stringify(toolInput) },
            },
          ],
        },
      },
    ],
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
    (fetch as any).mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

    const result = await evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
    expect(result.items[0]!.name).toBe("creatine monohydrate");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once when the first response fails schema validation, then succeeds", async () => {
    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [{ ...validItem, verdict: "MAYBE" }] })))
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

    const result = await evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
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
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [badOutput] })))
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [badOutput] })));

    await expect(
      evaluateWithClaude("fake-key", DEFAULT_MODEL, currentIntake, currentItems),
    ).rejects.toBeInstanceOf(ClaudeValidationError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws ClaudeValidationError if both attempts fail schema validation", async () => {
    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [{ ...validItem, verdict: "MAYBE" }] })))
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [{ ...validItem, verdict: "NOPE" }] })));

    await expect(evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items)).rejects.toBeInstanceOf(
      ClaudeValidationError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws ClaudeCallError if the model response has no tool call", async () => {
    (fetch as any).mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { role: "assistant", content: "I cannot help with that." } }] }),
    );

    await expect(evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items)).rejects.toThrow(
      "did not include the expected tool call",
    );
  });

  it("retries once when a diet mention slips into the mechanism, then succeeds", async () => {
    const dietyOutput = {
      ...validItem,
      mechanism: "May offer modest benefit in individuals with adequate diet.",
    };

    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [dietyOutput] })))
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

    const result = await evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
    expect(result.items[0]!.mechanism).not.toMatch(/diet/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws ClaudeValidationError if a diet mention survives both attempts", async () => {
    const dietyOutput = {
      ...validItem,
      mechanism: "May offer modest benefit in individuals with adequate diet.",
    };

    (fetch as any)
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [dietyOutput] })))
      .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [dietyOutput] })));

    await expect(evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items)).rejects.toBeInstanceOf(
      ClaudeValidationError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("resolveModel", () => {
  it("returns the candidate when it's a non-empty string", () => {
    expect(resolveModel("some/other-model")).toBe("some/other-model");
  });

  it("falls back to DEFAULT_MODEL for an empty string", () => {
    expect(resolveModel("")).toBe(DEFAULT_MODEL);
  });

  it("falls back to DEFAULT_MODEL for a whitespace-only string", () => {
    expect(resolveModel("   ")).toBe(DEFAULT_MODEL);
  });

  it("falls back to DEFAULT_MODEL for undefined", () => {
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
  });
});
