import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setupDebug } from "../debug.ts";
import { buildClassifyOptions, modelVisibleEntries } from "../conversation-options.ts";
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

  it("a branch function is called only when context or advisory context is built", () => {
    let calls = 0;
    const branch = () => { calls++; return twoTurns; };
    assert.deepEqual(buildClassifyOptions({ config: config(), backend: "pi-native", branch }, NO_ENV), {});
    assert.deepEqual(buildClassifyOptions({ config: config({ enabled: true }), backend: "prompt", branch }, NO_ENV), {});
    assert.deepEqual(buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch }, { PI_SUBAGENT_RUN_ID: "r" }), {});
    assert.equal(calls, 0);
    assert.equal(buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch }, NO_ENV).context?.exchanges.length, 2);
    assert.equal(calls, 1);
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

describe("modelVisibleEntries (Pi's projection: context edits, compaction)", () => {
  const text = (value: string) => ({ type: "text", text: value });
  const userMsg = (value: string) => ({ role: "user", content: [text(value)], timestamp: 0 });
  const assistantMsg = (content: unknown[], provider = "anthropic", model = "claude-opus") => ({
    role: "assistant", content, provider, model, api: "anthropic-messages", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const toolCall = (name: string, path: string) => ({ type: "toolCall", id: `call-${name}`, name, arguments: { path } });
  const toolResult = (value: string) => ({ role: "toolResult", toolCallId: "call-read", toolName: "read", content: [text(value)], isError: false, timestamp: 0 });

  function session(): SessionManager {
    return SessionManager.inMemory("/tmp/bifrost-context-test");
  }
  function contextOf(sm: SessionManager) {
    const built = buildClassifyOptions({ config: config({ enabled: true }), backend: "pi-native", branch: modelVisibleEntries(sm) }, NO_ENV);
    return built.context;
  }

  it("a context_edit replacement replaces user and assistant text; the originals never appear", () => {
    const sm = session();
    const userId = sm.appendMessage(userMsg("deploy with ORIGINAL_USER_TEXT_ALPHA") as never);
    const replyId = sm.appendMessage(assistantMsg([text("Deployed using ORIGINAL_REPLY_TEXT_BETA.")]) as never);
    sm.appendContextEdit(userId, { content: [text("deploy with SCRUBBED_USER")] as never });
    sm.appendContextEdit(replyId, { content: "Deployed using SCRUBBED_REPLY." });
    sm.appendMessage(userMsg("Approved") as never);

    const context = contextOf(sm);
    assert.ok(context);
    assert.equal(context.exchanges.length, 1);
    assert.equal(context.exchanges[0].user, "deploy with SCRUBBED_USER");
    assert.equal(context.exchanges[0].assistant, "Deployed using SCRUBBED_REPLY.");
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes("ORIGINAL_USER_TEXT_ALPHA"), false);
    assert.equal(serialized.includes("ORIGINAL_REPLY_TEXT_BETA"), false);
  });

  it("an omitted assistant message (replacement null) contributes neither text nor tool calls", () => {
    const sm = session();
    sm.appendMessage(userMsg("run the migration") as never);
    sm.appendMessage(assistantMsg([toolCall("read", "a.ts")]) as never);
    sm.appendMessage(toolResult("file body") as never);
    const omittedId = sm.appendMessage(assistantMsg([text("OMITTED_ATTEMPT_TEXT"), toolCall("edit", "b.ts"), toolCall("bash", "c")]) as never);
    sm.appendContextEdit(omittedId, null);
    sm.appendMessage(userMsg("next") as never);

    const context = contextOf(sm);
    assert.ok(context);
    assert.equal(context.exchanges.length, 1);
    assert.equal(context.exchanges[0].tools, "read x1");
    assert.equal(context.exchanges[0].assistant, "");
    assert.equal(JSON.stringify(context).includes("OMITTED_ATTEMPT_TEXT"), false);
  });

  it("an omitted user message removes its whole exchange", () => {
    const sm = session();
    const omittedUser = sm.appendMessage(userMsg("OMITTED_USER_PROMPT") as never);
    sm.appendMessage(assistantMsg([text("first reply")]) as never);
    sm.appendContextEdit(omittedUser, null);
    sm.appendMessage(userMsg("second prompt") as never);
    sm.appendMessage(assistantMsg([text("second reply")]) as never);

    const context = contextOf(sm);
    assert.ok(context);
    assert.deepEqual(context.exchanges.map((e) => e.user), ["second prompt"]);
    assert.equal(JSON.stringify(context).includes("OMITTED_USER_PROMPT"), false);
  });

  it("turns summarized away by compaction are not sent", () => {
    const sm = session();
    sm.appendMessage(userMsg("COMPACTED_OLD_PROMPT") as never);
    sm.appendMessage(assistantMsg([text("COMPACTED_OLD_REPLY")]) as never);
    const kept = sm.appendMessage(userMsg("kept prompt") as never);
    sm.appendMessage(assistantMsg([text("kept reply")]) as never);
    sm.appendCompaction("summary of earlier work", kept, 1000);
    sm.appendMessage(userMsg("after compaction") as never);
    sm.appendMessage(assistantMsg([text("after reply")]) as never);

    const context = contextOf(sm);
    assert.ok(context);
    assert.deepEqual(context.exchanges.map((e) => e.user), ["kept prompt", "after compaction"]);
    const serialized = JSON.stringify(context);
    assert.equal(serialized.includes("COMPACTED_OLD"), false);
    assert.equal(serialized.includes("summary of earlier work"), false);
  });

  it("bashExecution messages, custom messages and state entries neither crash nor leak", () => {
    const sm = session();
    sm.appendMessage(userMsg("check the build") as never);
    sm.appendMessage({ role: "bashExecution", command: "echo BASH_COMMAND_SENTINEL", output: "BASH_OUTPUT_SENTINEL", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 } as never);
    sm.appendCustomMessageEntry("other-extension", "CUSTOM_MESSAGE_SENTINEL", true);
    sm.appendCustomEntry("other-extension", { note: "CUSTOM_ENTRY_SENTINEL" });
    sm.appendModelChange("anthropic", "claude-opus");
    sm.appendThinkingLevelChange("high");
    sm.appendMessage(assistantMsg([text("Build is green.")]) as never);
    sm.appendMessage(userMsg("ship it") as never);

    const context = contextOf(sm);
    assert.ok(context);
    assert.equal(context.exchanges.length, 1);
    assert.equal(context.exchanges[0].user, "check the build");
    assert.equal(context.exchanges[0].assistant, "Build is green.");
    const serialized = JSON.stringify(context);
    for (const sentinel of ["BASH_COMMAND_SENTINEL", "BASH_OUTPUT_SENTINEL", "CUSTOM_MESSAGE_SENTINEL", "CUSTOM_ENTRY_SENTINEL"]) {
      assert.equal(serialized.includes(sentinel), false, `${sentinel} leaked`);
    }
  });

  it("a session manager whose projection throws yields no entries", () => {
    const broken = { buildSessionProjection: () => { throw new Error("boom"); } };
    assert.deepEqual(modelVisibleEntries(broken as never), []);
  });

  async function projectionRecords(run: () => void): Promise<{ records: Record<string, unknown>[]; raw: string }> {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-projection-debug-"));
    const path = join(dir, "debug.jsonl");
    setupDebug({ enabled: true, path }, dir);
    try {
      run();
      let raw = "";
      for (let i = 0; i < 100; i++) {
        raw = existsSync(path) ? readFileSync(path, "utf8") : "";
        if (raw.includes("context.projection.error")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const records = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      return { records: records.filter((entry) => entry.event === "context.projection.error"), raw };
    } finally {
      setupDebug({ enabled: false, path }, dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a throwing projection logs a content-free debug record with category throw", async () => {
    const broken = { buildSessionProjection: () => { throw new Error("SECRET_ERROR_TEXT"); } };
    const { records, raw } = await projectionRecords(() => assert.deepEqual(modelVisibleEntries(broken as never), []));
    assert.equal(records.length, 1, raw);
    assert.equal(records[0].module, "bifrost");
    assert.equal(records[0].category, "throw");
    assert.equal(raw.includes("SECRET_ERROR_TEXT"), false);
  });

  it("a host without buildSessionProjection yields no entries and logs category unsupported", async () => {
    const { records, raw } = await projectionRecords(() => assert.deepEqual(modelVisibleEntries({} as never), []));
    assert.equal(records.length, 1, raw);
    assert.equal(records[0].category, "unsupported");
  });
});
