// Wiring test for subagent sessions and `autoOnly` in index.ts: drives the real extension through
// a fake ExtensionAPI. pi-subagents runs a foreground child in the parent's process and may expose
// PI_SUBAGENT_EXTENSION_BINDINGS only while the child starts, so these tests set it around
// `session_start` and remove it before the prompt arrives.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import bifrostExtension from "../index.ts";
import { makeModel, makePiClassifierModel, makeRegistry } from "./helpers.ts";
import { VIRTUAL_MODEL_API } from "../virtual-model.ts";
import { isSubagentSession } from "../subagent-session.ts";

const fast = makeModel("fake", "fast", 1, 1);
const strong = makeModel("fake", "strong", 10, 10);
const autoModel = { ...makeModel("bifrost", "auto"), api: VIRTUAL_MODEL_API };

const text = (value: string) => ({ type: "text", text: value });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function answer(choice: string): ClassifierResult {
  const probabilities: Record<string, number> = { quick: 0.05, general: 0.05, frontier: 0.05 };
  probabilities[choice] = 0.9;
  return {
    api: "systemone", provider: "typesafe", model: "jev", stopReason: "stop", timestamp: 1,
    answers: { tier: { type: "choice", choice, confidence: 0.9, probabilities } },
  } as unknown as ClassifierResult;
}

let previousCwd: string;
let work: string;
let home: string;
let previousAgentDir: string | undefined;

function harness(options: { autoOnly?: boolean } = {}) {
  rmSync(join(work, ".pi"), { recursive: true, force: true });
  writeFileSync(join(home, "bifrost.json"), JSON.stringify({ classifier: { context: { enabled: true } } }));
  writeFileSync(join(work, "bifrost.json"), JSON.stringify({
    enabled: true,
    ...(options.autoOnly !== undefined ? { autoOnly: options.autoOnly } : {}),
    default: "quick",
    strategy: "first",
    models: { quick: ["fake/fast"], general: ["fake/fast"], frontier: ["fake/strong"] },
    rules: [],
    classifier: {
      enabled: true,
      backend: "pi-native",
      piNative: { model: "typesafe/jev" },
      criteria: { quick: "small edits", general: "ordinary work", frontier: "hard work" },
    },
    cache: { enabled: false },
    reliability: { enabled: false },
  }));
  const calls: ClassifierContext[] = [];
  const selected: string[] = [];
  const registry = {
    ...makeRegistry([fast, strong], {
      classifierModels: [makePiClassifierModel("typesafe", "jev")],
      classify: (_model, context) => {
        calls.push(context);
        return answer("quick");
      },
    }),
    refresh: async () => {},
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let route: ((request: unknown, ctx: unknown) => Promise<{ model: { id: string } }>) | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
    registerCommand: () => {},
    registerVirtualModel: (definition: { route: typeof route }) => { route = definition.route; },
    setModel: async (model: { provider: string; id: string }) => { selected.push(`${model.provider}/${model.id}`); return true; },
  };
  bifrostExtension(pi as never);
  const ctx = (model: unknown, session: SessionManager) => ({
    mode: "print", hasUI: false, model, thinkingLevel: "off", signal: undefined,
    modelRegistry: registry, sessionManager: session,
  });
  const userRequest = (prompt: string) => ({
    reason: "user", thinkingLevel: "off", signal: undefined,
    messages: [{ role: "user", content: [text(prompt)], timestamp: 0 }],
  });
  return { calls, selected, handlers, ctx, route: (prompt: string, c: unknown) => route!(userRequest(prompt), c) };
}

/** A session that already ran one exchange (a resumed fix round), so context could be built. */
function sessionWithHistory(): SessionManager {
  const sm = SessionManager.inMemory(work);
  sm.appendMessage({ role: "user", content: [text("implement task 3")], timestamp: 0 } as never);
  sm.appendMessage({ role: "assistant", provider: "fake", model: "strong", api: "openai-completions", stopReason: "stop", timestamp: 0, usage, content: [text("Done, tests pass.")] } as never);
  return sm;
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = { error: console.error, warn: console.warn };
  console.error = () => {};
  console.warn = () => {};
  try { return await run(); } finally { console.error = original.error; console.warn = original.warn; }
}

/** Start a child the way pi-subagents does for a foreground launch with extension bindings. */
async function startChild(h: ReturnType<typeof harness>, model: unknown, session: SessionManager): Promise<void> {
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = "[]";
  try {
    await h.handlers.get("session_start")!({ type: "session_start", reason: "startup" }, h.ctx(model, session));
  } finally {
    delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  }
}

const previousExchanges = (context: ClassifierContext): unknown =>
  (context.state as Record<string, unknown> | undefined)?.previous_exchanges;

describe("index.ts subagent sessions and autoOnly", () => {
  before(() => {
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    work = mkdtempSync(join(tmpdir(), "bifrost-subagent-work-"));
    home = mkdtempSync(join(tmpdir(), "bifrost-subagent-home-"));
    mkdirSync(home, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = home;
    process.chdir(work);
  });
  after(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(work, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("recognizes a child after its start marker is gone and sends no context", async () => {
    const h = harness();
    const session = sessionWithHistory();
    await quietly(async () => {
      await startChild(h, strong, session);
      await h.handlers.get("input")!({ source: "interactive", text: "fix the failing test from review" }, h.ctx(strong, session));
    });
    assert.equal(isSubagentSession(session), true);
    assert.equal(h.calls.length, 1);
    assert.equal(previousExchanges(h.calls[0]), undefined, JSON.stringify(h.calls[0].state));
  });

  it("sends no context from the bifrost/auto route in a recognized child", async () => {
    const h = harness();
    const session = sessionWithHistory();
    await quietly(async () => {
      await startChild(h, autoModel, session);
      await h.route("fix the failing test from review", h.ctx(autoModel, session));
    });
    assert.equal(h.calls.length, 1);
    assert.equal(previousExchanges(h.calls[0]), undefined, JSON.stringify(h.calls[0].state));
  });

  it("autoOnly: leaves an explicitly launched physical model alone", async () => {
    const h = harness({ autoOnly: true });
    const session = SessionManager.inMemory(work);
    await quietly(async () => {
      await startChild(h, strong, session);
      await h.handlers.get("input")!({ source: "interactive", text: "fix the failing test from review" }, h.ctx(strong, session));
    });
    assert.equal(h.calls.length, 0, "nothing is classified");
    assert.deepEqual(h.selected, [], "the launch model stays selected");
  });

  it("autoOnly: leaves a physical model alone in a normal session too", async () => {
    const h = harness({ autoOnly: true });
    await quietly(() => h.handlers.get("input")!({ source: "interactive", text: "fix the failing test" }, h.ctx(strong, SessionManager.inMemory(work))));
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.selected, []);
  });

  it("autoOnly: still routes a session on bifrost/auto", async () => {
    const h = harness({ autoOnly: true });
    const session = SessionManager.inMemory(work);
    const result = await quietly(async () => {
      await startChild(h, autoModel, session);
      return h.route("fix the failing test from review", h.ctx(autoModel, session));
    });
    assert.equal(h.calls.length, 1);
    assert.equal(result.model.id, "fast");
  });

  it("without autoOnly, a physical model is routed as before", async () => {
    const h = harness();
    await quietly(() => h.handlers.get("input")!({ source: "interactive", text: "fix the failing test" }, h.ctx(strong, SessionManager.inMemory(work))));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.selected, ["fake/fast"]);
  });
});
