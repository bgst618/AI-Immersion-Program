// Golden eval runner. Hits the REAL NVIDIA API (no mocks) — costs money/quota
// and takes a while. Intentionally kept out of `npm test` / vitest so it
// never runs in CI. Usage: `npm run eval` (needs NVIDIA_API_KEY in the env or
// in .dev.vars).
//
// Env vars:
//   EVAL_CASES=id1,id2   run only the named case ids (comma-separated)
//   EVAL_RUNS=n          override runs_per_case (e.g. 1 for a cheap smoke run)
//   EVAL_CONCURRENCY=n   cap in-flight requests across the whole suite (default 5)
//   MODEL=...            override the NVIDIA model id (default: DEFAULT_MODEL in src/claude.ts)
//
// Request pacing to stay within NVIDIA's free-tier 40 requests/minute limit
// happens here (see waitForRateLimitSlot / NVIDIA_FREE_TIER_REQUESTS_PER_MINUTE
// below), independent of EVAL_CONCURRENCY — see that constant's comment.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleReports } from "../src/assemble";
import { normalizeTerm } from "../src/catalog";
import { evaluateWithClaude, resolveModel } from "../src/claude";
import { compileItems } from "../src/items";
import {
  IntakeSchema,
  type BloodMarkerKey,
  type BloodWorkEntry,
  type Intake,
  type ItemReport,
  type SuggestionReport,
} from "../src/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- API key / model, from process.env or .dev.vars ---------------------

function readDevVar(name: string): string | undefined {
  try {
    const devVars = readFileSync(join(__dirname, "..", ".dev.vars"), "utf-8");
    for (const line of devVars.split("\n")) {
      const match = line.match(new RegExp(`^${name}\\s*=\\s*(.+)$`));
      if (match) return match[1]!.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .dev.vars, fall through
  }
  return undefined;
}

function loadApiKey(): string {
  const key = process.env.NVIDIA_API_KEY ?? readDevVar("NVIDIA_API_KEY");
  if (!key) {
    console.error("NVIDIA_API_KEY not set (checked process.env and .dev.vars). Aborting.");
    process.exit(1);
  }
  return key;
}

function resolveModelFromEnv(): string {
  // resolveModel() (src/claude.ts) treats a blank string as unset too, so a
  // blank workflow_dispatch `model` input (which arrives as MODEL="") falls
  // through to .dev.vars and then DEFAULT_MODEL instead of being sent as-is.
  return resolveModel(process.env.MODEL || readDevVar("MODEL"));
}

// --- eval-cases.json types ----------------------------------------------

interface RawItemExpectation {
  status?: "current" | "candidate";
  acceptable_verdicts?: string[];
  acceptable_confidence?: string[];
  reason_must_mention?: string[];
  reason_must_not_mention?: string[];
  budget_flag?: boolean;
}

// Suggestions are scored per run. `allowed` is the relevance check: every
// suggestion must be one of these (catalog standard names).
interface RawSuggestionExpectation {
  min_count?: number;
  max_count?: number;
  acceptable_confidence?: string[];
  allowed?: string[];
  must_not_include?: string[];
}

interface RawCase {
  id: string;
  category: string;
  pair_id?: string;
  ambiguous?: boolean;
  input: {
    stack: string[];
    goals: string[];
    candidates: string[];
    budget_usd_month: number;
    bloodwork: Record<string, string> | null;
  };
  expect: Record<string, RawItemExpectation | string>; // "_structural" maps to a string
  expect_suggestions?: RawSuggestionExpectation;
  evidence_note?: string;
}

interface EvalFile {
  scoring: {
    runs_per_case: number;
    global_reason_must_not_mention: string[];
    confidence_values: string[];
  };
  cases: RawCase[];
}

const evalFile: EvalFile = JSON.parse(readFileSync(join(__dirname, "eval-cases.json"), "utf-8"));

// --- Bloodwork mapping: eval-cases.json generic markers -> schema.ts dropdown ----
//
// schema.ts BLOOD_MARKERS keys are: vitamin_d, vitamin_b12, ferritin, omega3_index.
// eval-cases.json uses "vitamin_d_25oh" (not "vitamin_d") and qualitative
// "low"/"normal" strings instead of a numeric value. Mapped below; anything
// unmapped is skipped with a warning so a future case can't silently no-op.

const BLOODWORK_KEY_MAP: Record<string, BloodMarkerKey> = {
  vitamin_d_25oh: "vitamin_d",
  ferritin: "ferritin",
  omega3_index: "omega3_index",
};

const QUALITATIVE_VALUE_MAP: Record<BloodMarkerKey, Record<string, number>> = {
  vitamin_d: { low: 15, normal: 40 }, // ng/mL; deficient <20, sufficient ~30-100
  ferritin: { low: 15, normal: 80 }, // ng/mL; representative low vs. mid-normal
  vitamin_b12: { low: 150, normal: 500 }, // pg/mL; unused by current cases
  omega3_index: { low: 3, normal: 6, high: 13 }, // %; target >= 8 (src/bloodwork.ts)
};

const unmappedMarkersSeen = new Set<string>();

function mapBloodwork(bloodwork: Record<string, string> | null): BloodWorkEntry[] {
  if (!bloodwork) return [];
  const entries: BloodWorkEntry[] = [];
  for (const [rawKey, qualitative] of Object.entries(bloodwork)) {
    const markerKey = BLOODWORK_KEY_MAP[rawKey];
    if (!markerKey) {
      unmappedMarkersSeen.add(rawKey);
      continue;
    }
    const value = QUALITATIVE_VALUE_MAP[markerKey]?.[qualitative];
    if (value === undefined) {
      console.warn(`eval-cases.json: unrecognized bloodwork value "${qualitative}" for marker "${rawKey}"; skipping.`);
      continue;
    }
    entries.push({ marker: markerKey, value });
  }
  return entries;
}

function mapInput(raw: RawCase["input"]): Intake {
  return IntakeSchema.parse({
    stack: raw.stack ?? [],
    goals: raw.goals ?? [],
    candidates: raw.candidates ?? [],
    budget: { amount: raw.budget_usd_month, period: "month", currency: "USD" },
    bloodWork: mapBloodwork(raw.bloodwork ?? null),
  });
}

// --- Concurrency-limited task runner -------------------------------------

const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY) || 5;

