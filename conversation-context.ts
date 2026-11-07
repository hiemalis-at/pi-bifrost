import { poolPatternMatches } from "./routing.ts";

/** Structural subset of Pi session branch entries. Pure: no Pi imports. */
export interface SessionEntryLike {
  readonly type: string;
  readonly message?: {
    readonly role: string;
    readonly content?: unknown;
    readonly provider?: string;
    readonly model?: string;
  };
}

export interface ExchangeContext {
  readonly user: string;
  readonly assistant: string;
  readonly tier?: string;
  readonly tools?: string;
}

export interface ConversationContext {
  /** Oldest first. */
  readonly exchanges: readonly ExchangeContext[];
  readonly omittedEarlierTurns: boolean;
  readonly chars: number;
  readonly redactions: number;
  readonly truncated: boolean;
}

export interface ContextOptions {
  readonly turns: number;
  readonly maxChars: number;
  readonly includeToolSummary: boolean;
  readonly includeTiers: boolean;
}

export const PER_USER_CAP = 1000;
export const PER_ASSISTANT_CAP = 2000;

const REDACTED = "[redacted]";

// Order matters: whole-block and header shapes first so later patterns do not
// re-match their remains. "[redacted]" values are skipped by the assignment rule.
const REDACTION_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAuthorization[ \t]*:[ \t]*Bearer[ \t]+\S+/gi,
  /\bsk-(?:or-)?[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[ \t]*[=:][ \t]*(?!\[redacted\])\S+/gi,
];

const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/_=-]{40,}/g;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isHighEntropyToken(token: string): boolean {
  return /\d/.test(token) && /[A-Za-z]/.test(token) && shannonEntropy(token) >= 3.5;
}

export function redactSecrets(text: string): { readonly text: string; readonly count: number } {
  let count = 0;
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  out = out.replace(HIGH_ENTROPY_CANDIDATE, (token) => {
    if (!isHighEntropyToken(token)) return token;
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

/** Replace fenced code blocks with `[code: <lang>, <n> lines]`. An unclosed fence runs to the end. */
export function stubCodeFences(text: string): string {
  if (!text.includes("```")) return text;
  const out: string[] = [];
  let lang = "";
  let lines = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!inFence) {
      const opens = trimmed.startsWith("```") && !trimmed.slice(3).includes("```");
      if (opens) {
        inFence = true;
        lang = trimmed.slice(3).trim().split(/\s+/)[0] ?? "";
        lines = 0;
      } else {
        out.push(line);
      }
    } else if (trimmed === "```") {
      out.push(`[code: ${lang || "text"}, ${lines} lines]`);
      inFence = false;
    } else {
      lines++;
    }
  }
  if (inFence) out.push(`[code: ${lang || "text"}, ${lines} lines]`);
  return out.join("\n");
}

/** `["edit","bash","edit"]` becomes `"edit x2, bash x1"` (first-seen order). */
export function summarizeToolCalls(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${name} x${n}`).join(", ");
}

/** Tier whose pool selects the model, or undefined when none or more than one does. */
export function tierForModel(
  models: Readonly<Record<string, string | readonly string[]>> | undefined,
  provider: string,
  modelId: string,
): string | undefined {
  if (!models) return undefined;
  let found: string | undefined;
  for (const [tier, pool] of Object.entries(models)) {
    const patterns = typeof pool === "string" ? [pool] : pool;
    if (!patterns.some((p) => poolPatternMatches(p, provider, modelId))) continue;
    if (found !== undefined) return undefined;
    found = tier;
  }
  return found;
}

// --- builder ---------------------------------------------------------------

type MessageLike = NonNullable<SessionEntryLike["message"]>;

interface Turn {
  readonly user: string;
  readonly assistants: MessageLike[];
}

function blocks(content: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function assistantText(message: MessageLike): string {
  return blocks(message.content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function toolNames(message: MessageLike): string[] {
  return blocks(message.content)
    .filter((b) => b.type === "toolCall" && typeof b.name === "string")
    .map((b) => b.name as string);
}

/** A turn runs from a user message to the entry before the next user message. */
function collectTurns(entries: readonly SessionEntryLike[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") {
      current = { user: textOf(message.content), assistants: [] };
      turns.push(current);
    } else if (message.role === "assistant" && current) {
      current.assistants.push(message);
    }
    // toolResult and anything else: never read.
  }
  // A turn with no assistant reply is the current prompt (or abandoned); not a prior exchange.
  return turns.filter((t) => t.assistants.length > 0);
}

interface Prepared {
  text: string;
  redactions: number;
  cut: boolean;
}

function prepare(raw: string, cap: number): Prepared {
  const redacted = redactSecrets(stubCodeFences(raw.trim()));
  if (redacted.text.length <= cap) return { text: redacted.text, redactions: redacted.count, cut: false };
  return { text: clip(redacted.text, cap), redactions: redacted.count, cut: true };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  return `${text.slice(0, max - 1)}…`;
}

export function buildConversationContext(
  entries: readonly SessionEntryLike[],
  options: ContextOptions,
  tierOf: (provider: string, model: string) => string | undefined,
): ConversationContext | undefined {
  const turns = collectTurns(entries);
  if (turns.length === 0) return undefined;

  const exchanges: ExchangeContext[] = [];
  let chars = 0;
  let redactions = 0;
  let truncated = false;
  let omitted = turns.length > options.turns;

  const considered = turns.slice(-options.turns);
  for (let i = considered.length - 1; i >= 0; i--) {
    const turn = considered[i];
    const withText = turn.assistants.filter((m) => assistantText(m).length > 0);
    const chosen = withText[withText.length - 1] ?? turn.assistants[turn.assistants.length - 1];

    let user = prepare(turn.user, PER_USER_CAP);
    let reply = prepare(assistantText(chosen), PER_ASSISTANT_CAP);

    const remaining = options.maxChars - chars;
    let cut = user.cut || reply.cut;
    if (user.text.length + reply.text.length > remaining) {
      if (exchanges.length > 0) {
        omitted = true;
        truncated = true;
        break;
      }
      // Newest exchange alone exceeds the budget: shrink it rather than return nothing.
      const userRoom = Math.min(user.text.length, Math.floor(remaining / 2));
      user = { ...user, text: clip(user.text, userRoom) };
      reply = { ...reply, text: clip(reply.text, remaining - user.text.length) };
      cut = true;
    }

    const exchange: { user: string; assistant: string; tier?: string; tools?: string } = {
      user: user.text,
      assistant: reply.text,
    };
    if (options.includeTiers && chosen.provider && chosen.model) {
      const tier = tierOf(chosen.provider, chosen.model);
      if (tier !== undefined) exchange.tier = tier;
    }
    if (options.includeToolSummary) {
      const tools = summarizeToolCalls(turn.assistants.flatMap(toolNames));
      if (tools) exchange.tools = tools;
    }

    exchanges.unshift(exchange);
    chars += user.text.length + reply.text.length;
    redactions += user.redactions + reply.redactions;
    if (cut) truncated = true;
  }

  if (exchanges.length === 0) return undefined;
  return { exchanges, omittedEarlierTurns: omitted, chars, redactions, truncated };
}
