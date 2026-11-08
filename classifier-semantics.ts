import { createHash } from "node:crypto";
import type { BifrostConfig } from "./config.ts";
import { CLASSIFIER_BACKEND_IDS, TYPE_SAFE_MODEL, type ClassifierBackend, type ClassifierRequest, type TierCriterion } from "./classifier-backends.ts";
import type { ConversationContext } from "./conversation-context.ts";

const CLASSIFIER_INSTRUCTION_VERSION = 1;

/** Bound what classifiers see (matches Pi's jev-router example: slice(0, 16_000)). */
export const CLASSIFIER_PROMPT_MAX_CHARS = 16_000;

export function boundedClassifierPrompt(text: string, maxChars = CLASSIFIER_PROMPT_MAX_CHARS): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/** Flatten one criterion into the plain text a choice question carries. */
export function criterionText(value: TierCriterion): string {
  if (typeof value === "string") return value;
  return [value.what, value.notFor ? `Not for: ${value.notFor}` : "", value.examples?.length ? `Examples: ${value.examples.join(", ")}` : ""]
    .filter(Boolean).join(" ");
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

// Instruction text is policy owned by #180's compiler; keep it a single constant so #180 can take it over.
export const CONTEXT_INSTRUCTIONS =
  "Classify the work the assistant will perform as a result of `current_prompt`, not the length of `current_prompt`. "
  + "When `current_prompt` is a short reply (an approval, 'continue', a chosen option), the work is whatever the last item in `previous_exchanges` proposed or asked to do. "
  + "`previous_exchanges` is earlier conversation, oldest first; each item may list the tier it ran on and the tools it used, which are information only. "
  + "If `omitted_earlier_turns` is true, earlier turns exist that are not shown. "
  + "Judge task complexity and consequence, not stated preference or price.";

/** Narrow a request to one that carries conversation context. */
export function hasContext(request: ClassifierRequest): request is ClassifierRequest & { readonly context: ConversationContext } {
  return request.context !== undefined;
}

/** Object `state` for a context-bearing request. Sends nothing beyond these keys. */
export function contextState(request: ClassifierRequest & { readonly context: ConversationContext }): JsonObject {
  return {
    current_prompt: request.prompt,
    previous_exchanges: request.context.exchanges.map((exchange) => {
      const item: { user: string; assistant: string; tier?: string; tools?: string } = { user: exchange.user, assistant: exchange.assistant };
      if (exchange.tier !== undefined) item.tier = exchange.tier;
      if (exchange.tools !== undefined) item.tools = exchange.tools;
      return item;
    }),
    omitted_earlier_turns: request.context.omittedEarlierTurns,
  };
}

/** Content-free description of a context, safe for traces. */
export function contextSummary(context: ConversationContext): { readonly turns: number; readonly chars: number; readonly redacted: boolean; readonly truncated: boolean } {
  return { turns: context.exchanges.length, chars: context.chars, redacted: context.redactions > 0, truncated: context.truncated };
}

/** Content-free trace fields for a context request: counts and flags only, never text. Empty without context. */
export function contextTraceFields(context: ConversationContext | undefined): Record<string, unknown> {
  if (!context) return {};
  const summary = contextSummary(context);
  return { context_turns: summary.turns, context_chars: summary.chars, context_redacted: summary.redacted, context_truncated: summary.truncated };
}

/** Shared direct-transport helpers (typesafe, pi-native). */
export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function abortableDelay(
  ms: number,
  delay: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = (continued: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(continued);
    };
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    delay(ms).then(() => finish(true), (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export interface DirectStagePlan {
  readonly useDirect: boolean;
  readonly usePromptFallback: boolean;
  readonly directDegraded: boolean;
}

/**
 * Stage wiring for the direct transports. An auto-detected direct backend
 * degrades to prompt classification when its config is invalid (preserving
 * pre-detection behavior); an explicit backend fails closed with the config
 * errors printed at startup.
 */
export function directStagePlan(input: {
  readonly backend: ClassifierBackend;
  readonly auto: boolean;
  readonly classifierEnabled: boolean;
  readonly tierCount: number;
  readonly directConfigOk: boolean;
  readonly fallback: "prompt" | "regex" | undefined;
}): DirectStagePlan {
  const isDirect = input.backend === CLASSIFIER_BACKEND_IDS.typesafe
    || input.backend === CLASSIFIER_BACKEND_IDS.piNative;
  const stagesEnabled = input.classifierEnabled && input.tierCount > 0;
  const useDirect = stagesEnabled && isDirect && input.directConfigOk;
  const directDegraded = isDirect && input.auto && !input.directConfigOk;
  const usePromptFallback = stagesEnabled
    && (input.backend === CLASSIFIER_BACKEND_IDS.prompt
      || (isDirect && input.fallback !== "regex" && (input.directConfigOk || input.auto)));
  return { useDirect, usePromptFallback, directDegraded };
}

/** A floating Pi catalog model has no stable fingerprint before lookup. Do not read or write fuzzy decisions for it. */
export function classifierCacheEnabled(config: BifrostConfig, effectiveBackend: ClassifierBackend): boolean {
  return (config.cache?.enabled ?? true)
    && !(effectiveBackend === CLASSIFIER_BACKEND_IDS.piNative && !config.classifier?.piNative?.model);
}

export interface ClassifierRuntimeSemantics {
  readonly typesafeCredentialAvailable?: boolean;
  /** Detection-resolved backend. A cached decision must never be tagged with a backend that did not produce it (fix 1). */
  readonly effectiveBackend?: ClassifierBackend;
  /** Optional resolved id for callers with one. Normal routing keys on configured id before discovery. */
  readonly piNativeModel?: string;
}

export function classifierCacheKey(
  config: BifrostConfig,
  tiers: readonly string[],
  runtime: ClassifierRuntimeSemantics = {},
): string {
  const classifier = config.classifier;
  const semantics = JSON.stringify(stableValue({
    instructionVersion: CLASSIFIER_INSTRUCTION_VERSION,
    backend: runtime.effectiveBackend ?? classifier?.backend ?? CLASSIFIER_BACKEND_IDS.prompt,
    model: classifier?.model,
    piNativeModel: runtime.piNativeModel ?? classifier?.piNative?.model,
    endpoint: classifier?.endpoint,
    method: classifier?.method,
    systemPrompt: classifier?.systemPrompt,
    maxTokens: classifier?.maxTokens,
    temperature: classifier?.temperature,
    fallbackToRegex: classifier?.fallbackToRegex,
    typesafeModel: classifier?.typesafe?.model ?? TYPE_SAFE_MODEL,
    criteria: classifier?.criteria,
    minConfidence: classifier?.minConfidence ?? 0.8,
    fallback: classifier?.fallback,
    typesafeCredentialAvailable: runtime.typesafeCredentialAvailable ?? false,
    tiers,
  }));
  return createHash("sha256").update(semantics).digest("hex");
}
