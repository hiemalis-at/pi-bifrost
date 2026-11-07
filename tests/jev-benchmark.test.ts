import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTEXT_INSTRUCTIONS } from "../classifier-semantics.ts";
import {
  CONFIDENCE_FLOOR,
  calculateArmReport,
  main,
  retainPreviousTier,
  runArms,
  toConversationContext,
  type ArmClassifier,
  type ArmRow,
  type JevJudgment,
  TYPESAFE_MODEL,
  TYPESAFE_SYSTEMONE_URL,
  baselineTier,
  buildRequest,
  calculateReport,
  parseJevResponse,
  parseJsonLines,
  runBenchmark,
  selectSplit,
  TypeSafeJevClient,
  type EvaluationRow,
  type Scenario,
} from "../scripts/jev-benchmark.ts";

const scenario = (id: string, prompt: string, goldTier: "quick" | "general" | "frontier", split: "dev" | "review" = "dev"): Scenario => ({
  id, prompt, family: "tests", goldTier, goldRationale: "fixture", ambiguity: "none", split,
});

function response(choice: "quick" | "general" | "frontier", model = TYPESAFE_MODEL): Response {
  const probabilities = { quick: 0.05, general: 0.05, frontier: 0.05 };
  probabilities[choice] = 0.9;
  return new Response(JSON.stringify({
    model,
    answers: { tier: { type: "choice", choice, probabilities, confidence: 0.85 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200 });
}

test("baseline uses ordered default rules and general fallback", () => {
  assert.deepEqual(baselineTier("format this JSON"), { tier: "quick", source: "regex_rule" });
  assert.deepEqual(baselineTier("implement pagination and add tests"), { tier: "general", source: "default" });
  assert.deepEqual(baselineTier("summarize this request"), { tier: "general", source: "default" });
});

test("request pins Jev and strict response parsing enforces the Choice distribution", () => {
  const request = buildRequest("diagnose flaky worker updates");
  assert.equal(request.model, "jev-1.13.0");
  assert.equal(TYPESAFE_MODEL, "jev-1.13.0");
  assert.deepEqual(parseJevResponse({
    model: TYPESAFE_MODEL,
    answers: { tier: { type: "choice", choice: "frontier", probabilities: { quick: 0.02, general: 0.18, frontier: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }).tier, "frontier");
  assert.throws(() => parseJevResponse({ model: "other-model", answers: { tier: { type: "choice", choice: "frontier", probabilities: { quick: 0, general: 0, frontier: 1 }, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), /invalid_response/);
  assert.throws(() => parseJevResponse({ answers: { tier: { type: "choice", choice: "frontier", probabilities: { frontier: 1 }, confidence: 1 } } }), /invalid_response/);
  assert.throws(() => parseJevResponse({ answers: { tier: { type: "choice", choice: "quick", probabilities: { quick: 0.1, general: 0.8, frontier: 0.1 }, confidence: 0.5 } } }), /invalid_response/);
  assert.throws(() => parseJevResponse({ answers: { tier: { type: "choice", choice: "quick", probabilities: { quick: 0.8, general: 0.1, frontier: 0.2 }, confidence: 0.5 } } }), /invalid_response/);
});

test("client posts fixed endpoint, retries only transient failures, and never exposes key", async () => {
  const statuses = [529, 200];
  let calls = 0;
  let authorization = "";
  const client = new TypeSafeJevClient({
    apiKey: "not-for-output",
    maxAttempts: 2,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      assert.equal(url, TYPESAFE_SYSTEMONE_URL);
      authorization = (init?.headers as Record<string, string>).authorization;
      const status = statuses[calls++];
      return status === 200 ? response("quick") : new Response("", { status });
    },
  });
  assert.equal((await client.evaluate("format this")).tier, "quick");
  assert.equal(calls, 2);
  assert.equal(authorization, "Bearer not-for-output");

  let authCalls = 0;
  const authClient = new TypeSafeJevClient({ apiKey: "secret", maxAttempts: 3, sleepImpl: async () => {}, fetchImpl: async () => { authCalls++; return new Response("", { status: 401 }); } });
  await assert.rejects(authClient.evaluate("x"), /auth/);
  assert.equal(authCalls, 1);
});

test("live benchmark bounds concurrency and preserves input order", async () => {
  let active = 0;
  let maxActive = 0;
  const client = new TypeSafeJevClient({ apiKey: "test", fetchImpl: async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return response("general");
  } });
  const scenarios = [scenario("one", "first", "general"), scenario("two", "second", "general"), scenario("three", "third", "general")];
  const rows = await runBenchmark(scenarios, { mode: "live", client, concurrency: 2 });
  assert.deepEqual(rows.map((row) => row.id), ["one", "two", "three"]);
  assert.equal(maxActive, 2);
});

test("report compares baseline and Jev on same successful subset while retaining all-row baseline", () => {
  const rows: EvaluationRow[] = [
    { id: "one", split: "dev", baselineTier: "quick", baselineSource: "regex_rule", goldTier: "quick", jevTier: "quick", status: "ok" },
    { id: "two", split: "dev", baselineTier: "general", baselineSource: "default", goldTier: "frontier", status: "error", error: "timeout" },
  ];
  const report = calculateReport(rows, "1");
  assert.equal(report.strictAccuracy.scored, 1);
  assert.equal(report.baselineComparableAccuracy.scored, 1);
  assert.equal(report.baselineComparableAccuracy.rate, 1);
  assert.equal(report.baselineAllRowsAccuracy.scored, 2);
  assert.equal(report.correctedRoutingDelta, 0);
  assert.equal(report.model.requested, "jev-1.13.0");
});

test("report calculates multiclass probability calibration", () => {
  const rows: EvaluationRow[] = [
    { id: "a", split: "dev", baselineTier: "general", baselineSource: "default", goldTier: "quick", jevTier: "quick", confidence: 0.7, probabilities: { quick: 0.8, general: 0.1, frontier: 0.1 }, status: "ok" },
    { id: "b", split: "dev", baselineTier: "general", baselineSource: "default", goldTier: "quick", jevTier: "general", confidence: 0.6, probabilities: { quick: 0.2, general: 0.7, frontier: 0.1 }, status: "ok" },
  ];
  const calibration = calculateReport(rows).calibration;
  assert.equal(calibration.samples, 2);
  assert.ok(Math.abs(calibration.multiclassBrier! - 0.6) < 1e-12);
  assert.ok(Math.abs(calibration.logLoss! - 0.916290731874155) < 1e-12);
  assert.ok(Math.abs(calibration.expectedCalibrationError! - 0.45) < 1e-12);
});

test("corpus parser rejects invalid records and split selection defaults to dev", () => {
  const records = [scenario("dev", "format this JSON", "quick", "dev"), scenario("review", "diagnose a deadlock", "frontier", "review")];
  const parsed = parseJsonLines(records.map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(selectSplit(parsed, "dev").map((record) => record.id), ["dev"]);
  assert.deepEqual(selectSplit(parsed, "review").map((record) => record.id), ["review"]);
  assert.equal(selectSplit(parsed, "all").length, 2);
  assert.throws(() => parseJsonLines(`${JSON.stringify(records[0])}\n${JSON.stringify({ ...records[0], prompt: "other" })}`), /duplicate id/);
  assert.throws(() => parseJsonLines(JSON.stringify({ ...records[0], split: "locked" })), /invalid split/);
  assert.throws(() => parseJsonLines(JSON.stringify({ ...records[0], goldTier: "cheap" })), /invalid goldTier/);
});

test("checked-in corpus and manifest agree", () => {
  const scenarios = parseJsonLines(readFileSync("tests/corpus/jev/scenarios.jsonl", "utf8"));
  const manifest = JSON.parse(readFileSync("tests/corpus/jev/manifest.json", "utf8")) as { counts: { total: number; dev: number; review: number; byTier: Record<string, number> } };
  assert.equal(scenarios.length, manifest.counts.total);
  assert.equal(selectSplit(scenarios, "dev").length, manifest.counts.dev);
  assert.equal(selectSplit(scenarios, "review").length, manifest.counts.review);
  for (const tier of ["quick", "general", "frontier"] as const) assert.equal(scenarios.filter((item) => item.goldTier === tier).length, manifest.counts.byTier[tier]);
});

// ---------------------------------------------------------------------------
// Multi-turn context arms
// ---------------------------------------------------------------------------

const MINI = "tests/corpus/jev-fixtures/multi-turn-mini.jsonl";
const miniScenarios = (): Scenario[] => parseJsonLines(readFileSync(MINI, "utf8"));

function judgment(tier: "quick" | "general" | "frontier", confidence = 0.85): JevJudgment {
  return { tier, confidence, probabilities: { quick: 0.05, general: 0.05, frontier: 0.05, [tier]: 0.9 }, model: TYPESAFE_MODEL, usage: { inputTokens: 10, outputTokens: 2 } };
}

const wrongTier = (gold: "quick" | "general" | "frontier"): "quick" | "general" | "frontier" => (gold === "general" ? "quick" : "general");

/** Arm 3 is right everywhere; arm 1 is right only on self-contained prompts. */
function contextHelpsClassifier(scenarios: readonly Scenario[]): ArmClassifier {
  const byId = new Map(scenarios.map((item) => [item.id, item]));
  return async ({ id, arm }) => {
    const item = byId.get(id)!;
    if (arm === "prompt-plus-context" || item.family === "single-turn") return judgment(item.goldTier);
    return judgment(wrongTier(item.goldTier));
  };
}

test("scenario parsing accepts context and rejects malformed context", () => {
  const scenarios = miniScenarios();
  assert.equal(scenarios.length, 8);
  assert.equal(scenarios[0].context?.previousTier, "frontier");
  assert.equal(scenarios[0].context?.exchanges.length, 1);
  assert.equal(scenarios[0].context?.exchanges[0].tier, "frontier");
  // The same short reply may appear in different conversations; identical prompt+context is still a duplicate.
  const base = { ...scenarios[0] };
  const other = { ...scenarios[1], id: "other", prompt: base.prompt };
  assert.equal(parseJsonLines([base, other].map((item) => JSON.stringify(item)).join("\n")).length, 2);
  assert.throws(() => parseJsonLines([base, { ...base, id: "again" }].map((item) => JSON.stringify(item)).join("\n")), /duplicate prompt/);
  for (const context of [{ exchanges: "x" }, { exchanges: [{ user: "u" }] }, { exchanges: [], previousTier: "cheap" }, []]) {
    assert.throws(() => parseJsonLines(JSON.stringify({ ...base, context })), /invalid context/);
  }
  // Records without context keep the single-turn shape.
  assert.equal(parseJsonLines(JSON.stringify(scenario("a", "format this", "quick")))[0].context, undefined);
});

test("retain-previous-tier answers previousTier, or the baseline default, with zero network calls", async () => {
  const withPrevious = { ...scenario("p", "Sounds good.", "quick"), context: { exchanges: [{ user: "u", assistant: "a" }], previousTier: "frontier" as const } };
  const withoutPrevious = { ...scenario("q", "Sounds good.", "quick"), context: { exchanges: [{ user: "u", assistant: "a" }] } };
  const noContext = scenario("r", "Sounds good, thanks.", "quick");
  assert.equal(retainPreviousTier(withPrevious), "frontier");
  assert.equal(retainPreviousTier(withoutPrevious), "general");
  assert.equal(retainPreviousTier(noContext), "general");

  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network is forbidden in offline arms"); }) as typeof fetch;
  try {
    const rows = await runArms([withPrevious, withoutPrevious], { arms: ["retain-previous-tier"] });
    assert.deepEqual(rows.map((row) => [row.id, row.arm, row.tier, row.status]), [["p", "retain-previous-tier", "frontier", "ok"], ["q", "retain-previous-tier", "general", "ok"]]);
    await assert.rejects(runArms([withPrevious], { arms: ["prompt-only"] }), /classifier is required/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("context arm sends the real instructions and object state through the injected client; prompt-only sends the bare string", async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = new TypeSafeJevClient({ apiKey: "test", fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response("frontier"); } });
  const [target] = miniScenarios();
  const context = toConversationContext(target.context!);
  assert.deepEqual(context, { exchanges: target.context!.exchanges, omittedEarlierTurns: false, chars: context.chars, redactions: 0, truncated: false });
  assert.equal(context.chars, target.context!.exchanges[0].user.length + target.context!.exchanges[0].assistant.length);

  await client.evaluate(target.prompt, context);
  await client.evaluate(target.prompt);
  const withContext = bodies[0] as { state: unknown; questions: { tier: { instructions: string } } };
  assert.deepEqual(withContext.state, {
    current_prompt: target.prompt,
    previous_exchanges: [{ user: target.context!.exchanges[0].user, assistant: target.context!.exchanges[0].assistant, tier: "frontier" }],
    omitted_earlier_turns: false,
  });
  assert.equal(withContext.questions.tier.instructions, CONTEXT_INSTRUCTIONS);
  const promptOnly = bodies[1] as { state: unknown; questions: { tier: { instructions: string } } };
  assert.equal(promptOnly.state, target.prompt);
  assert.notEqual(promptOnly.questions.tier.instructions, CONTEXT_INSTRUCTIONS);
  assert.deepEqual(buildRequest("x"), buildRequest("x", undefined));
});

test("runArms routes arm 1 prompt-only and arm 3 with context through the injected classifier", async () => {
  const scenarios = miniScenarios();
  const seen: { id: string; arm: string; hasContext: boolean }[] = [];
  const classify: ArmClassifier = async ({ id, arm, context }) => { seen.push({ id, arm, hasContext: context !== undefined }); return judgment("general"); };
  await runArms(scenarios.slice(0, 2), { classify });
  assert.deepEqual(seen.filter((item) => item.arm === "prompt-only").map((item) => item.hasContext), [false, false]);
  assert.deepEqual(seen.filter((item) => item.arm === "prompt-plus-context").map((item) => item.hasContext), [true, true]);
  assert.equal(seen.some((item) => item.arm === "retain-previous-tier"), false);
});

test("arm report lists families separately, confidence buckets, misses and the release guard", async () => {
  const scenarios = miniScenarios();
  const rows = await runArms(scenarios, { classify: contextHelpsClassifier(scenarios) });
  assert.equal(rows.length, 24);
  const report = calculateArmReport(rows, "mini");
  assert.deepEqual(Object.keys(report.perFamily).sort(), ["approval-after-plan", "approval-after-small-fix", "bare-option", "fix-it", "short-task-after-heavy", "short-task-after-trivial", "single-turn"]);
  assert.equal(report.perFamily["single-turn"].contextDependent, false);
  assert.equal(report.perFamily["fix-it"].contextDependent, true);
  assert.equal(report.perFamily["fix-it"].arms["prompt-plus-context"]!.accuracy, 1);
  assert.equal(report.perFamily["fix-it"].arms["prompt-only"]!.accuracy, 0);
  assert.equal(report.perFamily["single-turn"].arms["prompt-only"]!.n, 2);

  const pooled = report.contextDependent;
  assert.equal(pooled["prompt-plus-context"]!.n, 6);
  assert.equal(pooled["prompt-plus-context"]!.correct, 6);
  assert.equal(pooled["prompt-only"]!.correct, 0);
  // Retain-previous-tier keeps the right tier on the three approvals/option, wrong on the other three.
  assert.equal(pooled["retain-previous-tier"]!.correct, 3);
  assert.equal(pooled["retain-previous-tier"]!.underRouted + pooled["retain-previous-tier"]!.overRouted, 3);
  assert.equal(pooled["retain-previous-tier"]!.confidence, undefined);
  // fix-it gold frontier, arm 1 answered general: under-routed. short-task-after-heavy gold quick, arm 1 answered general: over-routed.
  assert.equal(report.perFamily["fix-it"].arms["prompt-only"]!.underRouted, 1);
  assert.equal(report.perFamily["short-task-after-heavy"].arms["prompt-only"]!.overRouted, 1);

  assert.deepEqual(pooled["prompt-plus-context"]!.confidence, { "<0.5": 0, "0.5-0.7": 0, "0.7-0.9": 6, ">=0.9": 0 });
  assert.equal(pooled["prompt-plus-context"]!.belowFloor, 0);
  assert.equal(report.contextDependent["prompt-plus-context"]!.errors, 0);
  assert.equal(report.confidenceFloor, CONFIDENCE_FLOOR);
  assert.equal(report.guard.singleTurnOk, true);
  assert.ok(Math.abs(report.guard.contextBeatsBothBy! - 50) < 1e-6);
  assert.equal(report.guard.contextOk, true);
});

test("release guard fails when the context arm does not beat both arms by the margin or hurts single-turn prompts", async () => {
  const scenarios = miniScenarios();
  // Context changes nothing: arm 3 equals arm 1.
  const same = calculateArmReport(await runArms(scenarios, { classify: async ({ id }) => judgment(scenarios.find((item) => item.id === id)!.goldTier === "quick" ? "quick" : "general") }));
  assert.equal(same.guard.contextOk, false);
  assert.equal(same.guard.singleTurnOk, true);
  // Context arm regresses on single-turn prompts.
  const byId = new Map(scenarios.map((item) => [item.id, item]));
  const regress = calculateArmReport(await runArms(scenarios, { classify: async ({ id, arm }) => {
    const item = byId.get(id)!;
    return judgment(arm === "prompt-plus-context" && item.family === "single-turn" ? wrongTier(item.goldTier) : item.goldTier);
  } }));
  assert.equal(regress.guard.singleTurnOk, false);
  // Beating arm 1 but not arm 2 by 15 points is not enough.
  const rows: ArmRow[] = [];
  for (let i = 0; i < 20; i++) {
    const common = { id: `s${i}`, split: "dev" as const, family: "continue", goldTier: "quick" as const, status: "ok" as const };
    rows.push({ ...common, arm: "prompt-only", tier: "general", confidence: 0.9 });
    rows.push({ ...common, arm: "retain-previous-tier", tier: i < 16 ? "quick" : "general" });
    rows.push({ ...common, arm: "prompt-plus-context", tier: i < 18 ? "quick" : "general", confidence: 0.9 });
  }
  const close = calculateArmReport(rows);
  assert.ok(Math.abs(close.guard.contextBeatsBothBy! - 10) < 1e-6);
  assert.equal(close.guard.contextOk, false);
});

test("low-confidence answers and transport errors count as misses and incorrect", async () => {
  const scenarios = miniScenarios().slice(0, 3);
  const classify: ArmClassifier = async ({ id, arm }) => {
    if (arm === "prompt-only") throw new Error("timeout");
    const item = scenarios.find((entry) => entry.id === id)!;
    return judgment(item.goldTier, id === scenarios[0].id ? 0.6 : id === scenarios[1].id ? 0.95 : 0.69);
  };
  const report = calculateArmReport(await runArms(scenarios, { classify }));
  const arm3 = report.contextDependent["prompt-plus-context"]!;
  assert.equal(arm3.n, 3);
  assert.equal(arm3.correct, 1);
  assert.equal(arm3.belowFloor, 2);
  assert.equal(arm3.misses, 2);
  assert.ok(Math.abs(arm3.accuracy! - 1 / 3) < 1e-12);
  assert.deepEqual(arm3.confidence, { "<0.5": 0, "0.5-0.7": 2, "0.7-0.9": 0, ">=0.9": 1 });
  const arm1 = report.contextDependent["prompt-only"]!;
  assert.equal(arm1.errors, 3);
  assert.equal(arm1.misses, 3);
  assert.equal(arm1.accuracy, 0);
});

test("arm report excludes unresolved scenarios and never contains scenario or exchange text", async () => {
  const sentinels = ["SENTINEL_PROMPT_7f3a", "SENTINEL_USER_9b21", "SENTINEL_ASSISTANT_c44d", "SENTINEL_TOOLS_e105"];
  const leaky: Scenario[] = [
    { ...scenario("leak-1", sentinels[0], "frontier"), family: "continue", context: { exchanges: [{ user: sentinels[1], assistant: sentinels[2], tools: sentinels[3], tier: "quick" }], previousTier: "quick" } },
    { ...scenario("leak-2", `${sentinels[0]} two`, "quick"), family: "single-turn", unresolved: true, context: { exchanges: [{ user: sentinels[1], assistant: sentinels[2] }] } },
  ];
  const rows = await runArms(leaky, { classify: async () => { throw new Error("http"); } });
  const report = calculateArmReport(rows, "v");
  assert.equal(report.contextDependent["prompt-plus-context"]!.n, 1);
  assert.equal(report.perFamily["single-turn"], undefined);
  const serialized = JSON.stringify({ ...report, rows });
  for (const sentinel of sentinels) assert.equal(serialized.includes(sentinel), false, sentinel);
});

test("CLI arm mode reads a fixture, prints the arm report, and prints no scenario text", async () => {
  const scenarios = miniScenarios();
  const dir = mkdtempSync(join(tmpdir(), "jev-arms-"));
  const fixture: Record<string, unknown> = {};
  for (const item of scenarios) {
    for (const arm of ["prompt-only", "prompt-plus-context"] as const) {
      const tier = arm === "prompt-plus-context" || item.family === "single-turn" ? item.goldTier : wrongTier(item.goldTier);
      const payload = await response(tier).json();
      fixture[`${item.id}:${arm}`] = payload;
    }
  }
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = () => {};
  try {
    await main(["--fixture", join(dir, "fixture.json"), MINI, "--split", "all", "--arms", "all"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const output = JSON.parse(logs.join("\n")) as ReturnType<typeof calculateArmReport> & { rows: ArmRow[] };
  assert.equal(output.guard.contextOk, true);
  assert.equal(output.rows.length, 24);
  for (const item of scenarios) {
    // Skip bare replies such as "2": they collide with digits in ordinary JSON output.
    if (item.prompt.length >= 10) assert.equal(logs.join("\n").includes(item.prompt), false);
    for (const exchange of item.context!.exchanges) assert.equal(logs.join("\n").includes(exchange.user), false);
  }
});

test("multi-turn mini fixture covers each family kind and stays out of the checked-in corpus manifest", () => {
  const families = new Set(miniScenarios().map((item) => item.family));
  for (const family of ["approval-after-plan", "approval-after-small-fix", "bare-option", "fix-it", "short-task-after-trivial", "short-task-after-heavy", "single-turn"]) assert.ok(families.has(family), family);
  const manifest = JSON.parse(readFileSync("tests/corpus/jev/manifest.json", "utf8")) as { counts: { total: number } };
  const corpus = parseJsonLines(readFileSync("tests/corpus/jev/scenarios.jsonl", "utf8"));
  assert.equal(corpus.length, manifest.counts.total);
  assert.equal(corpus.some((item) => item.id.startsWith("mt-mini")), false);
});
