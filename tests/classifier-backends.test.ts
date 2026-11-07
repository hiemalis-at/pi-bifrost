import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLASSIFIER_BACKEND_IDS, isClassifierBackend, type ClassifierRequest, type ClassifierTransport, type TierCriterion } from "../classifier-backends.ts";
import { contextSummary } from "../classifier-semantics.ts";
import type { TypeSafeInput } from "../typesafe-classifier.ts";

describe("classifier port types", () => {
  it("keeps TypeSafeInput interchangeable with ClassifierRequest", () => {
    const criterion: TierCriterion = { what: "bounded edits", notFor: "design", examples: ["formatting"] };
    const request: ClassifierRequest = { prompt: "p", tiers: ["quick"], criteria: { quick: criterion } };
    const alias: TypeSafeInput = request;
    const roundTrip: ClassifierRequest = alias;
    assert.equal(roundTrip.prompt, "p");
    assert.equal(roundTrip.criteria.quick, criterion);
  });

  it("accepts every declared backend id and rejects garbage", () => {
    assert.deepEqual(Object.values(CLASSIFIER_BACKEND_IDS), ["prompt", "typesafe", "pi-native"]);
    assert.equal(isClassifierBackend(CLASSIFIER_BACKEND_IDS.piNative), true);
    assert.equal(isClassifierBackend("bogus"), false);
    assert.equal(isClassifierBackend(undefined), false);
  });

  it("accepts a string criterion and a transport-shaped function", async () => {
    const request: ClassifierRequest = { prompt: "p", tiers: ["quick", "general"], criteria: { quick: "string form" } };
    const transport: ClassifierTransport = async (input) =>
      input.tiers.length > 0 ? { tier: input.tiers[0], backend: "prompt" } : undefined;
    const judgment = await transport(request);
    assert.equal(judgment?.tier, "quick");
  });

  it("contextSummary reports counts and flags without exchange text", () => {
    const summary = contextSummary({
      exchanges: [{ user: "u", assistant: "a" }, { user: "u2", assistant: "a2" }],
      omittedEarlierTurns: true, chars: 12, redactions: 3, truncated: true,
    });
    assert.deepEqual(summary, { turns: 2, chars: 12, redacted: true, truncated: true });
    assert.deepEqual(
      contextSummary({ exchanges: [], omittedEarlierTurns: false, chars: 0, redactions: 0, truncated: false }),
      { turns: 0, chars: 0, redacted: false, truncated: false },
    );
  });
});
