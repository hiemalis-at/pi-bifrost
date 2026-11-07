# Conversation-Aware Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the direct classifier (Jev) decide on the exchange so far (Part B), and keep a bare reply from routing below the tier of the work in progress (Part A), both opt-in.

**Architecture:** One new pure module per concern (`continuation.ts` for qualification and the tier floor, `conversation-context.ts` for building bounded, redacted context from Pi's session branch). `classification-pipeline.ts` gains optional per-call `ClassifyOptions` and a `continuation` result source. One helper, `buildClassifyOptions`, is the only place that reads the session branch and the incumbent, and all five call sites use it. Request builders in both direct backends send an object `state` only when context is present, so context-free requests stay byte-identical.

**Tech Stack:** TypeScript run with `node --experimental-strip-types`, `node:test`, Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`).

**Spec:** `docs/superpowers/specs/2026-11-07-conversation-aware-routing-design.md` (revision 3, commit `b1413ac`)

## Preconditions (not tasks)

- `AGENTS.md`: "proposed ADRs are not implementation approval". The ADR (`docs/adr/0021-conversation-aware-routing.md`, number provisional) must be accepted upstream before Task 1 starts. Task 0 (install and baseline) may run earlier.
- Comment on upstream #161, #179, #180 **after implementation is done** (owner decision, revision 3 follow-up). Do not post earlier.
- #179 (cache semantic safety) may change the cache API. Tasks 3 and 8 touch only the "skip cache read/write" decision; if #179 lands first, follow its API.
- Work on a branch from `main` per PR: Part A = Tasks 1-5, Part B = Tasks 6-8, evaluation = Task 9.

## Global Constraints

- Both blocks ship disabled: `classifier.continuation.enabled` and `classifier.context.enabled` default to `false`. No backend detection feeds either default.
- Bare reply: at most `maxChars` (default 60) characters and at most `maxWords` (default 10) whitespace-separated words; single line; no code fence, URL or path-like token (`/` or `\` between non-space characters). No word lists. Tested on the trimmed prompt after inline-override stripping.
- One mode, `floor`. No `inherit`.
- `classifier.continuation.order` is an explicit array of tier names covering every key of `models`. **Deviation from the spec text, which allowed omitting it:** the order may not be derived from `models` key order (issue #199), so it is required whenever `continuation.enabled` is `true`, and a validation warning when `enabled` is `false` and a bare reply is previewed without one. Update the spec sentence in Task 1.
- Incumbent: the final requested tier of the previous dispatched turn (including a floor-lifted tier and an inline-forced tier). Session-local, in memory, never persisted, never set or read when `process.env.PI_SUBAGENT_RUN_ID` is set. Only a non-bare prompt lowers it; consecutive bare replies never decay it.
- Precedence: inline tier word and `/bifrost pin` > direct-model regex rules > classifier stages as today > continuation floor. Results whose tier is not a configured tier (direct model references) are never touched by the floor.
- Floor rule: a classifier judgment that was given context and returned (so it met `minConfidence`, which the transports already enforce) **stands**. Otherwise the result is the higher of the stage result and the incumbent; a miss, default fallback or unclassified result yields the incumbent.
- Results with source `continuation` are never cached. A bare reply never reads the cache while `continuation.enabled` is true. When context was sent, the fuzzy cache is bypassed for read and write.
- Context sent: current prompt, last `turns` (default 3) exchanges (user prompt, assistant final text, tier the turn ran on, tool names and counts), total budget `maxChars` (default 6000), per-assistant cap 2000 characters, per-user cap 1000 characters, newest first. Never tool results, tool arguments, file contents, system prompts, reasoning blocks or images. Code fences become `[code: <lang>, <n> lines]`. Credential patterns become `[redacted]`. Dropped turns set `omitted_earlier_turns: true`.
- Request shape with context: object `state` = `{ current_prompt, previous_exchanges: [{ user, assistant, tier?, tools? }], omitted_earlier_turns }`, identical for `pi-native` and direct TypeSafe. Without context the request is unchanged (`{ prompt }` for pi-native, plain string for TypeSafe). The prompt classifier backend never receives context.
- Preview, status and trace report that context was sent, turn count, character count and whether anything was redacted or truncated. Never content. Debug output never persists context.
- Conventional Commits. No `Co-Authored-By` trailer, no tool attribution (`AGENTS.md`). Stage only files named in the task.
- Verification before any PR: `npm test` and `npm run typecheck`; for routing changes also `npm run test:ui` and `npm run test:ui:reliability`.

## Review Focus

The inputs the spec implies but no task's main path exercises. Each has a pinning test in the named task.

1. A session resumed or freshly started, bare reply, no incumbent: behavior must equal today's (Task 3 test `no incumbent leaves the result untouched`).
2. A trailing user message with no assistant reply in the branch (the `bifrost/auto` route runs after Pi appended the prompt): it must not be sent as a "previous exchange" (Task 6).
3. Secrets and code inside assistant text, and secrets inside the user's own earlier prompts: redaction must run on both, and near-miss strings must survive (Task 6).
4. Context-fed Jev answering below `minConfidence`: the transport returns a miss, the floor must lift to the incumbent, and the report must say so. The live probe showed context-aware answers at confidence 0.48-0.57 against a 0.7 floor (Task 3, Task 8).
5. Branch entries that are not plain messages (compaction, branch summary, custom, image content blocks, thinking blocks): must be skipped, never sent, never crash (Task 6).
6. `bifrost/auto` and the physical input handler must read and write the same incumbent (Task 4).

## Probe findings that shape this plan (live, synthetic content, `openrouter/typesafe/jev-1.14`, n=1 per case)

- Object `state` with extra keys is accepted and answered (no error), confirming the docs. This went through Pi's registry, not the direct `api.typesafe.ai` endpoint (`jev-1.13.0`); Task 9 repeats it there.
- With the **existing** instruction text plus a short note about the keys, Jev largely ignored a heavy history: "Approved" stayed `light` (0.98 without context, 0.82 with it, confidence 0.76).
- With an **explicit** instruction ("Classify the work the assistant will perform as a result of `current_prompt`, not the length of `current_prompt`. When `current_prompt` is a short reply ... the work is whatever the last item in `previous_exchanges` proposed or asked to do.") Jev used the history strongly: heavy history gave `critical` 0.61 / `heavy` 0.38; trivial history gave `trivial` 0.68. But the reported confidence was 0.48-0.57, below `minConfidence` 0.7, so those answers would be misses and the floor would decide.
- Consequence: the instruction text is the critical part of Part B (it is #180's territory), and Task 9's corpus decides whether it works. Tasks 7 and 9 pin the instruction text as a single constant.

## File Structure

| File | Responsibility |
|---|---|
| `continuation.ts` (new) | `isBareReply`, `resolveTierOrder`, `applyFloor`, constants. Pure. |
| `conversation-context.ts` (new) | `buildConversationContext`, `redactSecrets`, `stubCodeFences`, `summarizeToolCalls`. Pure. |
| `conversation-options.ts` (new) | `buildClassifyOptions`: reads config, session branch, incumbent; returns `ClassifyOptions`. |
| `classification-pipeline.ts` | `ClassifyOptions`, `ContinuationReport`, source `continuation`, cache skip rules, floor wrapper. |
| `classifier-backends.ts` | `ClassifierRequest.context`, `ClassificationJudgment.contextSent`. |
| `classifier-semantics.ts` | `classifierState`, `CONTEXT_INSTRUCTIONS`, `contextSummary`. |
| `classifier-pi-native.ts`, `typesafe-classifier.ts` | Use `classifierState` and the context instruction when `request.context` is set. |
| `config.ts`, `schema.json` | Two new blocks, validation. |
| `index.ts`, `commands.ts` | Use `buildClassifyOptions`; maintain incumbent; skip cache writes; preview/status. |
| `docs/guide/configuration.md`, `docs/guide/classifiers.md`, `examples/` | Config reference, behavior, disclosure. |
| `scripts/jev-benchmark.ts`, `tests/corpus/jev` | Multi-turn scenarios and arms (Task 9). |

---

### Task 0: Environment baseline

**Files:** none.

- [ ] **Step 1:** Run `npm install` in the repo root (no `package-lock.json` exists; do not commit one).
- [ ] **Step 2:** Run `npm test` and `npm run typecheck`. Expected: both pass on `main`. Record any pre-existing failure in the PR description so it is not attributed to this work.

---

### Task 1: Config and schema for both blocks (Part A, PR 1)

**Files:**
- Modify: `config.ts` (`ClassifierConfig`, `validateConfig`)
- Modify: `schema.json` (`classifier` properties)
- Modify: `docs/guide/configuration.md`, `examples/` (add `examples/classifier-conversation-aware.json`)
- Modify: `docs/superpowers/specs/2026-11-07-conversation-aware-routing-design.md` (the "`order` may be omitted" sentence under Part A config and the matching edge-case row become "`order` is required when `enabled` is true")
- Test: `tests/config.test.ts`, `tests/schema.test.ts`, `tests/docs-command-drift.test.ts` (must still pass)

**Interfaces:**
- Produces in `config.ts`:
  ```ts
  export interface ContinuationConfig { enabled?: boolean; order?: string[]; maxChars?: number; maxWords?: number }
  export interface ContextConfig { enabled?: boolean; turns?: number; maxChars?: number; includeToolSummary?: boolean; includeTiers?: boolean }
  // ClassifierConfig gains: continuation?: ContinuationConfig; context?: ContextConfig;
  ```

- [ ] **Step 1: Write failing tests** in `tests/config.test.ts`, using the file's existing `validateConfig` helper style:
  - `continuation enabled without order is an error naming "order"`
  - `continuation order missing a configured tier is an error naming that tier`
  - `continuation order with an unknown tier is an error naming that tier`
  - `continuation maxChars and maxWords must be positive integers` (0, -1, 1.5 rejected)
  - `context turns must be an integer from 1 to 10; maxChars an integer from 500 to 16000`
  - `both blocks absent produce no issues`
  - In `tests/schema.test.ts`: `schema accepts the continuation and context blocks` and `schema rejects unknown keys inside them` (follow how the file asserts existing nested blocks).
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/config.test.ts tests/schema.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the interfaces above, validation inside `validateConfig` (errors for the bullets above, `severity: "error"`), and the schema blocks with `"default": false` for both `enabled` fields and the numeric defaults from Global Constraints. `additionalProperties: false`.
- [ ] **Step 4:** Add `examples/classifier-conversation-aware.json` (pi-native backend, both blocks `enabled: true`, tiers `trivial`/`light`/`heavy`/`critical`, matching `order`). Add the config reference rows to `docs/guide/configuration.md`. Update the spec sentence.
- [ ] **Step 5:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit**
  ```bash
  git add config.ts schema.json examples/classifier-conversation-aware.json docs/guide/configuration.md docs/superpowers/specs/2026-11-07-conversation-aware-routing-design.md tests/config.test.ts tests/schema.test.ts
  git commit -m "feat(config): add continuation and context classifier blocks"
  ```

---

### Task 2: Bare-reply qualification and tier floor (Part A)

**Files:**
- Create: `continuation.ts`
- Test: `tests/continuation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DEFAULT_BARE_MAX_CHARS = 60;
  export const DEFAULT_BARE_MAX_WORDS = 10;
  export interface BareReplyLimits { readonly maxChars?: number; readonly maxWords?: number }
  export interface BareReplyVerdict { readonly bare: boolean; readonly chars: number; readonly words: number; readonly reason: "bare" | "too_long" | "too_many_words" | "multiline" | "code_fence" | "url" | "path" | "empty" }
  export function isBareReply(text: string, limits?: BareReplyLimits): BareReplyVerdict;
  export type FloorRule = "classifier_stands" | "floor_lifted" | "classifier_higher" | "incumbent_on_miss";
  export interface FloorInput { readonly classifierTier?: string; readonly classifierSawContext: boolean; readonly incumbent: string; readonly order: readonly string[] }
  export function applyFloor(input: FloorInput): { readonly tier: string; readonly rule: FloorRule };
  ```

- [ ] **Step 1: Write failing tests** (`tests/continuation.test.ts`), table-driven for `isBareReply`:
  - `"Approved"`, `"yes"`, `"2"`, `"Looks right, go ahead and open the PR"` → `bare: true`.
  - A 60-character string is bare, 61 is `too_long`; 10 words bare, 11 `too_many_words`.
  - `"a\nb"` → `multiline`; text containing ``` → `code_fence`; `"see https://x.io"` → `url`; `"edit src/a.ts"` → `path`; `"and/or"` is `path` (contains `/` between non-space characters); `"a / b"` is **not** a path.
  - `""` and `"   "` → `empty`, `bare: false`.
  - Non-English: `"Genehmigt"`, `"承認します"` → `bare: true`; custom limits `{maxChars: 5}` respected.
  - `applyFloor` with `order = ["trivial","light","heavy","critical"]`, `incumbent = "heavy"`:
    - classifier `light`, `sawContext:false` → `{tier:"heavy", rule:"floor_lifted"}`
    - classifier `critical`, `sawContext:false` → `{tier:"critical", rule:"classifier_higher"}`
    - classifier `heavy`, `sawContext:false` → `{tier:"heavy", rule:"classifier_higher"}`
    - classifier `trivial`, `sawContext:true` → `{tier:"trivial", rule:"classifier_stands"}`
    - classifier undefined → `{tier:"heavy", rule:"incumbent_on_miss"}`
    - a tier not in `order` throws `Error` naming the tier (never silently ignored).
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/continuation.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `continuation.ts` to the signatures above. Count words by splitting the trimmed text on `/\s+/`; path test is `/\S[\/\\]\S/`; URL test is `/\bhttps?:\/\/|\bwww\./i`. `rank = order.indexOf(tier)`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add continuation.ts tests/continuation.test.ts
  git commit -m "feat(continuation): bare-reply qualification and tier floor"
  ```

---

### Task 3: Pipeline integration (Part A)

**Files:**
- Modify: `classification-pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `isBareReply`, `applyFloor`, `FloorRule` from Task 2; `ContinuationConfig` shape from Task 1.
- Produces:
  ```ts
  export type ClassificationSource = "cache" | "classifier" | "regex" | "inline" | "continuation";
  export interface ContinuationReport {
    readonly incumbent: string;
    readonly applied: boolean;            // false when the block is disabled (advisory)
    readonly rule: FloorRule;
    readonly classifierTier?: string;
    readonly bare: BareReplyVerdict;
  }
  export interface ClassifyOptions {
    readonly incumbent?: string;
    readonly context?: ConversationContext;   // defined in Task 6; type-only import
  }
  // PipelineDeps gains:
  readonly continuation?: { readonly enabled: boolean; readonly order: readonly string[]; readonly maxChars?: number; readonly maxWords?: number };
  readonly classifyDirect?: (text: string, tiers: readonly string[], signal?: AbortSignal, context?: ConversationContext) => Promise<ClassificationJudgment | undefined>;
  // ClassificationPipeline.classify gains a third parameter: (text, signal?, options?: ClassifyOptions)
  // "classified" and "fallback" results gain: readonly continuation?: ContinuationReport
  // ClassificationJudgment gains (classifier-backends.ts): readonly contextSent?: boolean
  ```
  Task 3 defines `ConversationContext` as a placeholder `export interface ConversationContext { readonly exchanges: readonly unknown[] }` in `conversation-context.ts`; Task 6 replaces it with the real type. (Keeps this task independently testable.)

- [ ] **Step 1: Write failing tests** in `tests/pipeline.test.ts` (new `describe("continuation")`, `deps()` helper as in the file, `order` of `["economical","frontier"]`, bare text `"Approved"`):
  - `no incumbent leaves the result untouched` (enabled, bare, no `options.incumbent`; result equals the same call without the block).
  - `non-bare prompt leaves the result untouched` (long text, incumbent `frontier`, classifier says `economical`).
  - `bare reply with classifier lower is lifted to the incumbent`: `source: "continuation"`, `tier: "frontier"`, `continuation.rule === "floor_lifted"`, `applied: true`.
  - `bare reply with classifier higher keeps the classifier tier` (`rule: "classifier_higher"`, source `classifier`).
  - `classifier miss yields the incumbent, not the default tier` (`defaultTier: "economical"`, incumbent `frontier`, `rule: "incumbent_on_miss"`).
  - `confident context-fed judgment stands below the incumbent`: `classifyDirect` returns `{tier:"economical", backend:"pi-native", confidence:0.9, contextSent:true}` → result tier `economical`, source `classifier`, `rule: "classifier_stands"`.
  - `the same judgment without contextSent is lifted`.
  - `direct-model regex rule beats the floor`: a rule routing `"Approved"` to `"opencode-go/x"` returns that model unchanged.
  - `disabled block is advisory`: `enabled:false` returns the unchanged result but with `continuation.applied === false` and the rule that would have applied.
  - `bare reply skips cache lookup while enabled`: `cacheLookup` spy not called.
  - `enabled false does not skip cache lookup`.
  - `context present skips cache lookup` (`options.context` set, spy not called).
  - `a continuation result carries source "continuation"` (caller-side cache writing keys off `source === "classifier"`, so no write; asserted in Task 4).
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/pipeline.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Rename the existing body of `classify` to an inner `classifyBase(text, signal, skipCache, context)`; pass `context` to `classifyDirect` and set `contextSent: true` on the returned judgment when `context` was passed and the transport returned one. New `classify(text, signal, options)`: compute `bare = isBareReply(text, limits)`; `skipCache = Boolean(options?.context) || (continuation?.enabled && bare.bare)`; call `classifyBase`; if the block is absent, no incumbent, not bare, or result tier is not in `tiers` (or kind `unclassified` with no incumbent), return the base result; otherwise compute `applyFloor` (`classifierTier` and `classifierSawContext` come from the base result when `source === "classifier"`; for cache, regex-tier or default-`fallback` results treat the classifier as missed except regex-tier, which is passed as `classifierTier`), attach `ContinuationReport`, and return the changed result only when `continuation.enabled`.
- [ ] **Step 4:** Run `node --test --experimental-strip-types tests/pipeline.test.ts`. Expected: PASS (existing tests unchanged).
- [ ] **Step 5: Commit**
  ```bash
  git add classification-pipeline.ts classifier-backends.ts conversation-context.ts tests/pipeline.test.ts
  git commit -m "feat(pipeline): continuation floor with advisory report"
  ```

---

### Task 4: Incumbent and call-site wiring (Part A)

**Files:**
- Create: `conversation-options.ts`
- Modify: `index.ts` (state object near `pinned: false`; `buildPipeline` passes `continuation` deps; input handler; `bifrost/auto` `select`; both cache-write sites)
- Modify: `commands.ts` (three `classify(prompt)` call sites: preview, benchmark, explain)
- Test: `tests/conversation-options.test.ts`, extend `tests/dispatch-ownership.test.ts`-style test only if a seam already exists

**Interfaces:**
- Consumes: `ClassifyOptions` (Task 3), `ContinuationConfig` (Task 1).
- Produces:
  ```ts
  export interface ClassifyOptionsSource {
    readonly config: BifrostConfig;
    readonly incumbentTier?: string;
  }
  export function buildClassifyOptions(source: ClassifyOptionsSource, env?: Record<string, string | undefined>): ClassifyOptions;
  // BifrostState (commands.ts) gains: incumbentTier?: string;
  ```
  Task 6/8 extend `buildClassifyOptions` with a session-branch parameter; keep the first parameter shape.

- [ ] **Step 1: Write failing tests** (`tests/conversation-options.test.ts`):
  - `returns no incumbent when continuation block is absent and disabled` (advisory still wants the incumbent: returns it whenever `incumbentTier` is set and `order` exists).
  - `returns the incumbent when set`.
  - `returns nothing under PI_SUBAGENT_RUN_ID` (env `{PI_SUBAGENT_RUN_ID: "x"}`).
  - `ignores an incumbent that is no longer a configured tier` (`config.models` lacks it).
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/conversation-options.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildClassifyOptions` and wire it:
  - In `buildPipeline`, pass `continuation: { enabled: Boolean(cfg.enabled), order: cfg.order, maxChars, maxWords }` when `cfg?.order` is present.
  - Input handler (`index.ts:669`) and `route` select (`index.ts:445`) and the three `commands.ts` calls pass `buildClassifyOptions(...)` as the third argument. Inline-forced prompts skip classification as today.
  - After a successful dispatch (input handler after the model is chosen; `route` after `resolved.selected`), set `state.incumbentTier = classification.tier` (requested tier). Not set under `PI_SUBAGENT_RUN_ID`. Not set when no model was selected.
  - Both cache-write sites already require `source === "classifier"`; add `&& !classification.judgment?.contextSent` so Task 8's context-fed results are never written. `continuation` results are already excluded by the source check.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Manual check with `pi` (Global Constraints, live, synthetic prompts): config with `continuation.enabled: true`, send a substantive prompt classified `heavy`, then `Approved`; confirm the stderr line `[bifrost] classify:` shows a `continuation` tag for the second prompt.
- [ ] **Step 6: Commit**
  ```bash
  git add conversation-options.ts index.ts commands.ts tests/conversation-options.test.ts
  git commit -m "feat(routing): maintain incumbent tier and wire continuation floor"
  ```

---

### Task 5: Part A visibility and docs

**Files:**
- Modify: `commands.ts` (`renderPreviewReport`, the preview report type near line 663, status text), `index.ts` (`log` line for `bifrost/auto`, the `[bifrost] classify:` stderr tag), `debug.ts` call sites in the pipeline
- Modify: `docs/guide/classifiers.md`, `docs/guide/commands.md`, `docs/guide/prompt-caching.md` (state that continuation results are never cached and bare replies skip the cache while enabled)
- Modify: `CHANGELOG.md` (Unreleased)
- Test: `tests/bifrost-commands.test.ts`, `tests/docs-command-drift.test.ts` (must pass)

**Interfaces:**
- Consumes: `ContinuationReport` (Task 3).
- Produces: preview JSON gains `continuation?: { incumbent: string; applied: boolean; rule: string; classifierTier?: string; reason: string; chars: number; words: number }`; the text report gains a `continuation:` line.

- [ ] **Step 1: Write failing tests** in `tests/bifrost-commands.test.ts` (follow the file's existing preview tests): `preview --json includes continuation with applied false when the block is disabled`, `preview text shows "continuation: floor_lifted (incumbent heavy, classifier light)"`, `preview without an incumbent has no continuation field`.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/bifrost-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the report fields and text. The `source` line shows `continuation` when the floor decided; when the classifier stood, show `classifier` plus the report line. Add `debug("pipeline", "continuation", {...})` with tiers, rule, bare verdict and no prompt text.
- [ ] **Step 4:** Write the docs sections; run `npm test && npm run typecheck && npm run test:ui`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add commands.ts index.ts classification-pipeline.ts docs/guide CHANGELOG.md tests/bifrost-commands.test.ts
  git commit -m "feat(preview): report continuation floor decisions"
  ```

*Part A PR ends here. Run the full verification block and a reverted-guard run (revert the floor in `classification-pipeline.ts`, show the Task 3 tests go red, restore) and paste both into the PR.*

---

### Task 6: Conversation context builder (Part B, PR 2)

**Files:**
- Create: `conversation-context.ts` (replaces the Task 3 placeholder type)
- Test: `tests/conversation-context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SessionEntryLike { readonly type: string; readonly message?: { readonly role: string; readonly content?: unknown; readonly provider?: string; readonly model?: string } }
  export interface ExchangeContext { readonly user: string; readonly assistant: string; readonly tier?: string; readonly tools?: string }
  export interface ConversationContext { readonly exchanges: readonly ExchangeContext[]; readonly omittedEarlierTurns: boolean; readonly chars: number; readonly redactions: number; readonly truncated: boolean }
  export interface ContextOptions { readonly turns: number; readonly maxChars: number; readonly includeToolSummary: boolean; readonly includeTiers: boolean }
  export const PER_USER_CAP = 1000; export const PER_ASSISTANT_CAP = 2000;
  export function redactSecrets(text: string): { readonly text: string; readonly count: number };
  export function stubCodeFences(text: string): string;
  export function summarizeToolCalls(names: readonly string[]): string;   // "edit x4, bash x2"
  export function buildConversationContext(entries: readonly SessionEntryLike[], options: ContextOptions, tierOf: (provider: string, model: string) => string | undefined): ConversationContext | undefined;
  ```
  `exchanges` are oldest first; `undefined` when there is no completed prior exchange.

- [ ] **Step 1: Write failing tests** (`tests/conversation-context.test.ts`):
  - `redactSecrets` replaces: an `sk-`/`sk-or-`/`ghp_`/`AKIA…` key shape, an `Authorization: Bearer <token>` header, a `-----BEGIN … PRIVATE KEY-----` block, `API_KEY=abc123` and `password: hunter2` assignments, and a 40+ character high-entropy token, each with `[redacted]` and `count` incremented. Near misses survive unchanged: `"the sk-ip flag"`, `"password policy"`, `"API_KEY is documented"`, a 40-character lowercase English sentence without digits.
  - `stubCodeFences` turns a 42-line ```ts fence into `[code: ts, 42 lines]`, keeps surrounding prose, handles a fence with no language (`[code: text, n lines]`) and an unclosed fence (stubbed to end of text).
  - `summarizeToolCalls(["edit","bash","edit"])` → `"edit x2, bash x1"` in first-seen order; empty → `""`.
  - Builder: two complete turns return two exchanges, oldest first; `turns: 1` returns the newest and `omittedEarlierTurns: true`.
  - **Trailing unanswered user message is dropped** (Review Focus 2).
  - Skips `compaction`, `branch_summary`, `custom`, `custom_message`, `thinking_level_change` entries and `toolResult` messages without error and without their content in the output (Review Focus 5); image content blocks and `thinking` blocks are ignored.
  - Assistant text is the text blocks of the turn's last assistant message that has text; tool names come from `toolCall` blocks across the whole turn.
  - `tier` comes from `tierOf(provider, model)` of that last assistant message when `includeTiers`; absent when `tierOf` returns `undefined` or the option is off; `tools` absent when `includeToolSummary` is false.
  - Budget: newest first within `maxChars`; per-user and per-assistant caps applied; `truncated: true` when a cap or the budget cut text; user text is redacted too (Review Focus 3); `redactions` totals both.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/conversation-context.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** to the signatures. A turn is a `user` message through the entry before the next `user` message. Apply order per text: `stubCodeFences` then `redactSecrets` then the cap.
- [ ] **Step 4:** Run the test file. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add conversation-context.ts tests/conversation-context.test.ts
  git commit -m "feat(context): bounded, redacted conversation context builder"
  ```

---

### Task 7: Request construction for both direct backends

**Files:**
- Modify: `classifier-backends.ts` (`ClassifierRequest.context?: ConversationContext`)
- Modify: `classifier-semantics.ts`, `classifier-pi-native.ts` (`buildContext`, line ~93), `typesafe-classifier.ts` (`buildTypeSafeRequest`, line ~45)
- Test: `tests/classifier-pi-native.test.ts`, `tests/typesafe-classifier.test.ts`, `tests/classifier-backends.test.ts`

**Interfaces:**
- Consumes: `ConversationContext` (Task 6).
- Produces in `classifier-semantics.ts`:
  ```ts
  export const CONTEXT_INSTRUCTIONS: string;   // the single instruction constant for context-bearing requests
  export function classifierState(request: ClassifierRequest): JsonObject | string;  // string only for TypeSafe-without-context is handled by the caller; see below
  export function contextState(request: ClassifierRequest & { context: ConversationContext }): JsonObject;
  export function contextSummary(context: ConversationContext): { turns: number; chars: number; redacted: boolean; truncated: boolean };
  ```
  Simplify if the implementer prefers: `contextState` plus `contextSummary` are required; `classifierState` is optional.

- [ ] **Step 1: Write failing tests:**
  - pi-native: `request without context sends { prompt } and the unchanged instruction` (deep-equals today's context object, captured through the fake registry's `classify`); `request with context sends current_prompt, previous_exchanges, omitted_earlier_turns and CONTEXT_INSTRUCTIONS`; `nothing else is sent` (the state's keys are exactly those three, each exchange's keys are a subset of `user, assistant, tier, tools`).
  - TypeSafe: `buildTypeSafeRequest` without context keeps `state` equal to the prompt string (existing test must pass untouched); with context `state` is the same object as pi-native's; `questions.tier.instructions === CONTEXT_INSTRUCTIONS`.
  - `CONTEXT_INSTRUCTIONS` mentions `current_prompt` and `previous_exchanges` and the "work the assistant will perform" rule (assert with `includes`), and tests assert it is used verbatim by both backends.
  - Judgment: a returned judgment for a context request has `contextSent: true`; for a context-free request it is absent.
  - Debug: with `debug: true` the trace output for a context request contains `contextSummary` fields and none of the exchange text (assert by capturing the debug sink with a sentinel string in the context).
- [ ] **Step 2:** Run the three test files. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `CONTEXT_INSTRUCTIONS` is the "A_explicit" text from the probe findings, extended with one sentence naming `omitted_earlier_turns`. Add the comment `// Instruction text is policy owned by #180's compiler; keep it a single constant so #180 can take it over.` Set `contextSent: true` where the transports build their `PiNativeJudgment` / `TypeSafeJudgment`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add classifier-backends.ts classifier-semantics.ts classifier-pi-native.ts typesafe-classifier.ts tests/classifier-pi-native.test.ts tests/typesafe-classifier.test.ts tests/classifier-backends.test.ts
  git commit -m "feat(classifier): send object state with bounded context"
  ```

---

### Task 8: Part B wiring, visibility and disclosure

**Files:**
- Modify: `conversation-options.ts` (`buildClassifyOptions` gains `branch` and `tierOf`), `index.ts` (`buildPipeline` direct wrappers pass `context` through `classifyDirect`), `commands.ts` (status and preview), `docs/guide/classifiers.md`, `docs/guide/configuration.md`, `docs/guide/prompt-caching.md`, `CHANGELOG.md`
- Test: `tests/conversation-options.test.ts`, `tests/pipeline.test.ts`, `tests/bifrost-commands.test.ts`

**Interfaces:**
- Consumes: `buildConversationContext`, `ContextOptions` (Task 6), `ContextConfig` (Task 1).
- Produces:
  ```ts
  export interface ClassifyOptionsSource {
    readonly config: BifrostConfig;
    readonly incumbentTier?: string;
    readonly backend: ClassifierBackend;                       // effective backend
    readonly branch?: readonly SessionEntryLike[];             // ctx.sessionManager.getBranch()
  }
  // buildClassifyOptions now also sets options.context when all of: context.enabled === true,
  // backend is "pi-native" or "typesafe", PI_SUBAGENT_RUN_ID unset, and a prior exchange exists.
  export function tierForModel(models: Readonly<Record<string, string | readonly string[]>> | undefined, provider: string, modelId: string): string | undefined; // unique match only
  ```

- [ ] **Step 1: Write failing tests:**
  - `buildClassifyOptions` with `context.enabled:false` (and absent) sets no context; with it enabled and backend `prompt` sets none; with backend `pi-native` and a two-turn branch sets context with 2 exchanges; under `PI_SUBAGENT_RUN_ID` none.
  - `tierForModel` returns the tier for a unique match, `undefined` for a model in two tiers, `undefined` for an unknown model; honors glob/pattern pool entries the same way routing resolves them (reuse the matcher in `routing.ts` rather than reimplementing).
  - Pipeline: `classify` with `options.context` calls `classifyDirect` with that context (spy), and a returned judgment has `contextSent: true`; a context-fed miss (undefined) with an incumbent and a bare reply is lifted (`incumbent_on_miss`) (Review Focus 4).
  - Cache: with context present, `saveClassifierDecision` writes nothing (assert through the index-level helper if exposed; otherwise assert the predicate function you extract, `shouldCacheResult(result): boolean`, in `conversation-options.ts`).
  - Preview: `--json` includes `context: { sent: true, turns: 2, chars: <n>, redacted: false, truncated: false }` and the output contains none of the sentinel text placed in the branch.
  - Status: `/bifrost status` shows `context: on|off` and, when on, the disclosure phrase "sent to the classifier provider".
- [ ] **Step 2:** Run the three test files. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** In `index.ts` the two direct wrappers become `async (text, availableTiers, signal, context) => classify({ prompt: boundedClassifierPrompt(text), tiers, criteria, ...(context ? { context } : {}) }, signal)`. Every call site passes `ctx.sessionManager.getBranch()` and the effective backend into `buildClassifyOptions`.
- [ ] **Step 4:** Write the guide sections. `docs/guide/classifiers.md` must state: what is sent, what is never sent, that enabling the block sends assistant text to the classifier provider, redaction, the cache consequence, and how to disable. Run `npm test && npm run typecheck && npm run test:ui && npm run test:ui:reliability`. Expected: PASS.
- [ ] **Step 5:** Live check through `pi` with `context.enabled: true` and `/bifrost preview --json "Approved"` after a synthetic exchange in the session; confirm `context.sent: true` and a tier. Use only synthetic text.
- [ ] **Step 6: Commit**
  ```bash
  git add conversation-options.ts index.ts commands.ts docs/guide CHANGELOG.md tests
  git commit -m "feat(classifier): opt-in conversation context for direct backends"
  ```

*Part B PR ends here. Same verification block and a reverted-guard run (remove the context pass-through in `index.ts`, show Task 8 tests go red).*

---

### Task 9: Evaluation corpus and release guard

**Files:**
- Modify: `scripts/jev-benchmark.ts` (scenario type, arms, report), `tests/jev-benchmark.test.ts`
- Create: `tests/corpus/jev/multi-turn.*` in the format the existing corpus files use (read `tests/corpus/jev` first and match it)
- Results go in the PR description as aggregates only, never prompt text.

**Interfaces:**
- Consumes: `ConversationContext`, `buildConversationContext` types (Task 6), `applyFloor` (Task 2).
- Produces: scenario field `context?: { exchanges: ExchangeContext[]; incumbent?: string }`; four arms as in the spec (prompt only; prompt plus floor; prompt plus context; prompt plus context plus floor); per-family accuracy, under-routing, over-routing, miss rate, confidence distribution of context-fed answers, floor-lift rate, and requests whose decisive text falls beyond the input bound.

- [ ] **Step 1: Write failing tests** in `tests/jev-benchmark.test.ts`: scenario parsing accepts `context`; arm 2 applies the floor to a fake classifier's answers; arm 4 lets a context-fed confident answer stand; the report lists families separately and contains no scenario text.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/jev-benchmark.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then author the **synthetic** corpus with a gold tier, rationale and ambiguity note per scenario, covering the spec's families: approvals, bare numbers and option letters, "Fix it.", "Continue.", "Use the second approach.", "try again", a short new task after a trivial turn, a short new task after a heavy turn, and ordinary single-turn prompts. At least 8 scenarios per family. No real session text.
- [ ] **Step 4:** Record the **release guard before running anything**: arm 4 must not under-route more than arm 1 on any family and must not regress on the single-turn families; the arm-3-over-arm-2 margin on context-dependent families is a recorded target, not a gate. Put it in the PR description first, then run the paid benchmark (explicit owner authorization already given for `pi` with the OpenRouter Jev route and account credits; use only synthetic corpus text).
- [ ] **Step 5:** Repeat the object-`state` probe against the direct `api.typesafe.ai/v1/systemone` endpoint (`jev-1.13.0`) with synthetic content, via a throwaway script outside the repo. Report the result; if the direct endpoint rejects object `state`, stop and report to the owner before Task 8 ships.
- [ ] **Step 6: Commit**
  ```bash
  git add scripts/jev-benchmark.ts tests/jev-benchmark.test.ts tests/corpus/jev
  git commit -m "test(jev): multi-turn context corpus and four-arm report"
  ```

---

### Task 10: Release notes and upstream communication

- [ ] **Step 1:** Update `CHANGELOG.md` with both features, both opt-in, the disclosure sentence, and the cache consequence.
- [ ] **Step 2:** After implementation is done and the PRs are open, draft comments for upstream #161, #179 and #180 containing the evidence table (aggregate numbers only), the probe findings and the evaluation results. **Show them to the owner; post only on approval.**

## Self-review

- **Spec coverage:** Part A behavior, qualification, incumbent, pipeline position, cache rule, visibility, edge cases → Tasks 1-5 (the "incumbent tier no longer exists" case is in Task 4; "order missing a tier" in Task 1; consecutive bare replies and resume in Tasks 3-4). Part B what-is-sent, request shape, disclosure, cache, visibility, failure, overrides, subagents → Tasks 6-8. Evaluation, release guard, object-state verification → Task 9. Governance and delivery order → Preconditions and Task 10. Owner decisions 1-10 are in Global Constraints. The spec's `order may be omitted` is changed deliberately (Task 1 edits the spec).
- **Type consistency:** `ClassifyOptions`, `ContinuationReport`, `FloorRule`, `ConversationContext`, `ExchangeContext`, `contextSent` are defined once (Tasks 2, 3, 6) and used under those names in Tasks 4, 5, 7, 8, 9.
- **Confidence (owner decision, revision 3 follow-up):** one `classifier.minConfidence` for everything; no second threshold. The probe's low confidences (0.48-0.57) may be an artifact of the synthetic probes, so Task 9 reports the confidence distribution and miss rate of context-fed answers per family, and the result is recorded in the PR and ADR for a later decision.
