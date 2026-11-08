import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSubagentEnv, isSubagentSession, recognizeSubagentSession } from "../subagent-session.ts";

describe("isSubagentEnv", () => {
  it("recognizes pi-subagents markers", () => {
    assert.equal(isSubagentEnv({ PI_SUBAGENT_EXTENSION_BINDINGS: "{}" }), true, "foreground child while it starts");
    assert.equal(isSubagentEnv({ PI_SUBAGENT_EXTENSION_BINDINGS: "" }), true, "an empty binding list still marks a child");
    assert.equal(isSubagentEnv({ PI_SUBAGENT_CHILD: "1" }), true, "background runner process");
    assert.equal(isSubagentEnv({ PI_SUBAGENT_RUN_ID: "run-1" }), true, "older hosts");
  });
  it("is false for a normal session", () => {
    assert.equal(isSubagentEnv({}), false);
    assert.equal(isSubagentEnv({ PI_SUBAGENT_CHILD: "0", PI_SUBAGENT_RUN_ID: "" }), false);
  });
});

describe("recognizeSubagentSession", () => {
  it("remembers a session marked at start, after the marker is gone", () => {
    const session = {};
    assert.equal(recognizeSubagentSession(session, { PI_SUBAGENT_EXTENSION_BINDINGS: "[]" }), true);
    assert.equal(recognizeSubagentSession(session, {}), true);
    assert.equal(isSubagentSession(session), true);
  });
  it("leaves other sessions alone", () => {
    const session = {};
    assert.equal(recognizeSubagentSession(session, {}), false);
    assert.equal(isSubagentSession(session), false);
    assert.equal(isSubagentSession(undefined), false);
  });
});
