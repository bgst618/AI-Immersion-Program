# Build Plan: Supplement Stack Evaluator (Cloudflare Worker)

> Living spec. §11 lists the current round of changes in the order they are implemented.

## 1. What we're building

A single-page website, served by one Cloudflare Worker, where a user enters their current supplement stack, specific goals, budget, an optional candidate ingredient (e.g., one they saw in an influencer's stack), and optional blood work. The Worker calls an LLM (NVIDIA build.nvidia.com, OpenAI-compatible) to reason over human-research evidence and returns **one report per item**, plus **up to 3 suggested additions**:

| Field | Values |
|---|---|
| `verdict` | Current items: `Keep` / `Remove` (UI label: **"Not needed for your goals"**). Candidates: `Take` / `Don't`. Suggestions: always `Take` |
| `confidence` | `Strong` / `Moderate` / `Weak` / `Insufficient evidence to rate` — how confident we are in the *verdict* |
| `reason` | Starts with a capital letter, names the user's goal explicitly, names the evidence type. If the item is well supported for a goal the user didn't list, says so |
| `mechanism` | 1–3 sentences: what it does in the body and how |

**Success test:** a user can paste an unfamiliar ingredient plus their stack and leave with a specific keep/remove/add decision — not a wellness score.

### Hard rules (from the problem statement — do not relax)

- **No diet input anywhere.** No field, no prompt text, no hidden parameter. Diet mentions in model output fail validation and trigger the retry.
- **No "overall wellness" goals.** Vague goals ("be healthier", "general health") are rejected with a prompt to make them specific and testable.
- **No brand/product comparison or recommendation.** Ingredient level only. No product names, no per-product pricing. "Take" and suggested cards may say "Look for a USP Verified or NSF Certified product" and link a plain web search for the *ingredient name* — never a product.
- **Human evidence only.** Niche, animal-only compounds are not recommended as candidates; if the user already takes one, it is rated `Insufficient evidence to rate`.
- **Verdicts come from reasoning, not a lookup table.** The model does the evidence matching; code enforces structure.
- **"Insufficient evidence" is a valid result**, styled as an honest answer, not an error.

## 2. Architecture

```
Browser (static HTML/CSS/JS, autocomplete from /catalog.json)
   │  POST /api/evaluate  (JSON intake)
   ▼
Cloudflare Worker (TypeScript)
   ├─ Step 1  Validate intake (zod) + reject vague goals
   ├─ Step 2  Compile item list, flag current / candidate, assign ids (item_1, item_2, …)
   ├─ Steps 3–6  One model call, forced tool use → structured JSON (items by id + suggestions)
   │            transient errors (429/500/502/503, missing tool call) retried ×2 with backoff;
   │            validation failures retried once with the error fed back
   ├─ Step 7  Validate + assemble per-item reports (user's original names restored from ids)
   └─ Returns JSON → browser renders one card per item + suggested cards
```

**Stack**

- Cloudflare Workers + Workers Static Assets (serves `/public`)
- TypeScript, Wrangler, no framework
- `zod` for request and response validation
- NVIDIA OpenAI-compatible Chat Completions via `fetch`; model from `MODEL` env var (default `nvidia/nemotron-3-super-120b-a12b`; empty = unset), temperature 0
- Secret: `NVIDIA_API_KEY` (via `wrangler secret put`)

## 3. File layout

```
supplement-evaluator/
├─ wrangler.jsonc
├─ package.json
├─ tsconfig.json
├─ public/
│  ├─ index.html        # intake form + results area
│  ├─ styles.css
│  ├─ app.js            # form handling, autocomplete, fetch, render cards
│  └─ catalog.json      # curated ingredients (+aliases), goals, brand names — shared with the Worker
├─ src/
│  ├─ index.ts          # router: GET / (assets), POST /api/evaluate
│  ├─ schema.ts         # zod: Intake, ItemReport, SuggestionReport, EvaluationResponse
│  ├─ catalog.ts        # typed access to public/catalog.json
│  ├─ goals.ts          # vague-goal detection (step 1)
│  ├─ items.ts          # compile + flag + id items (step 2)
│  ├─ claude.ts         # prompt + tool definition + API call + retries (steps 3–6)
│  └─ assemble.ts       # post-validation + final reports (step 7)
├─ test/                # vitest + @cloudflare/vitest-pool-workers (mocked model)
└─ eval/                # golden eval set + runner against the real model (never in CI)
```

## 4. API contract

### Request — `POST /api/evaluate`

```json
{
  "stack": ["multivitamin", "fish oil"],
  "goals": ["build muscle", "improve sleep quality"],
  "budget": { "amount": 40, "period": "month", "currency": "USD" },
  "candidates": ["creatine"],
  "bloodWork": [{ "marker": "vitamin_d", "value": 18 }]
}
```

Validation:

- `stack`: 0–15 strings, trimmed, deduped (case-insensitive)
- `goals`: 1–5 strings, each must pass the specificity check (§6)
- `budget`: required
- `candidates`: 0–5 strings, optional
- `bloodWork`: optional; fixed dropdown marker (`vitamin_d`, `vitamin_b12`, `ferritin`, `omega3_index`) + number
- `stack` + `candidates` combined must be ≥ 1 item
- Reject any unknown keys (guarantees no diet field sneaks in)

### Response — `200`

```json
{
  "items": [
    {
      "name": "creatine",
      "status": "candidate",
      "verdict": "Take",
      "confidence": "Strong",
      "goalsAddressed": ["build muscle"],
      "evidenceType": "multiple independent RCTs and meta-analyses",
      "budgetFlag": false,
      "reason": "For your goal to build muscle, …",
      "mechanism": "…"
    }
  ],
  "suggestions": [
    {
      "name": "whey protein",
      "status": "suggested",
      "verdict": "Take",
      "confidence": "Moderate",
      "goalsAddressed": ["build muscle"],
      "evidenceType": "…",
      "reason": "…",
      "mechanism": "…",
      "estimatedMonthlyCost": 30
    }
  ],
  "disclaimer": "Educational information, not medical advice…"
}
```

`items[].name` is always the user's original input, restored from the item id — never the model's rewrite. `suggestions` may be empty; the UI then says none qualified.

Errors: `400` with `{ "error": "vague_goal", "goal": "be healthier", "suggestion": "…" }`; `502` model output failed validation after retry, or the upstream API failed after transient retries.

## 5. Model call (steps 3–6)

One call per evaluation (plus at most one validation retry). **Forced tool use** (`tool_choice` names `submit_evaluation`) so output is always structured JSON; validated with zod anyway.

**Input:** each item is listed with its id, e.g. `- [item_1] creatine (current)`, plus the catalog's ingredient names (the only allowed suggestions).

**Tool input schema:**
- `items[]` (per input item): `id` (required, echoed exactly), `name` (optional, informational only), `status`, `isMainstreamHumanTested`, `evidenceType`, `goalsAddressed`, `verdict`, `confidence`, `budgetFlag`, `reason`, `mechanism`.
- `suggestions[]` (0–3): `name` (a catalog ingredient name), `goalsAddressed` (non-empty), `confidence` (`Strong`|`Moderate`), `evidenceType`, `estimatedMonthlyCost` (ingredient-level, user's currency), `reason`, `mechanism`.

**System prompt must instruct the model to:**

1. Treat each item independently; evaluate against the user's listed goals; echo each item's `id` exactly.
2. Use human research only; niche or animal-only → `isMainstreamHumanTested=false`, `Insufficient evidence to rate`.
3. Pick confidence from this rubric (confidence in the *verdict*, for or against):
   - **Strong** — multiple independent RCTs / meta-analyses with a consistent, meaningful result (benefit *or* no benefit)
   - **Moderate** — RCTs point one way but are small, few, or industry-funded (these cap at Moderate)
   - **Weak** — low-quality or inconsistent human evidence
   - **Insufficient** — little or no human research on this ingredient for this goal. Studies that exist and show no benefit are *evidence of no effect* → Remove/Don't at Moderate/Strong, not Insufficient.
4. Use blood work only when a marker is directly relevant; cite the value.
5. Budget: estimate ingredient-level monthly cost; over budget → weakest-evidence items flagged first, `budgetFlag=true`.
6. Never mention brands, products, or diet (reason, mechanism, evidenceType). Never invent citations.
7. `mechanism` ≤ 3 plain-language sentences.
8. `reason` starts with a capital letter and names the user's goal using its exact wording. If the item isn't supported for the user's goals but is well supported for a goal they didn't list, say so after addressing their goal (e.g. "No evidence it helps with your goal to improve sleep quality. Well supported for strength and muscle — if that's a goal, add it.").
9. Suggestions: up to 3 catalog ingredients the user isn't already taking or considering, Strong/Moderate evidence for at least one stated goal, fitting the remaining budget. Return none rather than a weak suggestion.

**Settings:** `max_tokens` 6000, temperature 0. Transient errors retried ×2 (1s, 2s backoff). On validation failure, retry once with the error appended; then `502`.

## 6. Code-side enforcement (step 1 and step 7)

These run in code so the model can't break them. Everything below except capitalization triggers the validation retry:

- **Vague-goal filter (step 1):** blocklist + pattern check. Reject with a suggestion.
- **Id match:** every input id appears exactly once; no unknown ids. Names are *not* compared — the model may rename ("creatine" → "creatine monohydrate"); the user's original name is restored from the id.
- **Verdict/status match:** current → `Keep|Remove`; candidate → `Take|Don't`.
- **Goal tie-in:** `goalsAddressed` ⊆ user's goals; `reason` names a goal (word-stem match, so "building muscle" satisfies "build muscle").
- **Content guard:** diet or brand mentions in reason/mechanism/evidenceType of items *or* suggestions.
- **Suggestions:** ≤ 3; each a catalog ingredient; not already in stack/candidates (by name or alias); Strong/Moderate only; `goalsAddressed` non-empty ⊆ user's goals; total `estimatedMonthlyCost` ≤ monthly budget.
- **Deterministic overrides (no retry):** niche candidate → Don't/Insufficient; Insufficient → Remove/Don't; overrides clear `budgetFlag`; capitalize the first letter of `reason`.

## 7. Frontend

- One page. Form: stack, goals, candidates (tag inputs), budget (amount + period), collapsible blood work rows. **No diet field.**
- **Autocomplete** on ingredient fields (stack, candidates) from `catalog.json`: standard names with aliases ("vit D" → "vitamin D3"); typing an exact alias and pressing Enter inserts the standard name; free text still allowed. On goals: curated list of specific goals (free text still allowed, still vague-checked). Input that matches a known brand shows "Enter the ingredient instead (e.g. whey protein)." and isn't added.
- Results: one card per item. Header: name + chip (`current` / `candidate` / `suggested`). Big verdict (current-item `Remove` displays as "Not needed for your goals"), confidence badge + one-line explanation, reason, mechanism.
- **Suggested** section after the item cards, same card format; if empty: "No additional ingredients met the bar."
- Every `Take` card and every suggested card: "Look for a USP Verified or NSF Certified product" + a plain web search link for the ingredient name.
- Loading state; clear error messages for 400/429/502. Persistent footer disclaimer.

## 8. Build phases

1. Scaffold ✅ 2. Intake + validation ✅ 3. Model integration ✅ 4. Frontend ✅
5. **Hardening** — rate limiting, request size limit, CORS locked to own origin, no logging of blood work values.
6. **Deploy** ✅ (live on `*.workers.dev`)

## 9. Test fixtures (acceptance)

Unit tests (mocked model) cover schema, vague goals, compile, validation, overrides, retries. The golden eval set (`eval/eval-cases.json`, `npm run eval` / manual GitHub Action) runs against the real model, including:

- Short name `creatine` (current and candidate) — must not error; returned name stays `creatine`.
- Suggestions: only Strong/Moderate; relevant to the stated goal (allowlist per case); never an ingredient already in the stack (alias-aware); none when the budget can't fit anything.

## 10. Decisions (resolved)

1. Budget drives verdicts: over-budget weak items flagged first (`budgetFlag`). Suggestions must fit the remaining budget.
2. Insufficient → Remove/Don't ("no support found", not "proven harmful").
3. Blood work: fixed dropdown of 4 markers.
4. Medication interactions: disclaimer only (v2).
5. Evidence grounding: model knowledge, no citations (v2: web search).

## 11. Current change round (implemented in this order)

1. **Item ids (bug fix).** `creatine` + "build muscle" failed every time while `creatine monohydrate` worked: the exact-name check rejected the model's renamed item. Items get ids; the model echoes ids; names restored from ids. Also fix the goal-naming check to match word stems — the prompt's own example ("Building muscle: …") failed the old exact-substring check. Test + eval case for a short name.
2. **Wording.** Current-item `Remove` → "Not needed for your goals" in the UI. Reasons point out goals the item *is* well supported for when the user didn't list them.
3. **Autocomplete.** Curated `catalog.json` (ingredients + aliases, goals, brands); searchable dropdowns; brand warning; free text still allowed.
4. **Suggested additions.** Up to 3 catalog ingredients (Strong/Moderate, relevant, in budget) as "Suggested" cards, or a none-qualified message. USP/NSF line + ingredient search link on Take and suggested cards. Eval cases for suggestion quality.
