// Wiring test for index.ts: drives the real extension (input handler and the
// `bifrost/auto` route) through a fake ExtensionAPI and a fake Pi-native
// classifier registry. Proves that context options reach the direct classifier
// at both routed call sites and that a context-fed result is never cached.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import bifrostExtension from "../index.ts";
import { makeModel, makePiClassifierModel, makeRegistry } from "./helpers.ts";
import { VIRTUAL_MODEL_API } from "../virtual-model.ts";
import { normalize } from "../cache.ts";

const fast = makeModel("fake", "fast");
const strong = makeModel("fake", "strong");
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

interface Harness {
  readonly calls: ClassifierContext[];
  readonly handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
  readonly route: (request: unknown, ctx: unknown) => Promise<{ model: { id: string } }>;
  ctx(model: unknown, session: SessionManager): unknown;
  /** Whether the persisted fuzzy cache holds an entry for this prompt. */
  cached(prompt: string): boolean;
}

let previousCwd: string;
let work: string;
let home: string;
let previousAgentDir: string | undefined;

/**
 * `contextLayer` is where `classifier.context.enabled` is set: the global config (the only layer
 * that can turn it on), the project file (ignored when true), or nowhere.
 */
function harness(contextEnabled: boolean, contextLayer: "global" | "project" = "global"): Harness {
  // Fresh project per harness: config, cache, reliability and runtime state live under cwd.
  rmSync(join(work, ".pi"), { recursive: true, force: true });
  rmSync(join(home, "bifrost.json"), { force: true });
  if (contextLayer === "global") {
    writeFileSync(join(home, "bifrost.json"), JSON.stringify({ classifier: { context: { enabled: contextEnabled } } }));
  }
  writeFileSync(join(work, "bifrost.json"), JSON.stringify({
    enabled: true,
    default: "quick",
    strategy: "first",
    models: { quick: ["fake/fast"], general: ["fake/fast"], frontier: ["fake/strong"] },
    rules: [],
    classifier: {
      enabled: true,
      backend: "pi-native",
      piNative: { model: "typesafe/jev" },
      criteria: { quick: "small edits", general: "ordinary work", frontier: "hard work" },
      ...(contextLayer === "project" ? { context: { enabled: contextEnabled } } : {}),
    },
    cache: { enabled: true },
    reliability: { enabled: false },
  }));
  const calls: ClassifierContext[] = [];
  const registry = {
    ...makeRegistry([fast, strong], {
      classifierModels: [makePiClassifierModel("typesafe", "jev")],
      classify: (_model, context) => {
        calls.push(context);
        return answer("frontier");
      },
    }),
    refresh: async () => {},
  };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  let route: Harness["route"] | undefined;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(name, handler); },
    registerCommand: () => {},
    registerVirtualModel: (definition: { route: Harness["route"] }) => { route = definition.route; },
    setModel: async () => true,
  };
  bifrostExtension(pi as never);
  assert.ok(route, "bifrost/auto must be registered");
  return {
    calls,
    handlers,
    route,
    ctx: (model, session) => ({
      mode: "print", hasUI: false, model, thinkingLevel: "off", signal: undefined,
      modelRegistry: registry, sessionManager: session,
    }),
    cached: (prompt) => {
      const path = join(work, ".pi", "bifrost-cache.jsonl");
      if (!existsSync(path)) return false;
      return readFileSync(path, "utf8").split("\n").filter(Boolean)
        .some((line) => (JSON.parse(line) as { normalized?: string }).normalized === normalize(prompt));
    },
  };
}

/** A session with one finished exchange; the next prompt has context. */
function sessionWithHistory(): SessionManager {
  const sm = SessionManager.inMemory(work);
  sm.appendMessage({ role: "user", content: [text("plan the storage migration")], timestamp: 0 } as never);
  sm.appendMessage({ role: "assistant", provider: "fake", model: "strong", api: "openai-completions", stopReason: "stop", timestamp: 0, usage, content: [text("Plan: three steps.")] } as never);
  return sm;
}

function previousExchanges(context: ClassifierContext): unknown {
  return (context.state as Record<string, unknown>).previous_exchanges;
}

const mutedErrors = async <T>(run: () => Promise<T> | T): Promise<{ result: T; errors: string[] }> => {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try { return { result: await run(), errors }; } finally { console.error = original; }
};

