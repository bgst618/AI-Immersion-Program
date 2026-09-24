import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateWithClaude } from "../src/claude";
import worker from "../src/index";
import type { ClaudeToolOutput } from "../src/schema";

// Replace only the model call. Everything before it in the handler (intake
// validation, compileItems) runs for real, so "not called" means the request
// was stopped before it could reach claude.ts. Separate from index.test.ts,
// which drives the real claude.ts against a mocked fetch.
vi.mock("../src/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/claude")>()),
  evaluateWithClaude: vi.fn(),
}));

const env = { NVIDIA_API_KEY: "test-key", MODEL: "", ASSETS: { fetch: async () => new Response("") } } as any;

const budget = { amount: 40, period: "month", currency: "USD" };
const validBody = { stack: ["fish oil"], goals: ["build muscle"], budget, candidates: ["creatine monohydrate"] };

function evaluate(body: unknown): Promise<Response> {
  return worker.fetch(
    new Request("https://example.test/api/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

// A model output covering however many items the request compiles to.
function outputFor(count: number): ClaudeToolOutput {
  return {
    suggestions: [],
    items: Array.from({ length: count }, (_, i) => ({
      id: `item_${i + 1}`,
      status: i === 0 ? "current" : "candidate",
      isMainstreamHumanTested: true,
      evidenceType: "multiple human RCTs",
      goalsAddressed: [],
      verdict: i === 0 ? "Remove" : "Don't",
      confidence: "Moderate",
      budgetFlag: false,
      reason: "For your goal to build muscle, RCTs show no meaningful effect.",
      mechanism: "Not relevant to muscle protein synthesis.",
    })),
  };
}

async function expectRejectedBeforeModel(body: unknown, error: string, rejected: unknown[]) {
  const response = await evaluate(body);
  expect(response.status).toBe(400);
  const json = (await response.json()) as { error: string; message: string; rejected: { value: string }[] };
  expect(json.error).toBe(error);
  expect(json.rejected).toEqual(rejected);
  for (const { value } of json.rejected) expect(json.message).toContain(`"${value}"`);
  expect(evaluateWithClaude).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(evaluateWithClaude).mockReset();
  // Belt and braces: a real model call would have to go through fetch.
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/evaluate reaches the model for valid intake (control)", () => {
  it("passes an all-valid request through to the model", async () => {
    vi.mocked(evaluateWithClaude).mockResolvedValueOnce(outputFor(2));
    const response = await evaluate(validBody);
    expect(response.status).toBe(200);
    expect(evaluateWithClaude).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/evaluate goal allowlist", () => {
  for (const goal of ["be smarter", "be healthier", "sleep better"]) {
    it(`rejects off-list goal "${goal}" with 400 before calling the model`, async () => {
      await expectRejectedBeforeModel({ ...validBody, goals: [goal] }, "not_on_allowlist", [{ field: "goals", value: goal }]);
    });
  }

  it("rejects an off-list goal alongside a valid one", async () => {
    await expectRejectedBeforeModel({ ...validBody, goals: ["build muscle", "be smarter"] }, "not_on_allowlist", [
      { field: "goals", value: "be smarter" },
    ]);
  });

  it("keeps other validation failures as invalid_request, still before the model", async () => {
    const response = await evaluate({ ...validBody, diet: "keto" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
    expect(evaluateWithClaude).not.toHaveBeenCalled();
  });
});