// NVIDIA's build.nvidia.com free tier caps usage at 40 requests/minute per
// API key. Each task normally issues one HTTP call to NVIDIA (up to two if
// claude.ts's own one-time validation retry fires), so pacing task starts to
// this rate keeps the whole suite comfortably within the free-tier limit
// regardless of EVAL_CONCURRENCY. Deliberately not in src/claude.ts: that
// module is shared with the production Worker (a single request per user
// action, never worth throttling) and with the mocked unit tests, which
// would otherwise pick up real wall-clock delay for no reason.
const NVIDIA_FREE_TIER_REQUESTS_PER_MINUTE = 40;
const MIN_TASK_INTERVAL_MS = Math.ceil(60_000 / NVIDIA_FREE_TIER_REQUESTS_PER_MINUTE);

let rateLimitGate: Promise<void> = Promise.resolve();
let lastTaskStartedAt = 0;

function waitForRateLimitSlot(): Promise<void> {
  const slot = rateLimitGate.then(async () => {
    const wait = Math.max(0, lastTaskStartedAt + MIN_TASK_INTERVAL_MS - Date.now());
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastTaskStartedAt = Date.now();
  });
  rateLimitGate = slot;
  return slot;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- Running cases ---------------------------------------------------------

type RunResult = { ok: true; items: ItemReport[]; suggestions: SuggestionReport[] } | { ok: false; error: string };

interface CaseRunData {
  case: RawCase;
  runs: RunResult[];
}

interface Task {
  caseIndex: number;
  intake: Intake;
  items: ReturnType<typeof compileItems>;
}

async function runOne(task: Task, apiKey: string, model: string): Promise<RunResult> {
  try {
    // Transient-error retries (429/5xx, missing tool call) happen inside
    // evaluateWithClaude, shared with the Worker, so none are layered here.
    await waitForRateLimitSlot();
    const output = await evaluateWithClaude(apiKey, model, task.intake, task.items);
    const evaluation = assembleReports(task.items, output, task.intake.bloodWork);
    return { ok: true, items: evaluation.items, suggestions: evaluation.suggestions };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Runs every (case, repetition) as one flat pool so CONCURRENCY caps total
// in-flight requests across the whole suite, not per case.
async function runAllCases(cases: RawCase[], apiKey: string, model: string, runsPerCase: number): Promise<CaseRunData[]> {
  const tasks: Task[] = cases.map((c, caseIndex) => {
    const intake = mapInput(c.input);
    return { caseIndex, intake, items: compileItems(intake.stack, intake.candidates) };
  });

  const flatRuns: { caseIndex: number; runIndex: number }[] = [];
  for (const task of tasks) {
    for (let runIndex = 0; runIndex < runsPerCase; runIndex++) {
      flatRuns.push({ caseIndex: task.caseIndex, runIndex });
    }
  }

  const flatResults = await mapWithConcurrency(flatRuns, CONCURRENCY, async ({ caseIndex }) => runOne(tasks[caseIndex]!, apiKey, model));

  const runsByCase: RunResult[][] = cases.map(() => []);
  flatRuns.forEach((r, i) => runsByCase[r.caseIndex]!.push(flatResults[i]!));

  return cases.map((rawCase, caseIndex) => ({ case: rawCase, runs: runsByCase[caseIndex]! }));
}

// --- Scoring -----------------------------------------------------------

function normalizeConfidence(c: string): string {
  return c === "Insufficient evidence to rate" ? "Insufficient" : c;
}

interface ItemScoreRow {
  caseId: string;
  category: string;
  ambiguous: boolean;
  itemName: string;
  verdicts: (string | null)[];
  confidences: (string | null)[];
  pass: boolean;
  failReasons: string[];
}

function findItemReport(items: ItemReport[], name: string): ItemReport | undefined {
  return items.find((i) => i.name.toLowerCase() === name.toLowerCase());
}

function scoreItem(
  caseData: CaseRunData,
  itemName: string,
  expectation: RawItemExpectation,
  globalBanned: string[],
  runsPerCase: number,
): ItemScoreRow {
  const failReasons: string[] = [];
  const verdicts: (string | null)[] = [];
  const confidences: (string | null)[] = [];
  const banned = [...globalBanned, ...(expectation.reason_must_not_mention ?? [])];

  for (const run of caseData.runs) {
    if (!run.ok) {
      verdicts.push(null);
      confidences.push(null);
      failReasons.push(`run_error: ${run.error}`);
      continue;
    }
    const report = findItemReport(run.items, itemName);
    if (!report) {
      verdicts.push(null);
      confidences.push(null);
      failReasons.push(`missing_item`);
      continue;
    }
    verdicts.push(report.verdict);
    confidences.push(normalizeConfidence(report.confidence));

    if (expectation.status && report.status !== expectation.status) {
      failReasons.push(`status_mismatch:${report.status}`);
    }
    if (expectation.acceptable_verdicts && !expectation.acceptable_verdicts.includes(report.verdict)) {
      failReasons.push(`verdict:${report.verdict}`);
    }
    const normConf = normalizeConfidence(report.confidence);
    if (expectation.acceptable_confidence && !expectation.acceptable_confidence.includes(normConf)) {
      failReasons.push(`confidence:${normConf}`);
    }
    if (expectation.reason_must_mention) {
      const lower = report.reason.toLowerCase();
      const hit = expectation.reason_must_mention.some((term) => lower.includes(term.toLowerCase()));
      if (!hit) failReasons.push(`reason_missing_mention`);
    }
    if (expectation.budget_flag !== undefined) {
      // assemble.ts's applyOverrides forces confidence to "Insufficient evidence to
      // rate" and clears budgetFlag to false whenever the niche-candidate or
      // insufficient-evidence override fires — that's the generic, structural
      // signal an override fired, regardless of what the case declares.
      const overrideFired = normConf === "Insufficient";
      const expectedBudgetFlag = overrideFired ? false : expectation.budget_flag;
      if (report.budgetFlag !== expectedBudgetFlag) {
        const overrideNote = overrideFired ? " (override fired, budget_flag expectation overridden to false)" : "";
        failReasons.push(`budget_flag_mismatch:expected=${expectedBudgetFlag}${overrideNote},actual=${report.budgetFlag}`);
      }
    }
    for (const phrase of banned) {
      if (report.reason.toLowerCase().includes(phrase.toLowerCase())) {
        failReasons.push(`banned_phrase:"${phrase}"`);
      }
    }
  }

  // Consistency: verdict identical across all runs; confidence identical in >= 4 of 5.
  const nonNullVerdicts = verdicts.filter((v): v is string => v !== null);
  const verdictConsistent = nonNullVerdicts.length === verdicts.length && new Set(nonNullVerdicts).size <= 1;
  if (!verdictConsistent) failReasons.push("consistency:verdict_varies");

  const nonNullConfidences = confidences.filter((c): c is string => c !== null);
  if (nonNullConfidences.length > 0) {
    const counts = new Map<string, number>();
    for (const c of nonNullConfidences) counts.set(c, (counts.get(c) ?? 0) + 1);
    const maxAgreement = Math.max(...counts.values());
    // Default runs_per_case=5 requires 4/5 (80%) agreement; scale the same
    // ratio when EVAL_RUNS overrides the run count.
    const requiredAgreement = Math.max(1, Math.ceil(runsPerCase * 0.8));
    if (maxAgreement < requiredAgreement) failReasons.push("consistency:confidence_varies");
  }

  return {
    caseId: caseData.case.id,
    category: caseData.case.category + (caseData.case.ambiguous ? " (ambiguous)" : ""),
    ambiguous: !!caseData.case.ambiguous,
    itemName,
    verdicts,
    confidences,
    pass: failReasons.length === 0,
    failReasons,
  };
}

const SUGGESTIONS_ROW = "(suggestions)";

function scoreSuggestions(caseData: CaseRunData, expectation: RawSuggestionExpectation, globalBanned: string[]): ItemScoreRow {
  const failReasons: string[] = [];
  const names: (string | null)[] = [];
  const confidences: (string | null)[] = [];
  const allowed = expectation.allowed && new Set(expectation.allowed.map(normalizeTerm));
  const forbidden = new Set((expectation.must_not_include ?? []).map(normalizeTerm));
  const goals = new Set(caseData.case.input.goals);

  for (const run of caseData.runs) {
    if (!run.ok) {
      names.push(null);
      confidences.push(null);
      failReasons.push(`run_error: ${run.error}`);
      continue;
    }
    const suggestions = run.suggestions;
    names.push(suggestions.map((s) => s.name).join("+") || "none");
    confidences.push(suggestions.map((s) => s.confidence).join("+") || "-");

    if (expectation.min_count !== undefined && suggestions.length < expectation.min_count) {
      failReasons.push(`too_few:${suggestions.length}<${expectation.min_count}`);
    }
    if (expectation.max_count !== undefined && suggestions.length > expectation.max_count) {
      failReasons.push(`too_many:${suggestions.length}>${expectation.max_count}`);
    }
    for (const s of suggestions) {
      const key = normalizeTerm(s.name);
      if (expectation.acceptable_confidence && !expectation.acceptable_confidence.includes(s.confidence)) {
        failReasons.push(`confidence:${s.name}=${s.confidence}`);
      }
      if (allowed && !allowed.has(key)) failReasons.push(`irrelevant:${s.name}`);
      if (forbidden.has(key)) failReasons.push(`already_taken:${s.name}`);
      if (s.goalsAddressed.length === 0 || s.goalsAddressed.some((g) => !goals.has(g))) {
        failReasons.push(`goals:${s.name}`);
      }
      for (const phrase of globalBanned) {
        if (s.reason.toLowerCase().includes(phrase.toLowerCase())) failReasons.push(`banned_phrase:${s.name}:"${phrase}"`);
      }
    }
  }

  return {
    caseId: caseData.case.id,
    category: caseData.case.category,
    ambiguous: false,
    itemName: SUGGESTIONS_ROW,
    verdicts: names,
    confidences,
    pass: failReasons.length === 0,
    failReasons: [...new Set(failReasons)],
  };
}

function dominantVerdict(verdicts: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of verdicts) {
    if (v === null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function summarizeList(values: (string | null)[]): string {
  return values.map((v) => v ?? "ERR").join(",");
}

// --- Subset selection: EVAL_CASES=id1,id2 and EVAL_RUNS=n for cheap runs ----

function resolveRunsPerCase(): number {
  const raw = process.env.EVAL_RUNS;
  if (!raw) return evalFile.scoring.runs_per_case;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`EVAL_RUNS must be a positive integer, got "${raw}". Aborting.`);
    process.exit(1);
  }
  return n;
}

function resolveCases(): RawCase[] {
  const raw = process.env.EVAL_CASES;
  if (!raw) return evalFile.cases;
  const ids = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const selected = evalFile.cases.filter((c) => ids.has(c.id));
  const missing = [...ids].filter((id) => !selected.some((c) => c.id === id));
  if (missing.length > 0) {
    console.warn(`EVAL_CASES referenced unknown case id(s): ${missing.join(", ")}`);
  }
  if (selected.length === 0) {
    console.error("EVAL_CASES matched no known case ids. Aborting.");
    process.exit(1);
  }
  return selected;
}

// --- Preflight: every case must be a request production would accept ----
//
// The runner calls evaluateWithClaude directly, bypassing index.ts's step-1
// checks, so a fixture the Worker would reject (e.g. a goal like "improve bone
// health" that isn't on the goal list) used to be scored anyway and pass
// quietly on an input no real user can send. Fail loudly instead, before
// spending any quota. IntakeSchema carries every step-1 rule.

function preflightCases(cases: RawCase[]): string[] {
  const problems: string[] = [];
  for (const c of cases) {
    try {
      const intake = mapInput(c.input);
      if (compileItems(intake.stack, intake.candidates).length === 0) problems.push(`${c.id}: no items to evaluate`);
    } catch (error) {
      problems.push(`${c.id}: input fails IntakeSchema (400 in production): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

// --- Main ----------------------------------------------------------------

async function main() {
  const problems = preflightCases(evalFile.cases);
  if (problems.length > 0) {
    console.error(`eval-cases.json has ${problems.length} case(s) production would reject. Fix them before running:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }

  const apiKey = loadApiKey();
  const model = resolveModelFromEnv();
  const runsPerCase = resolveRunsPerCase();
  const cases = resolveCases();

  // Touch mapBloodwork eagerly for every case so we surface unmapped markers
  // before running anything expensive.
  for (const c of cases) mapBloodwork(c.input.bloodwork ?? null);
  if (unmappedMarkersSeen.size > 0) {
    console.warn(
      `\nWARNING: eval-cases.json uses bloodwork marker key(s) not in schema.ts BLOOD_MARKERS / BLOODWORK_KEY_MAP: ${[...unmappedMarkersSeen].join(", ")}. Those entries were dropped from the intake sent to the model.\n`,
    );
  }

  console.log(
    `Running ${cases.length} cases x ${runsPerCase} runs against NVIDIA (${model}, concurrency=${CONCURRENCY})...\n`,
  );

  const allCaseData = await runAllCases(cases, apiKey, model, runsPerCase);

  const itemRows: ItemScoreRow[] = [];
  const structuralNotes: { caseId: string; note: string; actual: string }[] = [];

  for (const caseData of allCaseData) {
    for (const [key, expectation] of Object.entries(caseData.case.expect)) {
      if (key === "_structural") {
        const firstOk = caseData.runs.find((r): r is Extract<RunResult, { ok: true }> => r.ok);
        const actual = firstOk ? firstOk.items.map((i) => `${i.name} (${i.status})`).join("; ") : "no successful run";
        structuralNotes.push({ caseId: caseData.case.id, note: expectation as string, actual });
        continue;
      }
      itemRows.push(
        scoreItem(caseData, key, expectation as RawItemExpectation, evalFile.scoring.global_reason_must_not_mention, runsPerCase),
      );
    }
    if (caseData.case.expect_suggestions) {
      itemRows.push(scoreSuggestions(caseData, caseData.case.expect_suggestions, evalFile.scoring.global_reason_must_not_mention));
    }
  }

  console.log("=== Per-item results ===");
  console.table(
    itemRows.map((r) => ({
      case: r.caseId,
      item: r.itemName,
      category: r.category,
      verdicts: summarizeList(r.verdicts),
      confidences: summarizeList(r.confidences),
      pass: r.pass ? "PASS" : "FAIL",
      failReasons: r.failReasons.join(" | "),
    })),
  );

  console.log("\n=== Case-level summary ===");
  const caseIds = [...new Set(itemRows.map((r) => r.caseId))];
  const caseLevel = caseIds.map((id) => {
    const rows = itemRows.filter((r) => r.caseId === id);
    const pass = rows.every((r) => r.pass);
    return { case: id, items: rows.length, result: pass ? "PASS" : "FAIL" };
  });
  for (const structural of structuralNotes) {
    if (!caseLevel.some((c) => c.case === structural.caseId)) {
      caseLevel.push({ case: structural.caseId, items: 0, result: "INFO (structural only)" });
    }
  }
  console.table(caseLevel);

  if (structuralNotes.length > 0) {
    console.log("\n=== Structural notes (informational, not scored) ===");
    for (const s of structuralNotes) {
      console.log(`- ${s.caseId}: ${s.note}\n  actual: ${s.actual}`);
    }
  }

  console.log("\n=== Pair checks (cases sharing pair_id must differ) ===");
  const pairGroups = new Map<string, RawCase[]>();
  for (const { case: c } of allCaseData) {
    if (!c.pair_id) continue;
    pairGroups.set(c.pair_id, [...(pairGroups.get(c.pair_id) ?? []), c]);
  }
  const pairResults: { pairId: string; cases: string; dominantVerdicts: string; result: string }[] = [];
  for (const [pairId, pairCases] of pairGroups) {
    if (pairCases.length < 2) {
      // EVAL_CASES filtered out the other half of this pair — nothing to compare.
      pairResults.push({
        pairId,
        cases: pairCases.map((c) => c.id).join(" vs "),
        dominantVerdicts: "n/a",
        result: "SKIPPED (incomplete pair)",
      });
      continue;
    }
    const dominants = pairCases.map((c) => {
      const itemKey = Object.keys(c.expect).find((k) => k !== "_structural");
      const verdicts = itemKey ? itemRows.find((r) => r.caseId === c.id && r.itemName === itemKey)?.verdicts ?? [] : [];
      return dominantVerdict(verdicts);
    });
    const distinct = new Set(dominants.filter((d) => d !== null));
    const pass = distinct.size > 1;
    pairResults.push({
      pairId,
      cases: pairCases.map((c) => c.id).join(" vs "),
      dominantVerdicts: dominants.map((d) => d ?? "ERR").join(" vs "),
      result: pass ? "PASS" : "FAIL",
    });
  }
  console.table(pairResults);

  console.log("\n=== Consistency-specific failures ===");
  const consistencyFailures = itemRows.filter((r) => r.failReasons.some((f) => f.startsWith("consistency:")));
  if (consistencyFailures.length === 0) {
    console.log("None.");
  } else {
    console.table(
      consistencyFailures.map((r) => ({
        case: r.caseId,
        item: r.itemName,
        verdicts: summarizeList(r.verdicts),
        confidences: summarizeList(r.confidences),
        issue: r.failReasons.filter((f) => f.startsWith("consistency:")).join(", "),
      })),
    );
  }

  const totalCases = caseLevel.length;
  const passedCases = caseLevel.filter((c) => c.result === "PASS").length;
  const failedCases = caseLevel.filter((c) => c.result === "FAIL").length;
  const infoCases = caseLevel.filter((c) => c.result.startsWith("INFO")).length;
  const pairsFailed = pairResults.filter((p) => p.result === "FAIL").length;
  const pairsSkipped = pairResults.filter((p) => p.result.startsWith("SKIPPED")).length;
  const pairsPassed = pairResults.length - pairsFailed - pairsSkipped;
  const runErrors = allCaseData.flatMap((c) => c.runs.filter((r) => !r.ok)).length;

  console.log("\n=== Summary ===");
  console.log(`Cases: ${totalCases} (${passedCases} pass, ${failedCases} fail, ${infoCases} informational)`);
  console.log(`Pairs: ${pairResults.length} (${pairsPassed} pass, ${pairsFailed} fail, ${pairsSkipped} skipped/incomplete)`);
  console.log(`Consistency-specific failures: ${consistencyFailures.length}`);
  console.log(`Run-level API/validation errors: ${runErrors}`);

  process.exitCode = failedCases > 0 || pairsFailed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
