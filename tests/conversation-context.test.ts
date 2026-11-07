import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PER_ASSISTANT_CAP,
  PER_USER_CAP,
  buildConversationContext,
  redactSecrets,
  stubCodeFences,
  summarizeToolCalls,
  tierForModel,
  type ContextOptions,
  type SessionEntryLike,
} from "../conversation-context.ts";

const OPTS: ContextOptions = { turns: 3, maxChars: 6000, includeToolSummary: true, includeTiers: true };
const noTier = () => undefined;

const user = (content: unknown): SessionEntryLike => ({ type: "message", message: { role: "user", content } });
const assistant = (
  content: unknown,
  provider = "anthropic",
  model = "claude-sonnet",
): SessionEntryLike => ({ type: "message", message: { role: "assistant", content, provider, model } });
const toolResult = (content: unknown): SessionEntryLike => ({ type: "message", message: { role: "toolResult", content } });
const text = (t: string) => ({ type: "text", text: t });

describe("redactSecrets", () => {
  const cases: Array<[string, string, string]> = [
    ["sk- key", "use sk-abcdef1234567890abcd here", "sk-abcdef"],
    ["sk-or- key", "key sk-or-v1-abcdef1234567890abcd end", "sk-or-v1"],
    ["ghp_ key", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end", "ghp_abcdef"],
    ["AKIA key", "aws AKIAIOSFODNN7EXAMPLE end", "AKIAIOSFODNN7EXAMPLE"],
    ["bearer header", "Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    [
      "private key block",
      "k\n-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBg\nabc\n-----END RSA PRIVATE KEY-----\nafter",
      "MIIEvQIBADANBg",
    ],
    ["API_KEY assignment", "set API_KEY=abc123 now", "abc123"],
    ["password assignment", "password: hunter2", "hunter2"],
    ["quoted JSON password", '{"password": "hunter2"}', "hunter2"],
    ["quoted JSON api_key", '{"api_key":"abc123def"}', "abc123def"],
    ["single-quoted YAML secret", "client_secret: 'abc123def'", "abc123def"],
    ["double-quoted value with spaces", 'API_KEY="abc def ghi" rest', "def ghi"],
    ["single-quoted value with spaces", "password='abc def ghi' rest", "def ghi"],
    ["github_pat token", "use github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123 now", "github_pat_11"],
    ["gho_ token", "gho_abcdefghijklmnopqrstuvwxyz0123456789", "gho_abcdef"],
    ["ghs_ token", "ghs_abcdefghijklmnopqrstuvwxyz0123456789", "ghs_abcdef"],
    ["ghu_ token", "ghu_abcdefghijklmnopqrstuvwxyz0123456789", "ghu_abcdef"],
    ["ASIA temporary key", "aws ASIAIOSFODNN7EXAMPLE end", "ASIAIOSFODNN7EXAMPLE"],
    ["bare Bearer token", "curl -H 'x' Bearer eyJhbGciOi.abc123.def456 end", "eyJhbGciOi"],
    ["Authorization Basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNz"],
    ["--password flag", "mysql --password hunter2 -u root", "hunter2"],
    ["--password= flag", "mysql --password=hunter2 -u root", "hunter2"],
    ["--token flag", "cli --token abc123xyz run", "abc123xyz"],
    ["--api-key quoted flag", 'cli --api-key "abc def" run', "abc def"],
    ["URL credentials", "clone https://user:s3cr3tpw@github.com/org/repo.git", "s3cr3tpw"],
    ["high-entropy token", "tok aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hI7jK9 end", "aB3dE5gH7jK9"],
  ];
  for (const [name, input, secret] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactSecrets(input);
      assert.ok(out.text.includes("[redacted]"), out.text);
      assert.ok(!out.text.includes(secret), out.text);
      assert.equal(out.count, 1);
    });
  }

  it("keeps the rest of a URL after redacting its password", () => {
    assert.equal(
      redactSecrets("https://user:s3cr3tpw@github.com/org/repo.git").text,
      "https://user:[redacted]@github.com/org/repo.git",
    );
  });

  it("redacts quoted JSON without leaving fragments", () => {
    assert.equal(redactSecrets('{"password": "hunter2", "ok": 1}').text, "{[redacted], \"ok\": 1}");
  });

  it("keeps surrounding text", () => {
    assert.equal(redactSecrets("a password: hunter2\nnext line").text, "a [redacted]\nnext line");
  });

  for (const near of [
    "the sk-ip flag",
    "password policy",
    "API_KEY is documented",
    "the quick brown fox jumps over lazy dogs",
    "set --token-limit 5 and --password-file x",
    "see http://localhost:3000/path and https://github.com/org/repo",
    "use Bearer authentication here",
    "max_tokens: 100",
  ]) {
    it(`leaves near miss untouched: ${near}`, () => {
      assert.deepEqual(redactSecrets(near), { text: near, count: 0 });
    });
  }

  it("counts several redactions", () => {
    assert.equal(redactSecrets("password: a\nAPI_KEY=b\nsk-abcdef1234567890").count, 3);
  });
});

