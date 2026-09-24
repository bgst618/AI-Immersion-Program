import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeCallError,
  ClaudeValidationError,
  DEFAULT_MODEL,
  TransientModelError,
  evaluateWithClaude,
  resolveModel,
} from "../src/claude";
import type { CompiledItem, Intake } from "../src/schema";

const intake: Intake = {
  stack: [],
  goals: ["build muscle"],
  budget: { amount: 40, period: "month", currency: "USD" },
  candidates: ["creatine monohydrate"],
  bloodWork: [],
};

const items: CompiledItem[] = [{ id: "item_1", name: "creatine monohydrate", status: "candidate" }];

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
  id: "item_1",
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
    expect(result.items[0]!.id).toBe("item_1");
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
    const currentItems: CompiledItem[] = [{ id: "item_1", name: "magnesium", status: "current" }];
    const currentIntake: Intake = { ...intake, candidates: [] };
    const badOutput = {
      ...validItem,
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

  it("accepts a short name the model renames, keyed by id (creatine + build muscle)", async () => {
    const shortItems: CompiledItem[] = [{ id: "item_1", name: "creatine", status: "current" }];
    const renamed = {
      ...validItem,
      name: "Creatine monohydrate",
      status: "current",
      verdict: "Keep",
      reason: "Building muscle: creatine monohydrate is backed by multiple independent RCTs.",
    };
    (fetch as any).mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [renamed] })));

    const result = await evaluateWithClaude("fake-key", DEFAULT_MODEL, { ...intake, stack: ["creatine"], candidates: [] }, shortItems);
    expect(result.items[0]!.id).toBe("item_1");
    expect(fetch).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse((fetch as any).mock.calls[0][1].body).messages[1].content;
    expect(prompt).toContain("- [item_1] creatine (current)");
  });

  it("sends temperature 0", async () => {
    (fetch as any).mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

    await evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.temperature).toBe(0);
  });

  describe("transient errors", () => {
    const noToolCall = () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content: "I cannot help with that." } }] });

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    for (const status of [429, 500, 502, 503]) {
      it(`retries a ${status} and succeeds`, async () => {
        (fetch as any)
          .mockResolvedValueOnce(jsonResponse({ error: "busy" }, status))
          .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

        const pending = evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
        await vi.runAllTimersAsync();
        const result = await pending;
        expect(result.items[0]!.verdict).toBe("Take");
        expect(fetch).toHaveBeenCalledTimes(2);
      });
    }

    it("retries a response with no tool call and succeeds", async () => {
      (fetch as any)
        .mockResolvedValueOnce(noToolCall())
        .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

      const pending = evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
      await vi.runAllTimersAsync();
      expect((await pending).items[0]!.id).toBe("item_1");
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("gives up after 2 retries (3 attempts) with a TransientModelError", async () => {
      (fetch as any)
        .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503))
        .mockResolvedValueOnce(noToolCall())
        .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 429));

      const assertion = expect(evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items)).rejects.toBeInstanceOf(
        TransientModelError,
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry a non-transient error like 400", async () => {
      (fetch as any).mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400));

      const assertion = expect(evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items)).rejects.toSatisfy(
        (error: unknown) => error instanceof ClaudeCallError && !(error instanceof TransientModelError),
      );
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("retries transient errors independently on the validation-retry call", async () => {
      (fetch as any)
        .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [{ ...validItem, verdict: "MAYBE" }] })))
        .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 502))
        .mockResolvedValueOnce(jsonResponse(nvidiaResponse({ items: [validItem] })));

      const pending = evaluateWithClaude("fake-key", DEFAULT_MODEL, intake, items);
      await vi.runAllTimersAsync();
      expect((await pending).items[0]!.verdict).toBe("Take");
      expect(fetch).toHaveBeenCalledTimes(3);
    });
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
