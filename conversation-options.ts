import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_TURNS, type BifrostConfig } from "./config.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassifierBackend } from "./classifier-backends.ts";
import type { ClassificationResult, ClassifyOptions } from "./classification-pipeline.ts";
import {
  buildConversationContext,
  tierForModel,
  type ConversationContext,
  type SessionEntryLike,
} from "./conversation-context.ts";

export interface ClassifyOptionsSource {
  readonly config: BifrostConfig;
  readonly backend: ClassifierBackend;
  /** The current session branch (`ctx.sessionManager.getBranch()`). */
  readonly branch?: readonly SessionEntryLike[];
  /** Also build `advisoryContext` when the block is disabled. Only preview sets this: nothing else reads it. */
  readonly advisory?: boolean;
}

export interface BuiltClassifyOptions extends ClassifyOptions {
  /** Built but not sent: the context block is disabled. For size-only reporting. Strip before `classify`. */
  readonly advisoryContext?: ConversationContext;
}

function isDirectBackend(backend: ClassifierBackend): boolean {
  return backend === CLASSIFIER_BACKEND_IDS.typesafe || backend === CLASSIFIER_BACKEND_IDS.piNative;
}

/**
 * Classify options for one call. Context goes only to direct backends, only when
 * `classifier.context.enabled === true`, never in subagent runs, and only when a prior
 * exchange exists. With the block disabled the same context is built as `advisoryContext`, but
 * only when `source.advisory` is set (preview); otherwise nothing is built.
 */
export function buildClassifyOptions(
  source: ClassifyOptionsSource,
  env: Record<string, string | undefined> = process.env,
): BuiltClassifyOptions {
  const { config, backend, branch, advisory } = source;
  if (env.PI_SUBAGENT_RUN_ID || !isDirectBackend(backend) || !branch || branch.length === 0) return {};
  const block = config.classifier?.context;
  const enabled = block?.enabled === true;
  if (!enabled && advisory !== true) return {};
  const context = buildConversationContext(
    branch,
    {
      turns: block?.turns ?? DEFAULT_CONTEXT_TURNS,
      maxChars: block?.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS,
      includeToolSummary: block?.includeToolSummary !== false,
      includeTiers: block?.includeTiers !== false,
    },
    (provider, modelId) => tierForModel(config.models, provider, modelId),
  );
  if (!context) return {};
  return enabled ? { context } : { advisoryContext: context };
}

/**
 * Whether a result may be written to the fuzzy cache: classifier answers only, and never
 * when context was sent (the judgment carries `contextSent`, or the call reported context).
 */
export function shouldCacheResult(result: ClassificationResult): boolean {
  return result.kind === "classified"
    && result.source === "classifier"
    && result.judgment?.contextSent !== true
    && result.context === undefined;
}