describe("stubCodeFences", () => {
  it("stubs a fence with its language and line count, keeping prose", () => {
    const body = Array.from({ length: 42 }, (_, i) => `line ${i}`).join("\n");
    const out = stubCodeFences(`before\n\`\`\`ts\n${body}\n\`\`\`\nafter`);
    assert.equal(out, "before\n[code: ts, 42 lines]\nafter");
  });

  it("uses text when no language", () => {
    assert.equal(stubCodeFences("```\na\nb\n```"), "[code: text, 2 lines]");
  });

  it("stubs an unclosed fence to the end of the text", () => {
    assert.equal(stubCodeFences("intro\n```py\na\nb\nc"), "intro\n[code: py, 3 lines]");
  });

  it("leaves text without fences unchanged", () => {
    assert.equal(stubCodeFences("plain `inline` text"), "plain `inline` text");
  });
});

describe("summarizeToolCalls", () => {
  it("counts in first-seen order", () => {
    assert.equal(summarizeToolCalls(["edit", "bash", "edit"]), "edit x2, bash x1");
  });
  it("is empty for no calls", () => {
    assert.equal(summarizeToolCalls([]), "");
  });
});

describe("tierForModel", () => {
  const models = {
    frontier: ["anthropic/claude-opus", "gpt-5"],
    general: "claude-sonnet",
    quick: ["haiku", "claude-sonnet-fast"],
  };
  it("returns the tier for a unique match", () => {
    assert.equal(tierForModel(models, "openai", "gpt-5-codex"), "frontier");
    assert.equal(tierForModel(models, "anthropic", "claude-opus"), "frontier");
    assert.equal(tierForModel(models, "anthropic", "claude-haiku-4"), "quick");
  });
  it("is undefined when the model is in two tiers", () => {
    assert.equal(tierForModel(models, "anthropic", "claude-sonnet-fast"), undefined);
  });
  it("is undefined when unknown or models absent", () => {
    assert.equal(tierForModel(models, "x", "mystery"), undefined);
    assert.equal(tierForModel(undefined, "x", "gpt-5"), undefined);
  });
  it("matches provider/id patterns exactly", () => {
    assert.equal(tierForModel(models, "other", "claude-opus"), undefined);
  });
});

