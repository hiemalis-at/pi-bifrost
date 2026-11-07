import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const root = new URL("../", import.meta.url);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, root), "utf8"));
}

describe("shipped JSON artifacts", () => {
  it("has a parseable configuration schema", () => {
    const schema = readJson("schema.json");
    assert.ok(schema !== null && typeof schema === "object");
    assert.ok(schema !== null && typeof schema === "object" && "$schema" in schema);
  });

  it("keeps checked-in examples parseable", () => {
    for (const path of [
      "bifrost.json",
      "examples/economical-frontier.json",
      "examples/economical-frontier-reliability.json",
      "examples/large-context.json",
    ]) {
      assert.doesNotThrow(() => readJson(path), path);
    }
  });
});

describe("classifier.context schema", () => {
  type SchemaNode = { additionalProperties?: boolean; properties?: Record<string, { type?: string; default?: unknown; minimum?: number; maximum?: number }> };
  const schema = readJson("schema.json") as { definitions: { ClassifierConfig: SchemaNode } };
  const context = schema.definitions.ClassifierConfig.properties?.context as SchemaNode | undefined;

  it("schema accepts the context block", () => {
    assert.ok(context, "ClassifierConfig.context is defined");
    const example = readJson("examples/classifier-conversation-aware.json") as { classifier: { context: Record<string, unknown> } };
    for (const key of Object.keys(example.classifier.context)) {
      assert.ok(context.properties?.[key], `example key ${key} is declared`);
    }
    assert.equal(context.properties?.enabled?.type, "boolean");
    assert.equal(context.properties?.enabled?.default, false);
    assert.equal(context.properties?.turns?.type, "integer");
    assert.equal(context.properties?.turns?.minimum, 1);
    assert.equal(context.properties?.turns?.maximum, 10);
    assert.equal(context.properties?.maxChars?.type, "integer");
    assert.equal(context.properties?.maxChars?.minimum, 500);
    assert.equal(context.properties?.maxChars?.maximum, 16000);
    assert.equal(context.properties?.includeToolSummary?.type, "boolean");
    assert.equal(context.properties?.includeTiers?.type, "boolean");
  });

  it("schema rejects unknown keys inside it", () => {
    assert.ok(context);
    assert.equal(context.additionalProperties, false);
    assert.deepEqual(Object.keys(context.properties ?? {}).sort(), ["enabled", "includeTiers", "includeToolSummary", "maxChars", "turns"]);
  });
});