const muted = <T>(run: () => Promise<T>): Promise<T> => {
  const original = { error: console.error, warn: console.warn };
  console.error = () => {};
  console.warn = () => {};
  return run().finally(() => { console.error = original.error; console.warn = original.warn; });
};

describe("index.ts context wiring", () => {
  before(() => {
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    work = mkdtempSync(join(tmpdir(), "bifrost-wiring-work-"));
    home = mkdtempSync(join(tmpdir(), "bifrost-wiring-home-"));
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

  it("input handler: hands context to the direct classifier and does not cache the result", async () => {
    const h = harness(true);
    const input = h.handlers.get("input");
    assert.ok(input);

    // Control: first turn, no prior exchange, so no context: the answer is cached as today.
    await muted(() => input({ source: "interactive", text: "rename the helper function" }, h.ctx(fast, SessionManager.inMemory(work))));
    assert.equal(h.calls.length, 1);
    assert.equal(previousExchanges(h.calls[0]), undefined);
    assert.ok(h.cached("rename the helper function"), "context-free answer must be cached");

    await muted(() => input({ source: "interactive", text: "Approved, go ahead with it" }, h.ctx(fast, sessionWithHistory())));
    assert.equal(h.calls.length, 2);
    const exchanges = previousExchanges(h.calls[1]);
    assert.ok(Array.isArray(exchanges) && exchanges.length === 1, JSON.stringify(h.calls[1].state));
    assert.equal(h.cached("Approved, go ahead with it"), false, "context-fed answer must not be cached");
  });

  it("bifrost/auto route: hands context to the direct classifier and does not cache the result", async () => {
    const h = harness(true);
    const request = (prompt: string) => ({
      reason: "user", thinkingLevel: "off", signal: undefined,
      messages: [{ role: "user", content: [text(prompt)], timestamp: 0 }],
    });

    const first = await muted(() => h.route(request("rename the helper function"), h.ctx(autoModel, SessionManager.inMemory(work))));
    assert.equal(first.model.id, "strong");
    assert.equal(previousExchanges(h.calls[0]), undefined);
    assert.ok(h.cached("rename the helper function"), "context-free answer must be cached");

    const second = await muted(() => h.route(request("Approved, go ahead with it"), h.ctx(autoModel, sessionWithHistory())));
    assert.equal(second.model.id, "strong");
    assert.equal(h.calls.length, 2);
    const exchanges = previousExchanges(h.calls[1]);
    assert.ok(Array.isArray(exchanges) && exchanges.length === 1, JSON.stringify(h.calls[1].state));
    assert.equal(h.cached("Approved, go ahead with it"), false, "context-fed answer must not be cached");
  });

  it("with the block disabled, neither call site sends context and both cache as today", async () => {
    const h = harness(false);
    const input = h.handlers.get("input");
    assert.ok(input);
    await muted(() => input({ source: "interactive", text: "Approved, go ahead with it" }, h.ctx(fast, sessionWithHistory())));
    await muted(() => h.route({
      reason: "user", thinkingLevel: "off", signal: undefined,
      messages: [{ role: "user", content: [text("Continue with the second step now")], timestamp: 0 }],
    }, h.ctx(autoModel, sessionWithHistory())));
    assert.equal(h.calls.length, 2);
    for (const call of h.calls) assert.deepEqual(Object.keys(call.state as object), ["prompt"]);
    assert.ok(h.cached("Approved, go ahead with it"));
    assert.ok(h.cached("Continue with the second step now"));
  });

  it("a project-level enabled: true sends no context and warns once at startup", async () => {
    const { result: h, errors } = await mutedErrors(() => harness(true, "project"));
    const warnings = errors.filter((line) => line.includes("classifier.context.enabled is ignored in project config"));
    assert.equal(warnings.length, 1, errors.join("\n"));
    assert.match(warnings[0], /^\[bifrost\/config\] warning: .*enable it in the global config \(.*bifrost\.json\)$/);
    const input = h.handlers.get("input");
    assert.ok(input);
    await muted(() => input({ source: "interactive", text: "Approved, go ahead with it" }, h.ctx(fast, sessionWithHistory())));
    assert.equal(h.calls.length, 1);
    assert.deepEqual(Object.keys(h.calls[0].state as object), ["prompt"]);
  });

  it("a global opt-in produces no startup warning", async () => {
    const { errors } = await mutedErrors(() => harness(true));
    assert.equal(errors.some((line) => line.includes("classifier.context.enabled")), false);
  });
});
