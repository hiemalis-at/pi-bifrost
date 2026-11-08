import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_TURNS, type BifrostConfig } from "./config.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassifierBackend } from "./classifier-backends.ts";
import type { ClassificationResult, ClassifyOptions } from "./classification-pipeline.ts";
import { debug } from "./debug.ts";
import { isSubagentEnv } from "./subagent-session.ts";
import {
  buildConversationContext,
  tierForModel,
  type ConversationContext,
  type SessionEntryLike,
} from "./conversation-context.ts";

type MessageLike = NonNullable<SessionEntryLike["message"]>;

/** Structural subset of Pi's `ReadonlySessionManager`: the projection Pi builds for model context. */
export interface SessionProjectionSource {
  buildSessionProjection(): {
    readonly entries: readonly { readonly sourceEntry: { readonly type: string }; readonly messages: readonly unknown[] }[];
  };
}

function isMessageLike(value: unknown): value is MessageLike {
  return typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string";
}

/**
 * Session messages as the model sees them, in branch order. Pi's projection applies
 * `context_edit` entries (a null replacement omits the target, a value swaps its content) and
 * compaction, so text another extension scrubbed or omitted is never read here. Only
 * `message` entries contribute, as with the raw branch; custom messages, summaries and state
 * entries are skipped. A projection that throws, or a host that lacks `buildSessionProjection`
 * (an older Pi), yields no entries: no context is sent. Both leave a content-free debug record.
 */
export function modelVisibleEntries(session: SessionProjectionSource): SessionEntryLike[] {
  if (typeof session.buildSessionProjection !== "function") {
    debug("bifrost", "context.projection.error", { category: "unsupported" });
    return [];
  }
  let projection: ReturnType<SessionProjectionSource["buildSessionProjection"]>;
  try {
    projection = session.buildSessionProjection();
  } catch {
    debug("bifrost", "context.projection.error", { category: "throw" });
    return [];
  }
  const entries: SessionEntryLike[] = [];
  for (const projected of projection.entries) {
    if (projected.sourceEntry.type !== "message") continue;
    for (const message of projected.messages) {
      if (isMessageLike(message)) entries.push({ type: "message", message });
    }
  }
  return entries;
}

export interface ClassifyOptionsSource {
  readonly config: BifrostConfig;
  readonly backend: ClassifierBackend;
  /**
   * Model-visible session entries (`modelVisibleEntries(ctx.sessionManager)`). A function is
   * called only when context or advisory context is actually built.
   */
  readonly branch?: readonly SessionEntryLike[] | (() => readonly SessionEntryLike[]);
  /** Also build `advisoryContext` when the block is disabled. Only preview sets this: nothing else reads it. */
  readonly advisory?: boolean;
  /** The session is a subagent session (recognized at `session_start`); it never sends context. */
  readonly subagent?: boolean;
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
  const { config, backend, advisory } = source;
  if (source.subagent === true || isSubagentEnv(env) || !isDirectBackend(backend) || !source.branch) return {};
  const block = config.classifier?.context;
  const enabled = block?.enabled === true;
  if (!enabled && advisory !== true) return {};
  const branch = typeof source.branch === "function" ? source.branch() : source.branch;
  if (branch.length === 0) return {};
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
