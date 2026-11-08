import type { ClassifierModel } from "./classifier.ts";
import { classifyCompiled, compileRules, type RouteRule } from "./routing.ts";
import { debug, debugMeasure } from "./debug.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassificationJudgment, type ClassifierOutput, type ClassifierBackend } from "./classifier-backends.ts";
import { contextSummary } from "./classifier-semantics.ts";
import type { ConversationContext } from "./conversation-context.ts";

// ── ADT result type ────────────────────────────────────────────

export type ClassificationSource = "cache" | "classifier" | "regex" | "inline";

/** Present only when conversation context was handed to a direct classifier (not proof the provider received it). */
export interface ContextOutcome {
  readonly sent: true;
  /** True when the result is the direct judgment and it carried `contextSent`. */
  readonly used: boolean;
}

export type ClassificationResult =
  | { readonly kind: "classified"; readonly tier: string; readonly source: ClassificationSource; readonly judgment?: ClassificationJudgment; readonly context?: ContextOutcome }
  | { readonly kind: "fallback"; readonly tier: string; readonly context?: ContextOutcome }
  | { readonly kind: "unclassified" };

export interface ClassifyOptions {
  /** Bounded conversation context for the direct classifier. With one configured, it also skips the cache lookup. */
  readonly context?: ConversationContext;
}

// ── Pipeline dependencies ──────────────────────────────────────

/**
 * Dependencies injected into the pipeline. All are in-process.
 *
 * `cacheLookup` may internally mutate its backing store for LRU
 * tracking — this is an accepted impurity (see ADR candidate #4).
 */
export interface PipelineDeps {
  /** Query cache. Returns tier or undefined. */
  readonly cacheLookup: (text: string) => string | undefined;
  /** Optional direct backend (typesafe or pi-native) attempted before the prompt classifier. */
  readonly classifyDirect?: (
    text: string,
    tiers: readonly string[],
    signal?: AbortSignal,
    context?: ConversationContext,
  ) => Promise<ClassificationJudgment | undefined>;
  /** Classifier models in priority order. Empty array = skip LLM. */
  readonly classifierModels: readonly ClassifierModel[];
  /** Invoke the LLM classifier for a single model. Returns tier or undefined. */
  readonly classifyWithLLM: (
    model: ClassifierModel,
    text: string,
    tiers: readonly string[],
  ) => Promise<ClassifierOutput | undefined>;
  /** Regex routing rules. First match wins. */
  readonly regexRules: readonly RouteRule[];
  /** Default tier when nothing matches. */
  readonly defaultTier: string | undefined;
  /** Known tier names, from config.models keys. */
  readonly tiers: readonly string[];
}

// ── Pipeline interface ─────────────────────────────────────────

export interface ClassificationPipeline {
  readonly classify: (text: string, signal?: AbortSignal, options?: ClassifyOptions) => Promise<ClassificationResult>;
}

function normalizeJudgment(output: ClassifierOutput, backend: ClassifierBackend): ClassificationJudgment {
  return typeof output === "string"
    ? { tier: output, backend }
    : output;
}

// ── Factory ────────────────────────────────────────────────────