describe("buildConversationContext", () => {
  it("returns two exchanges oldest first", () => {
    const ctx = buildConversationContext(
      [user("q1"), assistant([text("a1")]), user("q2"), assistant([text("a2")]), user("current")],
      OPTS,
      noTier,
    );
    assert.deepEqual(ctx?.exchanges.map((e) => [e.user, e.assistant]), [["q1", "a1"], ["q2", "a2"]]);
    assert.equal(ctx?.omittedEarlierTurns, false);
    assert.equal(ctx?.truncated, false);
    assert.equal(ctx?.chars, 8);
  });

  it("turns: 1 keeps the newest and flags omission", () => {
    const ctx = buildConversationContext(
      [user("q1"), assistant([text("a1")]), user("q2"), assistant([text("a2")])],
      { ...OPTS, turns: 1 },
      noTier,
    );
    assert.deepEqual(ctx?.exchanges.map((e) => e.user), ["q2"]);
    assert.equal(ctx?.omittedEarlierTurns, true);
  });

  it("drops an unanswered trailing user message", () => {
    const ctx = buildConversationContext([user("q1"), assistant([text("a1")]), user("current")], OPTS, noTier);
    assert.deepEqual(ctx?.exchanges.map((e) => e.user), ["q1"]);
  });

  it("is undefined with no completed exchange", () => {
    assert.equal(buildConversationContext([], OPTS, noTier), undefined);
    assert.equal(buildConversationContext([user("only")], OPTS, noTier), undefined);
    assert.equal(buildConversationContext([assistant([text("orphan")])], OPTS, noTier), undefined);
  });

  it("skips non-message entries and tool results without leaking content", () => {
    const entries: SessionEntryLike[] = [
      { type: "compaction" },
      { type: "branch_summary" },
      { type: "custom" },
      { type: "custom_message" },
      { type: "thinking_level_change" },
      user([text("hello"), { type: "image", data: "IMGDATA" }]),
      assistant([
        { type: "thinking", thinking: "SECRETTHOUGHT" },
        { type: "toolCall", name: "read", arguments: { path: "ARGPATH" } },
      ]),
      toolResult([text("FILECONTENTS")]),
      assistant([text("done"), { type: "toolCall", name: "edit", arguments: { x: "ARGX" } }]),
    ];
    const ctx = buildConversationContext(entries, OPTS, noTier);
    assert.equal(ctx?.exchanges.length, 1);
    assert.equal(ctx?.exchanges[0].user, "hello");
    assert.equal(ctx?.exchanges[0].assistant, "done");
    assert.equal(ctx?.exchanges[0].tools, "read x1, edit x1");
    const dump = JSON.stringify(ctx);
    for (const leak of ["IMGDATA", "SECRETTHOUGHT", "ARGPATH", "FILECONTENTS", "ARGX"]) {
      assert.ok(!dump.includes(leak), leak);
    }
  });

  it("takes text from the last assistant message that has text", () => {
    const ctx = buildConversationContext(
      [
        user("q"),
        assistant([text("first")]),
        assistant([text("second"), text(" part")]),
        assistant([{ type: "toolCall", name: "bash" }]),
      ],
      OPTS,
      noTier,
    );
    assert.equal(ctx?.exchanges[0].assistant, "second part");
    assert.equal(ctx?.exchanges[0].tools, "bash x1");
  });

  it("resolves tier from the chosen assistant message", () => {
    const seen: string[] = [];
    const tierOf = (p: string, m: string) => {
      seen.push(`${p}/${m}`);
      return m === "m-two" ? "quick" : undefined;
    };
    const entries = [
      user("q"),
      assistant([text("one")], "p", "m-one"),
      assistant([text("two")], "p", "m-two"),
      assistant([{ type: "toolCall", name: "bash" }], "p", "m-three"),
    ];
    const on = buildConversationContext(entries, OPTS, tierOf);
    assert.equal(on?.exchanges[0].tier, "quick");
    assert.deepEqual(seen, ["p/m-two"]);
    const off = buildConversationContext(entries, { ...OPTS, includeTiers: false }, tierOf);
    assert.equal(off?.exchanges[0].tier, undefined);
    const unknown = buildConversationContext(entries.slice(0, 2), OPTS, tierOf);
    assert.equal(unknown?.exchanges[0].tier, undefined);
  });

  it("omits tools when the option is off or no tool was called", () => {
    const entries = [user("q"), assistant([text("a"), { type: "toolCall", name: "bash" }])];
    assert.equal(buildConversationContext(entries, { ...OPTS, includeToolSummary: false }, noTier)?.exchanges[0].tools, undefined);
    assert.equal(buildConversationContext([user("q"), assistant([text("a")])], OPTS, noTier)?.exchanges[0].tools, undefined);
  });

  it("applies per-text caps and marks truncated", () => {
    const ctx = buildConversationContext(
      [user("u".repeat(PER_USER_CAP + 500)), assistant([text("a".repeat(PER_ASSISTANT_CAP + 500))])],
      { ...OPTS, maxChars: 16000 },
      noTier,
    );
    assert.ok(ctx);
    assert.ok(ctx.exchanges[0].user.length <= PER_USER_CAP);
    assert.ok(ctx.exchanges[0].assistant.length <= PER_ASSISTANT_CAP);
    assert.equal(ctx.truncated, true);
  });

  it("keeps newest exchanges within maxChars and drops older whole exchanges", () => {
    const entries = [
      user("old".repeat(100)),
      assistant([text("old".repeat(100))]),
      user("new-q"),
      assistant([text("new-a")]),
    ];
    const ctx = buildConversationContext(entries, { ...OPTS, maxChars: 500 }, noTier);
    assert.deepEqual(ctx?.exchanges.map((e) => e.user), ["new-q"]);
    assert.equal(ctx?.omittedEarlierTurns, true);
    assert.equal(ctx?.truncated, true);
    assert.ok((ctx?.chars ?? 0) <= 500);
  });

  it("shrinks the newest exchange when it alone exceeds the budget", () => {
    const ctx = buildConversationContext(
      [user("u".repeat(900)), assistant([text("a".repeat(1900))])],
      { ...OPTS, maxChars: 500 },
      noTier,
    );
    assert.ok(ctx);
    assert.equal(ctx.truncated, true);
    assert.ok(ctx.chars <= 500);
    assert.ok(ctx.exchanges[0].user.length > 0 && ctx.exchanges[0].assistant.length > 0);
  });

  it("stubs code fences and redacts both earlier user text and assistant text", () => {
    const ctx = buildConversationContext(
      [
        user("my password: hunter2 please"),
        assistant([text("run\n```sh\nls\npwd\n```\nwith API_KEY=zzz999")]),
      ],
      OPTS,
      noTier,
    );
    assert.equal(ctx?.exchanges[0].user, "my [redacted] please");
    assert.equal(ctx?.exchanges[0].assistant, "run\n[code: sh, 2 lines]\nwith [redacted]");
    assert.equal(ctx?.redactions, 2);
  });

  it("accepts string and block user content", () => {
    const ctx = buildConversationContext(
      [user([text("a"), text("b")]), assistant([text("x")])],
      OPTS,
      noTier,
    );
    assert.equal(ctx?.exchanges[0].user, "a\nb");
  });
});
