import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES, contextOptInIgnoredWarning, loadConfig, loadRules } from "../config.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("config load", () => {
  it("uses in-code defaults when config files missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.default, "general");
      assert.deepEqual(config.categoryStrategies, {
        quick: "random",
        general: "first",
        frontier: "first",
      });
      assert.deepEqual(config.models, {});
      assert.equal(config.rules, DEFAULT_RULES);
      assert.deepEqual(loadRules(cwd, config), DEFAULT_RULES);
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges extension, global, cwd, and project configs in order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(extensionDir, "bifrost.json"), {
        enabled: false,
        default: "quick",
        strategy: "cheapest",
        categoryStrategies: { quick: "cheapest" },
        models: {
          quick: ["ext-quick"],
          general: ["ext-general"],
        },
      });

      writeJson(join(getAgentDir(), "bifrost.json"), {
        default: "frontier",
        categoryStrategies: { general: "cheapest" },
        models: { general: ["global-general"] },
      });

      writeJson(join(cwd, "bifrost.json"), {
        enabled: true,
        strategy: "random",
        models: { frontier: ["cwd-frontier"] },
      });

      writeJson(join(cwd, ".pi", "bifrost.json"), {
        default: "frontier",
        models: { quick: ["project-quick"], general: ["project-general"] },
      });

      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.enabled, true);
      assert.equal(config.default, "frontier");
      assert.equal(config.strategy, "random");
      assert.deepEqual(config.categoryStrategies, {
        quick: "cheapest",
        general: "cheapest",
        frontier: "first",
      });
      assert.deepEqual(config.models, {
        quick: ["project-quick"],
        general: ["project-general"],
        frontier: ["cwd-frontier"],
      });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("deep-merges tier criteria and lets null remove inherited criteria", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(extensionDir, "bifrost.json"), { classifier: { criteria: {
        quick: { what: "bounded", examples: ["format"] },
        frontier: "complex",
      } } });
      writeJson(join(getAgentDir(), "bifrost.json"), { classifier: { criteria: { general: "normal" } } });
      writeJson(join(cwd, "bifrost.json"), { classifier: { criteria: {
        quick: { notFor: "architecture" },
        frontier: null,
      } } });
      assert.deepEqual(loadConfig(cwd, extensionDir).classifier?.criteria, {
        quick: { what: "bounded", examples: ["format"], notFor: "architecture" },
        general: "normal",
      });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("activates TypeSafe from explicit project backend selection", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeJson(join(cwd, "bifrost.json"), { classifier: { backend: "typesafe" } });
      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.classifier?.backend, "typesafe");
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("ignores corrupt config layers and keeps later valid layers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
    const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
    const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
    const agentDir = join(home, "agent");
    const oldHome = process.env.HOME;
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      writeFileSync(join(extensionDir, "bifrost.json"), "{not json", "utf8");
      writeJson(join(cwd, "bifrost.json"), {
        default: "quick",
        models: { quick: ["cwd-quick"] },
      });

      const config = loadConfig(cwd, extensionDir);
      assert.equal(config.default, "quick");
      assert.deepEqual(config.models, { quick: ["cwd-quick"] });
    } finally {
      process.env.HOME = oldHome;
      process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(extensionDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  describe("classifier.context.enabled opt-in (global config only)", () => {
    type Layers = { extension?: unknown; global?: unknown; cwd?: unknown; project?: unknown };

    function withLayers(layers: Layers, run: (cwd: string, extensionDir: string, globalPath: string) => void): void {
      const cwd = mkdtempSync(join(tmpdir(), "bifrost-config-"));
      const extensionDir = mkdtempSync(join(tmpdir(), "bifrost-extension-"));
      const home = mkdtempSync(join(tmpdir(), "bifrost-home-"));
      const agentDir = join(home, "agent");
      const oldHome = process.env.HOME;
      const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        if (layers.extension) writeJson(join(extensionDir, "bifrost.json"), layers.extension);
        if (layers.global) writeJson(join(agentDir, "bifrost.json"), layers.global);
        if (layers.cwd) writeJson(join(cwd, "bifrost.json"), layers.cwd);
        if (layers.project) writeJson(join(cwd, ".pi", "bifrost.json"), layers.project);
        run(cwd, extensionDir, join(getAgentDir(), "bifrost.json"));
      } finally {
        if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
        if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
        rmSync(cwd, { recursive: true, force: true });
        rmSync(extensionDir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
    const ctx = (context: Record<string, unknown>) => ({ classifier: { backend: "pi-native", context } });

    it("is enabled when the global config enables it", () => {
      withLayers({ global: ctx({ enabled: true }) }, (cwd, extensionDir) => {
        assert.equal(loadConfig(cwd, extensionDir).classifier?.context?.enabled, true);
        assert.equal(contextOptInIgnoredWarning(cwd, extensionDir), undefined);
      });
    });

    it("is not enabled by a project layer alone, and the helper reports the ignored opt-in", () => {
      for (const layer of ["cwd", "project"] as const) {
        withLayers({ [layer]: ctx({ enabled: true, turns: 2 }) }, (cwd, extensionDir, globalPath) => {
          const context = loadConfig(cwd, extensionDir).classifier?.context;
          assert.notEqual(context?.enabled, true);
          assert.equal(context?.turns, 2);
          assert.equal(
            contextOptInIgnoredWarning(cwd, extensionDir),
            `classifier.context.enabled is ignored in project config; enable it in the global config (${globalPath})`,
          );
        });
      }
    });

    it("is not enabled by the extension-defaults layer alone", () => {
      withLayers({ extension: ctx({ enabled: true }) }, (cwd, extensionDir) => {
        assert.notEqual(loadConfig(cwd, extensionDir).classifier?.context?.enabled, true);
        assert.ok(contextOptInIgnoredWarning(cwd, extensionDir));
      });
    });

    it("lets a project layer switch it off over a global true", () => {
      for (const layer of ["cwd", "project"] as const) {
        withLayers({ global: ctx({ enabled: true }), [layer]: ctx({ enabled: false }) }, (cwd, extensionDir) => {
          assert.equal(loadConfig(cwd, extensionDir).classifier?.context?.enabled, false);
          assert.equal(contextOptInIgnoredWarning(cwd, extensionDir), undefined);
        });
      }
    });

    it("keeps a global true with a project layer that only tunes other keys", () => {
      withLayers({ global: ctx({ enabled: true, maxChars: 4000 }), project: ctx({ maxChars: 2000, turns: 5 }) }, (cwd, extensionDir) => {
        const context = loadConfig(cwd, extensionDir).classifier?.context;
        assert.equal(context?.enabled, true);
        assert.equal(context?.maxChars, 2000);
        assert.equal(context?.turns, 5);
      });
    });

    it("keeps a global true when a project layer also says true (nothing to warn about)", () => {
      withLayers({ global: ctx({ enabled: true }), cwd: ctx({ enabled: true }) }, (cwd, extensionDir) => {
        assert.equal(loadConfig(cwd, extensionDir).classifier?.context?.enabled, true);
        assert.equal(contextOptInIgnoredWarning(cwd, extensionDir), undefined);
      });
    });

    it("is not enabled when absent everywhere", () => {
      withLayers({}, (cwd, extensionDir) => {
        assert.notEqual(loadConfig(cwd, extensionDir).classifier?.context?.enabled, true);
        assert.equal(contextOptInIgnoredWarning(cwd, extensionDir), undefined);
      });
    });
  });
});
