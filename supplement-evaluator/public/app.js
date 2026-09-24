// Keep in sync with BLOOD_MARKERS in src/schema.ts.
const BLOOD_MARKERS = [
  { key: "vitamin_d", label: "Vitamin D (25-OH)", unit: "ng/mL" },
  { key: "vitamin_b12", label: "Vitamin B12", unit: "pg/mL" },
  { key: "ferritin", label: "Ferritin", unit: "ng/mL" },
  { key: "omega3_index", label: "Omega-3 Index", unit: "%" },
];

// Curated ingredients (+aliases), goals, and brand names. Same file the Worker
// imports (src/catalog.ts). Until it loads, ingredient inputs work as plain
// free text; goals can only be picked from the list, so a failed load says so.
let catalog = { ingredients: [], goals: [], brands: [] };
fetch("/catalog.json")
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((data) => {
    catalog = data;
  })
  .catch(() => {
    showFormError("Couldn't load the goal list. Refresh the page to try again.");
  });

// Keep in sync with normalizeTerm in src/catalog.ts.
function normalizeTerm(text) {
  return text.toLowerCase().replace(/[.\-_]/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeBrand(text) {
  if (/[®™]/.test(text)) return true;
  const normalized = ` ${normalizeTerm(text)} `;
  return catalog.brands.some((brand) => normalized.includes(` ${normalizeTerm(brand)} `));
}

function ingredientOptions() {
  return catalog.ingredients.map((i) => ({ value: i.name, terms: [i.name, ...i.aliases] }));
}

function goalOptions() {
  return catalog.goals.map((g) => ({ value: g, terms: [g] }));
}

const MAX_SUGGESTIONS = 8;

// Tag input with an accessible combobox dropdown. Free text is allowed by
// default: Enter adds the highlighted option if one is highlighted, otherwise
// the typed text — canonicalized when it exactly matches a known name or alias.
// `closed: true` makes it a fixed-list multi-select instead (goals): focus opens
// the full list, and only list entries can be added — typed text that doesn't
// resolve to one is never submitted. The server enforces the same list.
function createTagInput(fieldName, { getOptions, validate, closed = false, max = Infinity, errorEl, noMatch } = {}) {
  const container = document.querySelector(`.tag-input[data-field="${fieldName}"]`);
  const tagsEl = container.querySelector(".tags");
  const input = container.querySelector("input[type='text']");
  const tags = [];
  const maxMessage = `You can pick up to ${max} ${fieldName}.`;

  const listbox = document.createElement("ul");
  listbox.className = "suggestions";
  listbox.id = `${fieldName}-listbox`;
  listbox.setAttribute("role", "listbox");
  listbox.hidden = true;
  container.appendChild(listbox);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listbox.id);
  input.setAttribute("aria-expanded", "false");

  let matches = [];
  let active = -1;

  // Closed lists report their own errors; free-text fields use `validate`.
  function setError(message) {
    if (!errorEl) return;
    errorEl.hidden = !message;
    errorEl.textContent = message || "";
  }

  function render() {
    tagsEl.innerHTML = "";
    tags.forEach((tag, i) => {
      const el = document.createElement("span");
      el.className = "tag";
      el.textContent = tag;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", `Remove ${tag}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        tags.splice(i, 1);
        setError("");
        render();
      });
      el.appendChild(removeBtn);
      tagsEl.appendChild(el);
    });
  }

  function closeList() {
    matches = [];
    active = -1;
    listbox.hidden = true;
    listbox.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function renderList() {
    listbox.innerHTML = "";
    if (matches.length === 0) {
      closeList();
      return;
    }
    matches.forEach((match, i) => {
      const li = document.createElement("li");
      li.id = `${fieldName}-option-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      if (i === active) li.className = "active";
      li.textContent = match.value;
      if (match.matchedAlias) {
        const hint = document.createElement("span");
        hint.className = "alias-hint";
        hint.textContent = ` — matches "${match.matchedAlias}"`;
        li.appendChild(hint);
      }
      // mousedown (not click) so the input's blur doesn't add the raw text first.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addTag(match.value);
        // Closed lists stay open so several entries can be picked in a row.
        if (closed) updateMatches();
      });
      listbox.appendChild(li);
    });
    listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${fieldName}-option-${active}`);
      document.getElementById(`${fieldName}-option-${active}`).scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function updateMatches() {
    const query = normalizeTerm(input.value);
    if (tags.length >= max) {
      closeList();
      if (query) setError(maxMessage);
      return;
    }
    // Free-text fields suggest only while typing; closed lists also browse.
    if (!getOptions || (!query && !closed)) {
      closeList();
      return;
    }
    const taken = new Set(tags.map(normalizeTerm));
    const scored = [];
    for (const option of getOptions()) {
      if (taken.has(normalizeTerm(option.value))) continue;
      if (!query) {
        scored.push({ value: option.value, matchedAlias: null, score: 0 });
        continue;
      }
      let best = null;
      for (const term of option.terms) {
        const t = normalizeTerm(term);
        const index = t.indexOf(query);
        if (index === -1) continue;
        // Rank: whole term starts with query > a word starts with it > mid-word.
        const score = index === 0 ? 0 : t[index - 1] === " " ? 1 : 2;
        if (!best || score < best.score) best = { score, term };
      }
      if (best) {
        const matchedAlias = normalizeTerm(best.term) === normalizeTerm(option.value) ? null : best.term;
        scored.push({ value: option.value, matchedAlias, score: best.score });
      }
    }
    scored.sort((a, b) => a.score - b.score || a.value.localeCompare(b.value));
    matches = closed ? scored : scored.slice(0, MAX_SUGGESTIONS);
    // Closed lists: while searching, Enter takes the top match; browsing preselects nothing.
    active = closed && query && matches.length > 0 ? 0 : -1;
    renderList();
  }

  // Exact name or alias -> its list entry; anything else -> undefined.
  function resolve(raw) {
    const key = normalizeTerm(raw);
    if (!getOptions || !key) return undefined;
    const option = getOptions().find((o) => o.terms.some((t) => normalizeTerm(t) === key));
    return option && option.value;
  }

  function canonicalize(raw) {
    return resolve(raw) ?? raw;
  }

  function rejectTypedText() {
    const text = input.value.trim();
    if (text) setError(tags.length >= max ? maxMessage : noMatch(text));
  }

  function addTag(raw) {
    const value = canonicalize(raw.trim());
    if (!value) return;
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      input.value = "";
      closeList();
      return;
    }
    if (tags.length >= max) {
      setError(maxMessage);
      closeList();
      return;
    }
    // validate returns false to reject; the text stays in the box to edit.
    if (validate && validate(value) === false) {
      closeList();
      return;
    }
    tags.push(value);
    input.value = "";
    setError("");
    closeList();
    render();
  }

  input.addEventListener("input", () => {
    setError("");
    updateMatches();
  });

  if (closed) {
    input.addEventListener("focus", updateMatches);
    input.addEventListener("click", () => {
      if (listbox.hidden) updateMatches();
    });
    // Clicking empty space in the box (or the caret) focuses the search and opens the list.
    container.addEventListener("mousedown", (e) => {
      if (e.target === container || e.target === tagsEl) {
        e.preventDefault();
        input.focus();
        if (listbox.hidden) updateMatches();
      }
    });
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && (matches.length > 0 || closed)) {
      e.preventDefault();
      if (listbox.hidden) {
        updateMatches();
      } else {
        active = (active + 1) % matches.length;
        renderList();
      }
    } else if (e.key === "ArrowUp" && matches.length > 0) {
      e.preventDefault();
      active = active <= 0 ? matches.length - 1 : active - 1;
      renderList();
    } else if (e.key === "Escape") {
      closeList();
    } else if (e.key === "Enter" || (e.key === "," && !closed)) {
      e.preventDefault();
      if (!closed) {
        addTag(active >= 0 ? matches[active].value : input.value);
      } else {
        const value = active >= 0 ? matches[active].value : resolve(input.value);
        if (value) addTag(value);
        else rejectTypedText();
      }
    } else if (e.key === "Backspace" && input.value === "" && tags.length > 0) {
      tags.pop();
      render();
      if (closed && !listbox.hidden) updateMatches();
    }
  });

  input.addEventListener("blur", () => {
    closeList();
    if (!input.value.trim()) return;
    if (!closed) {
      addTag(input.value);
    } else {
      const value = resolve(input.value);
      if (value) addTag(value);
      else rejectTypedText();
    }
  });

  return {
    getTags: () => [...tags],
    // Closed lists: typed text that never resolved to a list entry. Submit
    // stops rather than silently dropping it.
    hasUnresolvedText: () => closed && input.value.trim() !== "",
    focus: () => input.focus(),
  };
}

