// Keep in sync with BLOOD_MARKERS in src/schema.ts.
const BLOOD_MARKERS = [
  { key: "vitamin_d", label: "Vitamin D (25-OH)", unit: "ng/mL" },
  { key: "vitamin_b12", label: "Vitamin B12", unit: "pg/mL" },
  { key: "ferritin", label: "Ferritin", unit: "ng/mL" },
  { key: "omega3_index", label: "Omega-3 Index", unit: "%" },
];

// Mirrors the code-side check in src/goals.ts so users get instant feedback;
// the server is still the source of truth.
const VAGUE_PATTERNS = [/\bwellness\b/i, /\bhealthier\b/i, /\bhealth\b/i, /\bfeel better\b/i, /\boverall\b/i, /\bgeneral\b/i];

function isVagueGoal(goal) {
  return VAGUE_PATTERNS.some((p) => p.test(goal));
}

function createTagInput(fieldName, { validate } = {}) {
  const container = document.querySelector(`.tag-input[data-field="${fieldName}"]`);
  const tagsEl = container.querySelector(".tags");
  const input = container.querySelector("input[type='text']");
  const tags = [];

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
        render();
      });
      el.appendChild(removeBtn);
      tagsEl.appendChild(el);
    });
  }

  function addTag(raw) {
    const value = raw.trim();
    if (!value) return;
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
      input.value = "";
      return;
    }
    if (validate) validate(value);
    tags.push(value);
    input.value = "";
    render();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input.value);
    } else if (e.key === "Backspace" && input.value === "" && tags.length > 0) {
      tags.pop();
      render();
    }
  });

  input.addEventListener("blur", () => {
    if (input.value.trim()) addTag(input.value);
  });

  return {
    getTags: () => [...tags],
  };
}

const goalsError = document.getElementById("goals-error");

const stackField = createTagInput("stack");
const candidatesField = createTagInput("candidates");
const goalsField = createTagInput("goals", {
  validate: (goal) => {
    if (isVagueGoal(goal)) {
      goalsError.hidden = false;
      goalsError.textContent = `"${goal}" looks vague. Try something specific and testable, e.g. "improve sleep quality" or "build muscle".`;
    } else {
      goalsError.hidden = true;
    }
  },
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
};

// Confidence means how sure we are in the verdict, based on evidence
// strength for that verdict — not whether the evidence shows a benefit.
const CONFIDENCE_EXPLANATION = {
  Strong: "Multiple independent trials or meta-analyses consistently support this verdict, for or against.",
  Moderate: "Human trials point this way, but they're small, few, or industry-funded.",
  Weak: "Human evidence exists but is low quality or inconsistent.",
  "Insufficient evidence to rate": "Little or no human research exists on this ingredient for this goal.",
};

const POSITIVE_VERDICTS = new Set(["Keep", "Take"]);

function renderResults(evaluation) {
  resultsCards.innerHTML = "";

  for (const item of evaluation.items) {
    const card = document.createElement("article");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "card-header";

    const title = document.createElement("h3");
    title.textContent = item.name;

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = item.status;

    header.append(title, chip);

    const verdict = document.createElement("p");
    verdict.className = `verdict ${POSITIVE_VERDICTS.has(item.verdict) ? "positive" : "negative"}`;
    verdict.textContent = item.verdict;

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

    card.append(header, verdict, ...badgeRow, confidenceExplainer, reasonLabel, reason, mechanismLabel, mechanism);
    resultsCards.appendChild(card);
  }

  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFormError();
  goalsError.hidden = true;
  resultsEl.hidden = true;

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
      if (body.error === "vague_goal") {
        goalsError.hidden = false;
        goalsError.textContent = `"${body.goal}" is too vague. ${body.suggestion}`;
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
