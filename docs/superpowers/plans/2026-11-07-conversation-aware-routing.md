# Conversation-Aware Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the direct classifier (Jev) decide on the exchange so far, so a turn is classified by the work it triggers (planning versus executing), not by the text of the prompt alone. Opt-in.

**Architecture:** Two new pure modules: `conversation-context.ts` (builds bounded, redacted context from Pi's session branch) and `conversation-options.ts` (`buildClassifyOptions`, the only place that reads the branch). `classification-pipeline.ts` gains optional per-call `ClassifyOptions` carrying that context to the direct classifier and bypasses the cache when context is sent. Both direct backends send an object `state` only when context is present, so context-free requests stay byte-identical. There is no tier floor, no inheritance and no rule that reads the previous turn's tier.

**Tech Stack:** TypeScript run with `node --experimental-strip-types`, `node:test`, Pi extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`).

**Spec:** `docs/superpowers/specs/2026-11-07-conversation-aware-routing-design.md` (revision 4)

## Preconditions (not tasks)

- `AGENTS.md`: "proposed ADRs are not implementation approval". Upstream process: open an issue, wait for the maintainer's reaction, submit the ADR on the owner's say-so. The fork implements regardless (owner decision), so the fork may proceed after the owner says go; an upstream PR waits for ADR acceptance.
- Comments on upstream #161, #179, #180 only after implementation, with text approved by the owner.
- #179 (cache semantic safety) may change the cache API. Task 4 touches only "skip cache read/write when context is sent"; if #179 lands first, follow its API.
- Local environment (no tracked changes): `npm install --no-save @earendil-works/pi-codemode@1.0.4 typescript`. Baseline on `main`: all tests pass except `tests/release-package.test.mjs` (the `LICENSE` file is not in its allowlist; unrelated, pre-existing). Note it in PR descriptions.

## Global Constraints

- `classifier.context.enabled` defaults to `false`. No backend detection feeds the default.
- **No tier floor, no inheritance, no incumbent.** Nothing in routing may read the previous turn's tier to decide a tier. The previous tier appears only inside the context sent to Jev.
- Context is sent to the direct classifier only (`pi-native`, `typesafe`), on every classification while enabled. The prompt classifier backend never receives it. Subagent sessions (`process.env.PI_SUBAGENT_RUN_ID` set) send none. Inline-tier and `/bifrost pin` paths skip classification, so send none.
- Context contents: current prompt; last `turns` (default 3, integer 1 to 10) exchanges as user prompt and assistant final text; the tier each turn ran on (unique pool match of the assistant message's model, else omitted; only when `includeTiers`); tool names and counts only (only when `includeToolSummary`). Budget `maxChars` (default 6000, integer 500 to 16000) newest first, per-assistant cap 2000, per-user cap 1000. Dropped turns set `omitted_earlier_turns`.
- Never sent: tool results, tool arguments, file contents, system prompts, reasoning blocks, images, parent-session content.
- Treatment: code fences become `[code: <lang>, <n> lines]` (`text` when no language); credential patterns become `[redacted]` in assistant text and earlier user prompts; an unanswered trailing user message is the current prompt and is never a previous exchange.
- Request shape with context, identical for `pi-native` and direct TypeSafe: `state = { current_prompt, previous_exchanges: [{ user, assistant, tier?, tools? }], omitted_earlier_turns }`. Without context the request is unchanged (`{ prompt }` for pi-native, plain string for TypeSafe).
- A returned judgment decides (the transports already enforce `classifier.minConfidence`). A miss falls through exactly as today. One `minConfidence`; no second threshold.
- When context was sent the fuzzy cache is not read and not written.
- Preview, status and trace report: context sent, number of exchanges, character count, redacted or truncated flags; and when context was sent but the classifier missed, that the classification was made without usable context. Never content. Debug output never persists context.
- Conventional Commits. No `Co-Authored-By` trailer, no tool attribution (`AGENTS.md`). Stage only files named in the task.
- Verification before any PR: `npm test` and `npm run typecheck`; for routing changes also `npm run test:ui` and `npm run test:ui:reliability`.

## Review Focus

Inputs the spec implies but no task's main path exercises. Each has a pinning test in the named task.

1. First turn of a session (no prior exchange): no context, request byte-identical to today's (Task 4).
2. The `bifrost/auto` route runs after Pi appended the prompt, so the branch ends with an unanswered user message: it must not be sent as a previous exchange (Task 2).
3. Secrets in assistant text and in the user's own earlier prompts; near-miss strings must survive (Task 2).
4. Branch entries that are not plain messages (compaction, branch summary, custom, image blocks, thinking blocks) must be skipped, never sent, never crash (Task 2).
5. A context-fed classifier miss or low-confidence answer falls through as today and the report says so; the probe showed context-aware answers at confidence 0.48-0.57 against a 0.7 floor (Task 4).
6. Planning then approval: the previous exchange ran on a "planner" tier and the fake classifier answers "worker"; the result must be "worker", proving nothing pulls the previous tier along (Task 4).
7. Subagent session and prompt backend send no context (Task 4).

## Probe findings that shape this plan (live, synthetic content, Pi-routed Jev classifier, n=1 per case)

- Object `state` with extra keys is accepted and answered, confirming the docs. This went through Pi's registry, not the direct `api.typesafe.ai` endpoint (`jev-1.13.0`); Task 6 repeats it there.
- With the **existing** instruction text plus a short note about the keys, Jev largely ignored a heavy history: "Approved" stayed `light` (0.98 without context, 0.82 with it, confidence 0.76).
- With an **explicit** instruction ("Classify the work the assistant will perform as a result of `current_prompt`, not the length of `current_prompt`. When `current_prompt` is a short reply ... the work is whatever the last item in `previous_exchanges` proposed or asked to do.") Jev used the history strongly: heavy history gave `critical` 0.61 / `heavy` 0.38; trivial history gave `trivial` 0.68. The reported confidence was 0.48-0.57, below `minConfidence` 0.7, so those answers would be misses. Whether that is an artifact of the synthetic probes is unknown; Task 6 reports the distribution.
- Consequence: the instruction text decides whether Part B works (it is #180's territory). Tasks 3 and 6 pin it as a single constant.

## File Structure

| File | Responsibility |
|---|---|
| `conversation-context.ts` (new) | `buildConversationContext`, `redactSecrets`, `stubCodeFences`, `summarizeToolCalls`, `tierForModel`. Pure. |
| `conversation-options.ts` (new) | `buildClassifyOptions`: reads config, session branch, backend, env; returns `ClassifyOptions`. |
| `classification-pipeline.ts` | `ClassifyOptions`, `ContextOutcome`, cache bypass when context is present. |
| `classifier-backends.ts` | `ClassifierRequest.context`, `ClassificationJudgment.contextSent`. |
| `classifier-semantics.ts` | `CONTEXT_INSTRUCTIONS`, `contextState`, `contextSummary`. |
| `classifier-pi-native.ts`, `typesafe-classifier.ts` | Use `contextState` and `CONTEXT_INSTRUCTIONS` when `request.context` is set. |
| `config.ts`, `schema.json` | The `classifier.context` block and validation. |
| `index.ts`, `commands.ts` | Use `buildClassifyOptions` at all call sites; skip cache writes; preview and status. |
| `docs/guide/*`, `examples/` | Config reference, behavior, disclosure, stage-criteria example. |
| `scripts/jev-benchmark.ts`, `tests/corpus/jev` | Multi-turn scenarios and arms (Task 6). |

---

### Task 0: Environment baseline (done)

Install and baseline were run: see Preconditions for the local fix and the one pre-existing failure. Re-run `npm test && npm run typecheck` at the start of Task 1 on a fresh checkout and confirm the same result.

---

### Task 1: Config and schema

**Files:**
- Modify: `config.ts` (`ClassifierConfig`, `validateConfig`), `schema.json`
- Modify: `docs/guide/configuration.md`; create `examples/classifier-conversation-aware.json`
- Test: `tests/config.test.ts`, `tests/schema.test.ts`, `tests/docs-command-drift.test.ts` (must still pass)

**Interfaces:**
- Produces in `config.ts`:
  ```ts
  export interface ContextConfig { enabled?: boolean; turns?: number; maxChars?: number; includeToolSummary?: boolean; includeTiers?: boolean }
  // ClassifierConfig gains: context?: ContextConfig;
  export const DEFAULT_CONTEXT_TURNS = 3; export const DEFAULT_CONTEXT_MAX_CHARS = 6000;
  ```

- [ ] **Step 1: Write failing tests** (existing `validateConfig` helper style in `tests/config.test.ts`):
  - `context turns must be an integer from 1 to 10` (0, 11, 1.5 rejected; 3 accepted)
  - `context maxChars must be an integer from 500 to 16000`
  - `context block absent produces no issues`
  - `context enabled with the prompt backend is a warning that context is only sent to direct backends`
  - In `tests/schema.test.ts`: `schema accepts the context block` and `schema rejects unknown keys inside it`.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/config.test.ts tests/schema.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the interface, validation (`severity: "error"` for range violations, `"warning"` for the prompt-backend case) and the schema block (`additionalProperties: false`, `enabled` default `false`).
- [ ] **Step 4:** Add `examples/classifier-conversation-aware.json` (pi-native backend, `context.enabled: true`, role-based tier criteria `planner` and `worker` as in the spec's "Expressing stages" section) and the config reference rows.
- [ ] **Step 5:** Run `npm test && npm run typecheck`. Expected: PASS apart from the pre-existing release-package failure.
- [ ] **Step 6: Commit**
  ```bash
  git add config.ts schema.json examples/classifier-conversation-aware.json docs/guide/configuration.md tests/config.test.ts tests/schema.test.ts
  git commit -m "feat(config): add classifier.context block"
  ```

---

### Task 2: Conversation context builder

**Files:**
- Create: `conversation-context.ts`
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
  export function tierForModel(models: Readonly<Record<string, string | readonly string[]>> | undefined, provider: string, modelId: string): string | undefined; // unique match only
  export function buildConversationContext(entries: readonly SessionEntryLike[], options: ContextOptions, tierOf: (provider: string, model: string) => string | undefined): ConversationContext | undefined;
  ```
  `exchanges` oldest first; `undefined` when no completed prior exchange exists.

- [ ] **Step 1: Write failing tests:**
  - `redactSecrets` replaces: an `sk-`/`sk-or-`/`ghp_`/`AKIA…` key shape, an `Authorization: Bearer <token>` header, a `-----BEGIN … PRIVATE KEY-----` block, `API_KEY=abc123` and `password: hunter2` assignments, and a 40+ character high-entropy token; each becomes `[redacted]` and increments `count`. Near misses survive unchanged: `"the sk-ip flag"`, `"password policy"`, `"API_KEY is documented"`, a 40-character lowercase English sentence without digits.
  - `stubCodeFences`: a 42-line ```ts fence becomes `[code: ts, 42 lines]` with surrounding prose kept; no language gives `[code: text, n lines]`; an unclosed fence is stubbed to the end of the text.
  - `summarizeToolCalls(["edit","bash","edit"])` is `"edit x2, bash x1"` (first-seen order); empty gives `""`.
  - Builder: two complete turns give two exchanges, oldest first; `turns: 1` gives the newest and `omittedEarlierTurns: true`.
  - A trailing user message with no assistant reply is dropped (Review Focus 2).
  - `compaction`, `branch_summary`, `custom`, `custom_message`, `thinking_level_change` entries and `toolResult` messages are skipped without error and without their content in the output; image and `thinking` blocks are ignored (Review Focus 4).
  - Assistant text is the text blocks of the turn's last assistant message that has text; tool names come from `toolCall` blocks across the whole turn.
  - `tier` comes from `tierOf(provider, model)` of that message when `includeTiers`; absent when `tierOf` returns `undefined` or the option is off; `tools` absent when `includeToolSummary` is false.
  - Budget: newest first within `maxChars`; per-user and per-assistant caps applied; `truncated: true` when a cap or the budget cut text; earlier user text is redacted too (Review Focus 3); `redactions` totals both.
  - `tierForModel` returns the tier for a unique match, `undefined` when the model is in two tiers or unknown; reuse the pool matcher in `routing.ts` rather than reimplementing.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/conversation-context.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** to the signatures. A turn is a `user` message through the entry before the next `user` message. Per text, apply `stubCodeFences`, then `redactSecrets`, then the cap.
- [ ] **Step 4:** Run the test file. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add conversation-context.ts tests/conversation-context.test.ts
  git commit -m "feat(context): bounded, redacted conversation context builder"
  ```

---

### Task 3: Request construction for both direct backends

**Files:**
- Modify: `classifier-backends.ts` (`ClassifierRequest.context?: ConversationContext`; `ClassificationJudgment.contextSent?: boolean`)
- Modify: `classifier-semantics.ts`, `classifier-pi-native.ts` (`buildContext`, line ~93), `typesafe-classifier.ts` (`buildTypeSafeRequest`, line ~45)
- Test: `tests/classifier-pi-native.test.ts`, `tests/typesafe-classifier.test.ts`, `tests/classifier-backends.test.ts`

**Interfaces:**
- Consumes: `ConversationContext` (Task 2).
- Produces in `classifier-semantics.ts`:
  ```ts
  export const CONTEXT_INSTRUCTIONS: string;   // the single instruction constant for context-bearing requests
  export function contextState(request: ClassifierRequest & { readonly context: ConversationContext }): JsonObject;
  export function contextSummary(context: ConversationContext): { readonly turns: number; readonly chars: number; readonly redacted: boolean; readonly truncated: boolean };
  ```

- [ ] **Step 1: Write failing tests:**
  - pi-native: `request without context sends { prompt } and the unchanged instruction`; `request with context sends current_prompt, previous_exchanges, omitted_earlier_turns and CONTEXT_INSTRUCTIONS`; `nothing else is sent` (state keys exactly those three; each exchange's keys a subset of `user, assistant, tier, tools`).
  - TypeSafe: `buildTypeSafeRequest` without context keeps `state` equal to the prompt string (existing tests untouched); with context `state` deep-equals pi-native's; `questions.tier.instructions === CONTEXT_INSTRUCTIONS`.
  - `CONTEXT_INSTRUCTIONS` mentions `current_prompt`, `previous_exchanges` and the "work the assistant will perform" rule (`includes` assertions), and both backends use it verbatim.
  - A judgment returned for a context request has `contextSent: true`; for a context-free request it is absent.
  - Debug: with `debug: true` the trace for a context request contains `contextSummary` fields and none of the exchange text (sentinel string in the context).
- [ ] **Step 2:** Run the three test files. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `CONTEXT_INSTRUCTIONS` starts from the explicit probe wording above and adds one sentence naming `omitted_earlier_turns`. Add the comment `// Instruction text is policy owned by #180's compiler; keep it a single constant so #180 can take it over.` Set `contextSent: true` where the transports build `PiNativeJudgment` and `TypeSafeJudgment`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS apart from the pre-existing failure.
- [ ] **Step 5: Commit**
  ```bash
  git add classifier-backends.ts classifier-semantics.ts classifier-pi-native.ts typesafe-classifier.ts tests/classifier-pi-native.test.ts tests/typesafe-classifier.test.ts tests/classifier-backends.test.ts
  git commit -m "feat(classifier): send object state with bounded context"
  ```

---

### Task 4: Pipeline and call-site wiring

**Files:**
- Create: `conversation-options.ts`
- Modify: `classification-pipeline.ts`, `index.ts` (`buildPipeline` direct wrappers ~148 and ~168; input handler ~669; `bifrost/auto` `select` ~445; both cache-write sites ~362 and ~741), `commands.ts` (the three `classify(prompt)` call sites: benchmark/explain/preview)
- Test: `tests/pipeline.test.ts`, `tests/conversation-options.test.ts`

**Interfaces:**
- Consumes: `buildConversationContext`, `tierForModel`, `ContextOptions`, `SessionEntryLike`, `ConversationContext` (Task 2); `ContextConfig` (Task 1); `contextSummary` (Task 3).
- Produces:
  ```ts
  // classification-pipeline.ts
  export interface ClassifyOptions { readonly context?: ConversationContext }
  export interface ContextOutcome { readonly sent: true; readonly used: boolean }   // used = the returned judgment had contextSent
  // ClassificationPipeline.classify: (text, signal?, options?: ClassifyOptions)
  // "classified" and "fallback" results gain: readonly context?: ContextOutcome
  // PipelineDeps.classifyDirect gains a 4th parameter: context?: ConversationContext
  // conversation-options.ts
  export interface ClassifyOptionsSource { readonly config: BifrostConfig; readonly backend: ClassifierBackend; readonly branch?: readonly SessionEntryLike[] }
  export interface BuiltClassifyOptions extends ClassifyOptions { readonly advisoryContext?: ConversationContext }  // built but not sent: block disabled
  export function buildClassifyOptions(source: ClassifyOptionsSource, env?: Record<string, string | undefined>): BuiltClassifyOptions;
  export function shouldCacheResult(result: ClassificationResult): boolean;  // source "classifier" and no judgment.contextSent
  ```

- [ ] **Step 1: Write failing tests.** `tests/conversation-options.test.ts`:
  - `block absent or disabled sets no context but sets advisoryContext when a prior exchange exists`
  - `enabled with backend pi-native and a two-turn branch sets context with 2 exchanges`
  - `enabled with backend typesafe sets context`; `enabled with backend prompt sets none`
  - `no prior exchange sets none` (Review Focus 1)
  - `PI_SUBAGENT_RUN_ID set sets none` (Review Focus 7)
  - `tiers come from the configured pools` (a branch whose assistant model is in exactly one pool gets that tier).
  `tests/pipeline.test.ts` (new `describe("context")`, existing `deps()` helper):
  - `context is passed to classifyDirect` (spy receives the same object); `a returned judgment has contextSent` is asserted at the transport level in Task 3, here the fake returns `{..., contextSent: true}` and the result carries `context: { sent: true, used: true }`
  - `cache lookup is skipped when context is present`; `cache lookup still runs without context`
  - `context-fed miss falls through to the default tier and reports used: false` (Review Focus 5)
  - `a classifier answer is not changed by exchange tiers`: context exchange tier `planner`, fake answers `worker`, result tier `worker` (Review Focus 6)
  - `shouldCacheResult is false for a judgment with contextSent` and true for a plain classifier result.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/pipeline.test.ts tests/conversation-options.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Pipeline: thread `options.context` to `classifyDirect`; skip `cacheLookup` when `options?.context` is set; attach `context: { sent: true, used: Boolean(judgment?.contextSent) }` to classified/fallback results when context was provided. Existing behavior without options is untouched.
  - `buildClassifyOptions`: gate on `config.classifier?.context`, direct backend, no `PI_SUBAGENT_RUN_ID`; build with `buildConversationContext` using config values or the Task 1 defaults and `tierForModel(config.models, ...)`; when disabled build `advisoryContext` only if a prior exchange exists.
  - `index.ts`: the two direct wrappers become `async (text, availableTiers, signal, context) => classify({ prompt: boundedClassifierPrompt(text), tiers: availableTiers, criteria, ...(context ? { context } : {}) }, signal)`; both call sites pass `buildClassifyOptions({ config: state.config, backend: effectiveBackendOf(...).backend, branch: ctx.sessionManager.getBranch() })` (strip the `advisoryContext` field before calling `classify`); both cache-write sites use `shouldCacheResult`.
  - `commands.ts`: the three call sites pass the same options; preview additionally gets `advisoryContext` for reporting (Task 5).
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS apart from the pre-existing failure.
- [ ] **Step 5:** Live check with `pi` (synthetic prompts only), `context.enabled: true`, Jev via the configured route: send a prompt that elicits a plan, then `Approved`; confirm via `/bifrost preview --json "Approved"` that a tier is returned and context was sent.
- [ ] **Step 6: Commit**
  ```bash
  git add conversation-options.ts classification-pipeline.ts index.ts commands.ts tests/pipeline.test.ts tests/conversation-options.test.ts
  git commit -m "feat(routing): pass conversation context to direct classifiers"
  ```

---

### Task 5: Visibility, docs and disclosure

**Files:**
- Modify: `commands.ts` (`renderPreviewReport`, the preview report type near line 663, status text), `index.ts` (`[bifrost] classify:` stderr line and `bifrost/auto` log line), pipeline debug calls
- Modify: `docs/guide/classifiers.md`, `docs/guide/commands.md`, `docs/guide/prompt-caching.md`, `docs/guide/configuration.md`, `CHANGELOG.md` (Unreleased)
- Test: `tests/bifrost-commands.test.ts`, `tests/docs-command-drift.test.ts` (must pass)

**Interfaces:**
- Consumes: `ContextOutcome` and `BuiltClassifyOptions` (Task 4), `contextSummary` (Task 3).
- Produces: preview JSON gains `context?: { sent: boolean; advisory: boolean; used?: boolean; turns: number; chars: number; redacted: boolean; truncated: boolean }`; the text report gains a `context:` line; `/bifrost status` shows `context: on|off` and, when on, the phrase "sent to the classifier provider".

- [ ] **Step 1: Write failing tests** (existing preview test style): `preview --json includes context with sent true, turns and chars`; `preview with the block disabled reports advisory: true and sent: false`; `preview text shows "context: 2 exchanges, 1,840 chars (sent)"`; `a context-fed miss shows "classified without usable context"`; `output and debug contain none of the sentinel text placed in the branch`; `status shows context on and the disclosure phrase`.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/bifrost-commands.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the report fields and text; add `debug("pipeline", "context", {...})` with counts and flags only, no text.
- [ ] **Step 4:** Docs: `classifiers.md` states what is sent, what is never sent, that enabling the block sends assistant text to the classifier provider, redaction, the cache consequence, how to disable, and the role-based criteria example; `prompt-caching.md` states context-fed calls bypass the cache. Run `npm test && npm run typecheck && npm run test:ui && npm run test:ui:reliability`. Expected: PASS apart from the pre-existing failure.
- [ ] **Step 5: Commit**
  ```bash
  git add commands.ts index.ts classification-pipeline.ts docs/guide CHANGELOG.md tests/bifrost-commands.test.ts
  git commit -m "feat(preview): report conversation context and document it"
  ```

*Product PR ends here. Paste the verification block and a reverted-guard run (remove the context pass-through in `index.ts`, show the Task 4 and 5 tests go red, restore).*

---

### Task 6: Evaluation corpus and release guard

**Files:**
- Modify: `scripts/jev-benchmark.ts` (scenario type, arms, report), `tests/jev-benchmark.test.ts`
- Create: `tests/corpus/jev/multi-turn.*` in the format the existing corpus files use (read `tests/corpus/jev` first and match it)
- Results go in the PR description as aggregates only, never prompt text.

**Interfaces:**
- Consumes: `ConversationContext`, `ExchangeContext` (Task 2).
- Produces: scenario field `context?: { exchanges: ExchangeContext[]; previousTier?: string }`; three arms (prompt only; retain-incumbent baseline, evaluation only, answers `previousTier`; prompt plus context); per-family accuracy, under-routing, over-routing, miss rate, confidence distribution of context-fed answers, and requests whose decisive text falls beyond the input bound.

- [ ] **Step 1: Write failing tests** in `tests/jev-benchmark.test.ts`: scenario parsing accepts `context`; the baseline arm answers the previous tier; the context arm sends context through the fake classifier; the report lists families separately, includes the confidence distribution, and contains no scenario text.
- [ ] **Step 2:** Run `node --test --experimental-strip-types tests/jev-benchmark.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then author the **synthetic** corpus with a gold tier (the tier of the work triggered), rationale and ambiguity note per scenario. Families: approvals after a plan, approvals after a small fix, bare numbers and option letters, "Fix it.", "Continue.", "Use the second approach.", "try again", a short new task after a trivial turn, a short new task after a heavy turn, ordinary single-turn prompts. At least 8 scenarios per family. No real session text.
- [ ] **Step 4:** Record the **release guard before running anything**, in the PR description: arm 3 must not be less accurate than arm 1 on the single-turn families and must be more accurate than arms 1 and 2 on the context-dependent families; record the exact margin. Then run the paid benchmark (authorized: `pi` with the OpenRouter Jev route and account credits; synthetic corpus text only). Sweep `turns`, `maxChars` and two instruction wordings, and report the confidence distribution.
- [ ] **Step 5:** Repeat the object-`state` probe against the direct `api.typesafe.ai/v1/systemone` endpoint (`jev-1.13.0`) with synthetic content, via a throwaway script outside the repo. If the direct endpoint rejects object `state`, stop and report to the owner.
- [ ] **Step 6: Commit**
  ```bash
  git add scripts/jev-benchmark.ts tests/jev-benchmark.test.ts tests/corpus/jev
  git commit -m "test(jev): multi-turn context corpus and three-arm report"
  ```

---

### Task 7: Release notes and upstream communication

- [ ] **Step 1:** Update `CHANGELOG.md`: opt-in conversation context for direct classifier backends, the disclosure sentence, the cache consequence.
- [ ] **Step 2:** After implementation is done and PRs are open, draft comments for upstream #161, #179 and #180 (problem statement, probe findings, evaluation results, no project specifics). **Show them to the owner; post only on approval.**

## Self-review

- **Spec coverage:** what is sent, request shape, treatment, redaction → Tasks 2-3; config and defaults → Task 1; behavior (direct only, returned judgment decides, miss falls through, precedence, subagents, both call sites) → Task 4; cache bypass → Task 4; visibility, disclosure, stage-criteria example → Task 5; evaluation, release guard, direct-endpoint check, retain-incumbent baseline → Task 6; governance and delivery → Preconditions and Task 7. Dropped by design: floor, bare-reply test, `order`, incumbent, `continuation` source.
- **Type consistency:** `ConversationContext`, `ExchangeContext`, `ContextOptions`, `ClassifyOptions`, `ContextOutcome`, `contextSent`, `BuiltClassifyOptions` are defined once (Tasks 2, 3, 4) and used under those names afterwards.
- **No path reads the previous tier for a decision:** enforced by Review Focus 6 and the Task 4 test.