const goalsError = document.getElementById("goals-error");

function ingredientValidator(errorEl) {
  return (value) => {
    if (looksLikeBrand(value)) {
      errorEl.hidden = false;
      errorEl.textContent = "Enter the ingredient instead (e.g. whey protein).";
      return false;
    }
    errorEl.hidden = true;
    return true;
  };
}

const stackError = document.getElementById("stack-error");
const candidatesError = document.getElementById("candidates-error");

// errorEl lets a field clear a server error (e.g. a denied substance) once
// the user edits or removes tags.
const stackField = createTagInput("stack", {
  getOptions: ingredientOptions,
  validate: ingredientValidator(stackError),
  errorEl: stackError,
});
const candidatesField = createTagInput("candidates", {
  getOptions: ingredientOptions,
  validate: ingredientValidator(candidatesError),
  errorEl: candidatesError,
});
const goalsField = createTagInput("goals", {
  getOptions: goalOptions,
  closed: true,
  max: 5, // mirrors IntakeSchema in src/schema.ts
  errorEl: goalsError,
  noMatch: (text) => `"${text}" isn't on the list of supported goals. Pick a specific, testable goal from the dropdown.`,
});

// Blood work rows
const bloodworkRows = document.getElementById("bloodwork-rows");
const addBloodworkRowBtn = document.getElementById("add-bloodwork-row");

