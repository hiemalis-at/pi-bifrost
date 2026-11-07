import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClassifyOptions } from "../conversation-options.ts";
import type { BifrostConfig, ContextConfig } from "../config.ts";
import type { SessionEntryLike } from "../conversation-context.ts";

const user = (text: string): SessionEntryLike => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string, provider = "anthropic", model = "claude-opus"): SessionEntryLike => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], provider, model },
});

const models = { planner: "anthropic/claude-opus", worker: "openai/gpt-mini" };
const twoTurns: readonly SessionEntryLike[] = [
  user("plan the migration"),
  assistant("Plan: step 1, step 2."),
  user("refine step 2"),
  assistant("Step 2 refined.", "openai", "gpt-mini"),
  user("Approved"),
];
const NO_ENV: Record<string, string | undefined> = {};

function config(context?: ContextConfig): BifrostConfig {
  return { models, classifier: { backend: "pi-native", ...(context ? { context } : {}) } };
}

describe("buildClassifyOptions", () => {
  it("block absent or disabled sets no context and, without advisory, no advisoryContext", () => {
    for (const cfg of [config(), config({ enabled: false }), config({ turns: 2 })]) {
      const built = buildClassifyOptions({ config: cfg, backend: "pi-native", branch: twoTurns }, NO_ENV);
      assert.deepEqual(built, {});
    }
  });

  it("block absent or disabled sets advisoryContext only with advisory: true", () => {
    for (const cfg of [config(), config({ enabled: false }), config({ turns: 2 })]) {
      const built = buildClassifyOptions({ config: cfg, backend: "pi-native", branch: twoTurns, advisory: true }, NO_ENV);
      assert.equal(built.context, undefined);
      assert.ok(built.advisoryContext);
      assert.ok(built.advisoryContext.exchanges.length > 0);
    }
  });

  it("advisory with no prior exchange, a prompt backend, or a subagent run sets nothing", () => {
    const single = buildClassifyOptions({ config: config(), backend: "pi-native", branch: [user("first prompt")], advisory: true }, NO_ENV);
    assert.deepEqual(single, {});
    const prompt = buildClassifyOptions({ config: config(), backend: "prompt", branch: twoTurns, advisory: true }, NO_ENV);
    assert.deepEqual(prompt, {});
    const subagent = buildClassifyOptions({ config: config(), backend: "pi-native", branch: twoTurns, advisory: true }, { PI_SUBAGENT_RUN_ID: "r" });
    assert.deepEqual(subagent, {});
  });

  it("advisory with the block enabled still builds context, not advisoryContext", () => {
    const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch: twoTurns, advisory: true }, NO_ENV);
    assert.ok(built.context);
    assert.equal(built.advisoryContext, undefined);
  });

  it("block disabled with no prior exchange sets neither", () => {
    const built = buildClassifyOptions({ config: config(), backend: "pi-native", branch: [user("first prompt")], advisory: true }, NO_ENV);
    assert.deepEqual(built, {});
  });

  it("enabled with backend pi-native and a two-turn branch sets context with 2 exchanges", () => {
    const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch: twoTurns }, NO_ENV);
    assert.ok(built.context);
    assert.equal(built.context.exchanges.length, 2);
    assert.equal(built.context.exchanges[0].user, "plan the migration");
    assert.equal(built.context.exchanges[1].assistant, "Step 2 refined.");
    assert.equal(built.advisoryContext, undefined);
  });

  it("enabled with backend typesafe sets context", () => {
    const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "typesafe", branch: twoTurns }, NO_ENV);
    assert.ok(built.context);
    assert.equal(built.context.exchanges.length, 2);
  });

  it("enabled with backend prompt sets none", () => {
    const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "prompt", branch: twoTurns }, NO_ENV);
    assert.deepEqual(built, {});
  });

  it("no prior exchange sets none", () => {
    for (const branch of [[], [user("first prompt")], undefined]) {
      const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch }, NO_ENV);
      assert.deepEqual(built, {});
    }
  });

  it("PI_SUBAGENT_RUN_ID set sets none", () => {
    const env = { PI_SUBAGENT_RUN_ID: "run-1" };
    assert.deepEqual(buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch: twoTurns }, env), {});
    assert.deepEqual(buildClassifyOptions({ config: config(), backend: "pi-native", branch: twoTurns }, env), {});
  });

  it("tiers come from the configured pools", () => {
    const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch: twoTurns }, NO_ENV);
    assert.equal(built.context?.exchanges[0].tier, "planner");
    assert.equal(built.context?.exchanges[1].tier, "worker");
  });

  it("configured turns and includeTiers are honored", () => {
    const built = buildClassifyOptions({
      config: config({ enabled: true, turns: 1, includeTiers: false }),
      backend: "pi-native",
      branch: twoTurns,
    }, NO_ENV);
    assert.equal(built.context?.exchanges.length, 1);
    assert.equal(built.context?.exchanges[0].tier, undefined);
    assert.equal(built.context?.omittedEarlierTurns, true);
  });
});