export function createPipeline(deps: PipelineDeps): ClassificationPipeline {
  const {
    cacheLookup,
    classifyDirect,
    classifierModels,
    classifyWithLLM,
    regexRules: rawRegexRules,
    defaultTier,
    tiers,
  } = deps;

  // Compile rules once at pipeline construction — no per-turn regex building.
  // Per-rule testing preserves rule-order match precedence exactly.
  const regexRules = compileRules(rawRegexRules);

  async function classify(text: string, signal?: AbortSignal, options?: ClassifyOptions): Promise<ClassificationResult> {
    // Context is only ever sent to a direct classifier; without one it is ignored entirely.
    const context = classifyDirect ? options?.context : undefined;
    // Stage 1: pre-check regex for direct model references only.
    // Runs before tiers check — direct bindings work even with zero tiers.
    {
      const endPre = debugMeasure("pipeline", "regex_pre");
      const pre = classifyCompiled(text, regexRules);
      endPre({ match: !!pre, tier: pre });
      if (pre && pre.includes("/") && !tiers.includes(pre)) {
        debug("pipeline", "result", { source: "regex", tier: pre, direct: true });
        return { kind: "classified", tier: pre, source: "regex" };
      }
    }

    if (tiers.length === 0) return { kind: "unclassified" };

    // Stage 2: cache lookup. Skipped when context will be sent: the cache key is the prompt alone.
    if (!context) {
      const endCache = debugMeasure("pipeline", "cache");
      const cached = cacheLookup(text);
      endCache({ hit: !!cached });
      if (cached && tiers.includes(cached)) {
        debug("pipeline", "result", { source: "cache", tier: cached });
        return { kind: "classified", tier: cached, source: "cache" };
      }
    }

    // Set once context has actually been handed to the direct classifier; later results report it.
    let contextOutcome: ContextOutcome | undefined;
    const withContext = (result: Exclude<ClassificationResult, { kind: "unclassified" }>): ClassificationResult => {
      if (!contextOutcome || !context) return result;
      // Counts and flags only: the context text never reaches a trace.
      debug("pipeline", "context", { sent: contextOutcome.sent, used: contextOutcome.used, ...contextSummary(context) });
      return { ...result, context: contextOutcome };
    };

    // Stage 3: optional direct classifier (typesafe or pi-native), then prompt fallback.
    if (classifyDirect) {
      try {
        const endDirect = debugMeasure("pipeline", "direct.attempt");
        if (context) contextOutcome = { sent: true, used: false };
        const judgment = context
          ? await classifyDirect(text, tiers, signal, context)
          : await classifyDirect(text, tiers, signal);
        const tier = judgment?.tier;
        endDirect({ tier, backend: judgment?.backend, confidence: judgment?.confidence, contextSent: judgment?.contextSent });
        if (judgment && tiers.includes(judgment.tier)) {
          debug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model, confidence: judgment.confidence });
          if (contextOutcome) contextOutcome = { sent: true, used: Boolean(judgment.contextSent) };
          return withContext({ kind: "classified", tier: judgment.tier, source: "classifier", judgment });
        }
      } catch {
        debug("pipeline", "direct.error", { aborted: signal?.aborted ?? false });
      }
      if (signal?.aborted) return { kind: "unclassified" };
    }

    // Existing prompt classifier — try each model in priority order.
    for (const model of classifierModels) {
      try {
        const endLLM = debugMeasure("pipeline", "classifier.attempt");
        const output = await classifyWithLLM(model, text, tiers);
        const modelId = model.kind === "registry" ? model.model.id : model.id;
        const judgment = output === undefined ? undefined : normalizeJudgment(output, CLASSIFIER_BACKEND_IDS.prompt);
        const tier = judgment?.tier;
        endLLM({ model: modelId, tier, backend: judgment?.backend, confidence: judgment?.confidence });
        if (judgment && tiers.includes(judgment.tier)) {
          debug("pipeline", "result", { source: "classifier", tier, backend: judgment.backend, model: judgment.model ?? modelId, confidence: judgment.confidence });
          return withContext({ kind: "classified", tier: judgment.tier, source: "classifier", judgment: { ...judgment, model: judgment.model ?? modelId } });
        }
      } catch {
        debug("pipeline", "classifier.error", { category: "classifier_failure" });
        console.error("[bifrost] classifier model failed");
      }
    }

    if (signal?.aborted) return { kind: "unclassified" };

    // Stage 4: regex rules
    const endRegex = debugMeasure("pipeline", "regex");
    const regex = classifyCompiled(text, regexRules);
    endRegex({ match: !!regex, tier: regex });
    if (regex) {
      if (tiers.includes(regex)) {
        // Tier name match — route through strategy.
        debug("pipeline", "result", { source: "regex", tier: regex });
        return withContext({ kind: "classified", tier: regex, source: "regex" });
      }
      if (regex.includes("/")) {
        // Direct model reference (e.g. "opencode-go/glm-5.1" in rule).
        debug("pipeline", "result", { source: "regex", tier: regex, direct: true });
        return withContext({ kind: "classified", tier: regex, source: "regex" });
      }
    }

    // Stage 4: default fallback
    debug("pipeline", "result", { source: "fallback", tier: defaultTier });
    if (defaultTier) {
      return withContext({ kind: "fallback", tier: defaultTier });
    }

    return { kind: "unclassified" };
  }

  return { classify };
}