function addBloodworkRow() {
  const row = document.createElement("div");
  row.className = "bloodwork-row";

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Blood marker");
  for (const marker of BLOOD_MARKERS) {
    const opt = document.createElement("option");
    opt.value = marker.key;
    opt.textContent = `${marker.label} (${marker.unit})`;
    select.appendChild(opt);
  }

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.step = "any";
  valueInput.min = "0";
  valueInput.placeholder = "Value";
  valueInput.setAttribute("aria-label", "Marker value");

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "remove-row";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", () => row.remove());

  row.append(select, valueInput, removeBtn);
  bloodworkRows.appendChild(row);
}

addBloodworkRowBtn.addEventListener("click", addBloodworkRow);

function collectBloodWork() {
  const entries = [];
  for (const row of bloodworkRows.querySelectorAll(".bloodwork-row")) {
    const select = row.querySelector("select");
    const valueInput = row.querySelector("input");
    if (valueInput.value === "") continue;
    entries.push({ marker: select.value, value: Number(valueInput.value) });
  }
  return entries;
}

// Form submit
const form = document.getElementById("evaluate-form");
const submitBtn = document.getElementById("submit-btn");
const formError = document.getElementById("form-error");
const loadingEl = document.getElementById("loading");
const resultsEl = document.getElementById("results");
const resultsCards = document.getElementById("results-cards");

function showFormError(message) {
  formError.hidden = false;
  formError.textContent = message;
}

function clearFormError() {
  formError.hidden = true;
  formError.textContent = "";
}

function setLoading(isLoading) {
  loadingEl.hidden = !isLoading;
  submitBtn.disabled = isLoading;
}

const CONFIDENCE_CLASS = {
  Strong: "Strong",
  Moderate: "Moderate",
  Weak: "Weak",
  "Insufficient evidence to rate": "Insufficient",
  "Known hazard": "Hazard",
};

// Confidence means how sure we are in the verdict, based on evidence
// strength for that verdict — not whether the evidence shows a benefit.
const CONFIDENCE_EXPLANATION = {
  Strong: "Multiple independent trials or meta-analyses consistently support this verdict, for or against.",
  Moderate: "Human trials point this way, but they're small, few, or industry-funded.",
  Weak: "Human evidence exists but is low quality or inconsistent.",
  "Insufficient evidence to rate": "Little or no human research exists on this ingredient for this goal.",
  "Known hazard": "Documented toxicity and deaths in humans. This is a safety warning, not an evidence rating.",
};

const POSITIVE_VERDICTS = new Set(["Keep", "Take"]);

// The API keeps "Remove" as the verdict value; users see the softer label,
// since most removals mean "no support for your goals", not "harmful".
const VERDICT_LABEL = { Remove: "Not needed for your goals" };

// A known hazard (src/hazards.ts) must never get the soft "Not needed" label.
const HAZARD_VERDICT_LABEL = { Remove: "Stop taking: known hazard", "Don't": "Don't take: known hazard" };

// Plain web search for the ingredient name only — never a product or store.
function ingredientSearchUrl(name) {
  return `https://www.google.com/search?q=${encodeURIComponent(name)}`;
}

function buildBuyingNote(name) {
  const note = document.createElement("p");
  note.className = "buying-note";
  note.append("Look for a USP Verified or NSF Certified product. ");
  const link = document.createElement("a");
  link.href = ingredientSearchUrl(name);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `Search the web for ${name}`;
  note.appendChild(link);
  return note;
}

function buildCard(item) {
  const card = document.createElement("article");
  card.className = item.status === "suggested" ? "card suggested" : "card";

  const header = document.createElement("div");
  header.className = "card-header";

  const title = document.createElement("h3");
  title.textContent = item.name;

  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = item.status;

  header.append(title, chip);

  // Synonyms merged into this item by the server (e.g. cholecalciferol -> vitamin D3).
  const alsoEntered = (item.alsoSubmittedAs || []).map((a) => `${a.name} (${a.status})`);
  const alsoEl = document.createElement("p");
  alsoEl.className = "also-entered";
  alsoEl.textContent = `Also entered as: ${alsoEntered.join(", ")}`;

  const verdict = document.createElement("p");
  verdict.className = `verdict ${POSITIVE_VERDICTS.has(item.verdict) ? "positive" : "negative"}`;
  const labels = item.confidence === "Known hazard" ? HAZARD_VERDICT_LABEL : VERDICT_LABEL;
  verdict.textContent = labels[item.verdict] || item.verdict;

  const badge = document.createElement("span");
  const confidenceClass = CONFIDENCE_CLASS[item.confidence] || "Insufficient";
  badge.className = `badge ${confidenceClass}`;
  badge.textContent = item.confidence;

  const badgeRow = [badge];
  if (item.budgetFlag) {
    const budgetBadge = document.createElement("span");
    budgetBadge.className = "badge budget-flag";
    budgetBadge.textContent = "Budget-limited";
    badgeRow.push(budgetBadge);
  }

  const confidenceExplainer = document.createElement("p");
  confidenceExplainer.className = "confidence-explainer";
  confidenceExplainer.textContent =
    CONFIDENCE_EXPLANATION[item.confidence] || CONFIDENCE_EXPLANATION["Insufficient evidence to rate"];

  const reasonLabel = document.createElement("p");
  reasonLabel.className = "label";
  reasonLabel.textContent = "Why";
  const reason = document.createElement("p");
  reason.textContent = item.reason;

  const mechanismLabel = document.createElement("p");
  mechanismLabel.className = "label";
  mechanismLabel.textContent = "How it works";
  const mechanism = document.createElement("p");
  mechanism.textContent = item.mechanism;

  card.append(header);
  if (alsoEntered.length > 0) card.appendChild(alsoEl);
  card.append(verdict, ...badgeRow, confidenceExplainer, reasonLabel, reason, mechanismLabel, mechanism);
  if (item.verdict === "Take") card.appendChild(buildBuyingNote(item.name));
  return card;
}

function renderResults(evaluation) {
  resultsCards.innerHTML = "";
  for (const item of evaluation.items) resultsCards.appendChild(buildCard(item));

  const suggestedHeading = document.createElement("h2");
  suggestedHeading.className = "suggested-heading";
  suggestedHeading.textContent = "Suggested additions";
  resultsCards.appendChild(suggestedHeading);

  const suggestions = evaluation.suggestions || [];
  if (suggestions.length === 0) {
    const none = document.createElement("p");
    none.className = "no-suggestions";
    none.textContent =
      "No additional ingredients met the bar: Strong or Moderate evidence for your goals, within your budget.";
    resultsCards.appendChild(none);
  } else {
    for (const suggestion of suggestions) resultsCards.appendChild(buildCard(suggestion));
  }

  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFormError();
  resultsEl.hidden = true;

  if (goalsField.hasUnresolvedText()) {
    showFormError("Pick each goal from the dropdown list, or clear the text you typed.");
    goalsField.focus();
    return;
  }

  const goals = goalsField.getTags();
  if (goals.length === 0) {
    showFormError("Add at least one goal.");
    return;
  }

  const amount = Number(document.getElementById("budget-amount").value);
  if (!amount || amount <= 0) {
    showFormError("Enter a budget amount.");
    return;
  }

  const payload = {
    stack: stackField.getTags(),
    goals,
    candidates: candidatesField.getTags(),
    budget: {
      amount,
      currency: document.getElementById("budget-currency").value,
      period: document.getElementById("budget-period").value,
    },
    bloodWork: collectBloodWork(),
  };

  if (payload.stack.length === 0 && payload.candidates.length === 0) {
    showFormError("Add at least one current item or candidate to evaluate.");
    return;
  }

  setLoading(true);
  try {
    const response = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.status === 429) {
      showFormError("Too many requests right now. Please wait a moment and try again.");
      return;
    }

    if (response.status === 502) {
      showFormError("We couldn't produce a reliable evaluation this time. Please try again.");
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body.error === "denied_substance") {
        // Shown under each field; the tag stays so the user can see what to remove.
        for (const [field, errorEl] of [["stack", stackError], ["candidates", candidatesError]]) {
          const denied = body.rejected.filter((r) => r.field === field);
          if (denied.length === 0) continue;
          errorEl.hidden = false;
          errorEl.textContent = denied
            .map((r) => `"${r.value}" is a controlled substance or drug (${r.substance}), not a supplement, so it can't be evaluated. Remove it to continue.`)
            .join(" ");
        }
      } else if (body.error === "not_on_allowlist") {
        // Only reachable if the goal list changed after this page loaded.
        goalsError.hidden = false;
        goalsError.textContent = `${body.message} Refresh the page to get the current list.`;
      } else {
        showFormError("Something about that submission wasn't valid. Please check your inputs and try again.");
      }
      return;
    }

    const evaluation = await response.json();
    renderResults(evaluation);
  } catch (err) {
    showFormError("Network error — please check your connection and try again.");
  } finally {
    setLoading(false);
  }
});
