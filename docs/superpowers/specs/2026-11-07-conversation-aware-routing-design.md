# Conversation-Aware Routing

Status: draft for review (revision 1)
Date: 2026-11-07
Branch: `docs/conversation-aware-routing` (fork: `hiemalis-at/pi-bifrost`)

All line numbers refer to the files at commit `7477577` (`main`, v0.5.0).

This document designs two related changes. **Part A** is a small, deterministic
mechanism. **Part B** is an experiment-first change with a possible follow-up.
Neither is approved for implementation: `AGENTS.md` requires an approved ADR
before behavior changes, and this document does not draft one (see
[Governance](#governance)).

## Problem

Bifrost classifies every eligible user prompt from the prompt text alone.
Workflows that are driven by short replies ("Approved", "yes", "looks right",
"continue", "try again", a lone option number) therefore get a tier that
describes the reply, not the work the reply triggers.

Those replies are often the most consequential turns in a session. The model
selected at input handles the whole agent turn that follows, including tool
calls. A reply that starts "write the plan", "dispatch the subagents" or "open
the PR" can run on the cheapest tier because the text of the reply is trivial.

### Evidence

Measured with `/bifrost preview` on one developer's real session history
(three consecutive sessions on one project, 24 distinct prompts). Aggregate
numbers only; no prompt text is recorded here. This is indicative, not a
benchmark: one user, one project, a small sample.

| Class | Count | Result with the pi-native/Jev classifier and a 0.7 confidence floor |
|---|---|---|
| Short prompts (60 characters or fewer) | 14 | 9 routed to the cheapest tier, 5 fell back to the default tier, none routed higher |
| Of the 9 cheapest-tier results | 9 | confidence 0.71 to 0.99, four of them at 0.96 or above |

Two facts follow.

1. The classifier is not wrong about the text. A bare approval really is
   trivial text, and Jev says so confidently. Raising `minConfidence` cannot fix
   this: it would only catch the 0.71 to 0.75 results.
2. Editing the tier criteria text can steer bare replies to a middle tier (it
   did in a trial), but it cannot know the task state. The same "yes" after a
   trivial turn and after an architecture turn gets the same tier.

### Related defects this design must respect

- `normalize()` in `cache.ts:31` discards word order, and the fuzzy cache
  (`cache.ts:138`, `cache.ts:214`, default threshold 0.85, default retention 30
  days) can return one prompt's tier for a different prompt. A cached bare
  reply keeps its tier regardless of conversation state. Upstream issue #179
  tracks the cache's correctness defects.
- The cache identity must stay a single scheme. #179 and #180 both own it. This
  design adds no second fingerprint.

## Goals

- A bare reply should not route below the tier of the work in progress, unless
  the user says so.
- Every effect is visible in `/bifrost preview`, status and decision traces,
  with its reason.
- Every effect can be disabled, bypassed with an inline tier word, or defeated
  by `/bifrost pin`.
- Part A needs no network request, no extra latency and no new dependency.
- Part B is decided by measurement. A comparison against Part A and against
  today's behavior decides whether it ships.

## Non-goals

- Summarizing or remembering the whole conversation.
- Re-routing in the middle of a turn. Tool continuations and retries keep the
  model that started the turn.
- Replacing the classifier, adding a learned scorer, or adding a second routing
  resolver.
- Session-level stickiness. That is ADR 0019 (proposed); see
  [Relationship to existing work](#relationship-to-existing-work).

## Anti-goals

These make the work a failure even if every test passes.

- A turn that triggers heavy work silently runs on a cheap model because the
  user typed a short reply.
- Repository content, tool output or file contents reach an external
  classifier without explicit opt-in and a documented bound.
- Context-dependent classifications are written to the fuzzy cache and reused
  in a different context.
- The router becomes harder to explain than "selected model, source, exclusions,
  fallback, override".

## Product gate

`docs/product-philosophy.md` asks five questions before a feature is approved.

| Question | Part A: continuation tier | Part B: context-fed classification |
|---|---|---|
| User value | Chooses better: bare replies stop undershooting. | Chooses better for replies that need more than the previous tier to judge ("Use the second approach"). |
| Explicit policy | `classifier.continuation` config block, disabled by default. | `classifier.context` config block, disabled by default. |
| Visibility | New `continuation` source in preview, status and trace, with the incumbent tier and the reason. | Preview and trace state whether context was sent and its size, never its content. |
| Override | Inline tier word, `/bifrost pin`, `enabled: false`. | Same, plus `enabled: false`. |
| Proof | Deterministic pipeline and qualification tests (below). | Offline corpus evaluation first; ships only if it beats Part A by a margin fixed beforehand. |

The repo's escalation ladder applies (`explicit configuration → observable
signal → advisory recommendation → explicit opt-in → bounded automation`).
Phase 1 of Part A is advisory: preview and trace report what continuation
*would* do before the opt-in changes a route.

## Relationship to existing work

| Item | Relationship |
|---|---|
| ADR 0019, session-sticky routing (proposed) | Complementary. 0019 keeps the first prompt's model for the whole session until an explicit instruction. Part A stays in adaptive mode: substantive prompts are still re-classified, and only bare replies inherit. The two can be combined, and sticky mode would simply never reach Part A. |
| #179, cache semantic safety | Must land first, or be coordinated. Part A's cache rule (below) is a narrow instance of the same principle. If #179 changes the cache API, Part A follows it. |
| #180, compiled classification policy | Owns the classifier instruction text and its identity. Part B's changed instruction text goes through #180's compiler, not a new constant. |
| #161, context-aware classification evaluation | Part B's first phase is this experiment. This design adopts #161's acceptance criteria, including the retain-incumbent baseline, the privacy rule, truncation reporting and sticky/override precedence. |
| #160, #157 (listed blockers of #161) | Part B's evaluation harness should reuse #157's paired runner if it exists by then. |

## Part A: continuation tier

### Behavior

For a prompt that qualifies as a *bare reply*, the tier is derived from the
tier of the work in progress (the *incumbent*) instead of from the reply text
alone.

Two modes, chosen explicitly:

- **`inherit`**: the reply's tier is the incumbent tier. No classifier call.
- **`floor`**: the reply is classified as usual, and the result is the higher of
  the classifier tier and the incumbent tier. If the classifier misses, the
  incumbent tier is used (never the default tier).

`floor` guards both failure directions: an "Approved" after a heavy turn cannot
undershoot, and a short but genuinely new, harder request after a trivial turn
("refactor it", "design the schema") is not pinned to trivial. `inherit` is
cheaper and simpler but can undershoot in the second case. **Recommendation:
`floor`** (my call; see [Open questions](#open-questions)).

`floor` needs a total order over tiers. The order of keys in `models` is not a
contract (merged layers and bundled defaults change it, see upstream issue
#199), so the order is explicit:

```json
"classifier": {
  "continuation": {
    "enabled": false,
    "mode": "floor",
    "order": ["trivial", "light", "heavy", "critical"],
    "maxChars": 40,
    "maxWords": 6
  }
}
```

### What qualifies as a bare reply

A deterministic, language-independent test on the trimmed prompt (the same
text the classifier would see after the inline-override strip at
`index.ts:612`):

- at most `maxChars` characters and at most `maxWords` whitespace-separated
  words;
- a single line, with no code fence, URL or path-like token (contains `/` or `\`
  between non-space characters).

No word lists (they would be English-only). The test is intentionally broad: a
short imperative like "fix it" qualifies, and that is correct, because it refers
to something earlier in the conversation. The cost of over-qualifying is bounded
by `floor` mode.

Qualification applies only when an incumbent exists. With no incumbent (a fresh
session or a resumed one), behavior is exactly today's.

### Incumbent

The final tier of the previous dispatched turn in this session, including a tier
lifted by `floor`. It is stored next to `pinned` in `runtime-state.ts:12`:
session-local, ephemeral, never persisted, and not inherited by subagent
sessions (`PI_SUBAGENT_RUN_ID`, see `index.ts:592`). A substantive prompt
resets it to that prompt's own tier, which can be lower. That is the only way the
incumbent decays.

### Where it sits in the pipeline

`classification-pipeline.ts:73` currently runs: direct-model regex pre-check
(`:74`), cache (`:88`), direct classifier (`:97`), prompt classifiers (`:114`),
regex tier rules (`:135`), default (`:152`). Precedence for a prompt becomes:

1. inline tier word (`index.ts:612`) and `/bifrost pin` (`index.ts:601`),
   unchanged and still highest;
2. direct-model regex rules (`:74`), unchanged: a destructive-command rule must
   beat inheritance;
3. **continuation** (new): qualification, then `inherit` or `floor`;
4. cache, direct classifier, prompt classifier, regex tier rules, default,
   unchanged.

In `floor` mode stage 3 wraps stages 4 onward: it runs them as today, then
applies the max. In `inherit` mode it short-circuits them.

Both call sites share `pipeline.classify`: the physical-selection input handler
(`index.ts:669`) and the `bifrost/auto` dispatcher (`index.ts:445`). The
incumbent must be maintained and read on both paths.

### Cache rule

Results with source `continuation` are never written to the cache. A bare reply
never reads from the cache while `continuation.enabled` is true, because a
cached tier for "Approved" is a tier for a different conversation state. This is
my call and is the same principle #179 pursues; if #179 lands a stricter rule,
that rule wins.

### Visibility

- `ClassificationResult` gains the source `continuation` and carries the
  incumbent tier, the mode and the reason: bare reply, length, word count.
- `/bifrost preview` prints the same, and `--json` includes them. Preview runs
  inside the live session, so it can report the real incumbent.
- Status and decision traces (ADR 0007) show the source. With
  `enabled: false` but a phase-1 advisory flag, preview and trace report what
  continuation would have chosen without changing the route.

### Edge cases

| Case | Behavior |
|---|---|
| Incumbent tier has no healthy candidate | Existing tier fallback and reliability rules apply unchanged. |
| Incumbent tier no longer exists in config (reload) | Treated as no incumbent. |
| `order` missing a configured tier | Config validation error naming the tier, at load. `floor` never silently ignores a tier. |
| Queued prompts while streaming (`event.streamingBehavior`) | Follow the existing virtual-auto and input handling; the incumbent is the last *dispatched* turn, not a queued one. |
| Session resume | No incumbent until the first dispatch. |
| Consecutive bare replies | Each inherits the incumbent. Cost can stay high for a long session of approvals; a decay limit is an open question. |

### Config, schema and docs

Additive config only. `schema.json`, `bifrost.json` defaults, `examples/`,
`docs/guide/configuration.md`, `docs/guide/classifiers.md` and init behavior
change together (`AGENTS.md`, "Change discipline"). The default stays
`enabled: false`, so existing configs behave identically.

## Part B: context-fed classification

### Hypothesis

Some replies cannot be judged from the previous tier alone ("Use the second
approach", "Fix it" after a long analysis). Giving the classifier the previous
assistant message lets it judge the work being triggered. This is a hypothesis.
Nothing in this repo shows that the TypeSafe classifier makes good use of extra
state.

### What the code allows

- `ClassifierContext.state` is typed `JsonObject` in the Pi AI types. The
  pi-native backend sends `{ prompt }` (`classifier-pi-native.ts:96-100`), so
  adding fields is a local change.
- The direct TypeSafe backend sends `state: input.prompt` as a string
  (`typesafe-classifier.ts:45-49`). Whether that endpoint accepts an object must
  be verified before it is a target. Part B starts with pi-native.
- The question text ("Which model tier best fits this coding-agent request?") is
  fixed in both builders. Telling the classifier how to use context needs new
  instruction text, which belongs to #180's compiler, and changes the cache
  identity.
- Prompt text is bounded to 16,000 characters
  (`classifier-semantics.ts:8-10`).
- Extensions can read history through `ctx.sessionManager.getBranch()`
  (`ReadonlySessionManager` in the Pi coding-agent types).

### Phase B0: evaluation (no product change)

Follow #161. Build a **synthetic** multi-turn corpus, extending the scenario
format in `scripts/jev-benchmark.ts` and `tests/corpus/jev` with a `context`
field: a short synthetic previous assistant message, and the previous tier.
Families include approvals, bare numbers and option letters, "Fix it.",
"Continue.", "Use the second approach.", "try again", a short new task after a
trivial turn, and a short new task after a heavy turn. Gold tier is the tier of
the *work triggered*, with a rationale and an ambiguity note, as the existing
corpus does.

Three arms:

1. today (prompt only);
2. Part A (`inherit` and `floor`);
3. prompt plus context.

Report per family: accuracy, under-routing (gold higher than chosen) and
over-routing (gold lower than chosen), and the classifier-miss rate on
context-dependent requests separately from ordinary low confidence. Report
requests whose decisive text falls beyond the input bound instead of describing
coverage as complete.

Constraints from #161 apply: no prompt text or repository content in committed
artifacts, offline except where paid evaluation is explicitly authorized, and
sticky/override precedence unchanged during the experiment.

**Decision rule:** set the margin by which arm 3 must beat arm 2 before running
anything, record it in the PR, and ship B1 only if arm 3 clears it on the
families where arm 2 fails.

### Phase B1: opt-in context (only if B0 clears the margin)

```json
"classifier": {
  "context": {
    "enabled": false,
    "previousAssistantChars": 600,
    "includePreviousTier": true
  }
}
```

Rules:

- **What is sent:** only the final text of the previous assistant message,
  truncated to `previousAssistantChars`, and optionally the previous tier. Never
  tool results, file contents or earlier turns; that is where repository
  content lives. Code fences are replaced with a placeholder (my call).
- **Where:** direct backends only, starting with pi-native. The prompt backend
  does not receive context.
- **Opt-in and disclosure:** disabled by default, and the guide states plainly
  that assistant text leaves the machine for the classifier provider.
- **Cache:** when context was sent, the fuzzy cache is bypassed for both read
  and write, or keyed on a context hash under #179's scheme.
- **Visibility:** preview and trace report that context was sent and its length,
  never its content. Debug output must not persist it (the existing TypeSafe
  debug rule: raw prompts and bodies are never persisted).
- **Failure:** a classifier miss falls through exactly as today, with Part A
  applied if enabled.

## Testing

Deterministic, per `AGENTS.md`: fake registry and fake classifier, no live
providers.

Part A:

- table-driven qualification tests: boundaries of `maxChars` and `maxWords`,
  multi-line, code fence, URL, path, non-English replies, empty string;
- pipeline tests (`tests/pipeline.test.ts` style): `inherit` with a missing
  classifier; `floor` where the classifier is lower, equal and higher than the
  incumbent; classifier miss in `floor`; no incumbent;
- precedence tests: inline tier word, pin, direct-model rule, then continuation;
- cache tests: a `continuation` result is never stored, and a bare reply never
  reads the cache while enabled;
- both call sites: physical input handler and `bifrost/auto`
  (`tests/dispatch-ownership.test.ts` style);
- config tests: `order` validation, unknown tier, schema agreement
  (`tests/schema.test.ts`), docs drift (`tests/docs-command-drift.test.ts`);
- reverted-guard run showing the new assertions go red, plus `npm test` and
  `npm run typecheck` output in the PR.

Part B: the B0 corpus and its runner are the test. B1 adds fake-registry tests
that the request carries the bounded context, that nothing else is sent, and
that the cache is bypassed.

## Delivery order

1. Comment on upstream #161 and #179 with the evidence and the proposed
   direction; wait for maintainer reaction before opening code.
2. Land or track #179. Open the Part A ADR (proposed).
3. Part A phase 1 (advisory: preview and trace only), then phase 2 (opt-in
   routing effect).
4. Part B0 (corpus and runner; no product change).
5. Part B1 only if B0 clears its margin, with its own ADR.

Each step is its own PR with Conventional Commit messages. The fork
(`hiemalis-at/pi-bifrost`) carries the work until upstream agrees.

## Governance

`AGENTS.md`: "proposed ADRs are not implementation approval", and ADR drafts
are not committed unless requested. This document is a design, not an ADR.
Part A and Part B each need an ADR (next free number, assigned upstream) before
product code.

## Risks

| Risk | Mitigation |
|---|---|
| Over-routing: a long session of approvals stays on an expensive tier | Opt-in; visible source in status; decay limit as an open question. |
| Under-routing in `inherit` mode after a trivial turn | Recommend `floor`. |
| Privacy: assistant text sent to a classifier provider | Part B only, opt-in, bounded, no tool output, no persistence. |
| Cache serves a stale or wrong-context tier | Never cache continuation or context results. |
| Incumbent leaks across sessions or subagents | Session-local, ephemeral, excluded for subagent runs. |
| Config order drift between layers | Explicit `order`, validated at load. |
| Evidence is one user's history | B0 uses a synthetic public corpus and a pre-set decision margin. |

## What stays unchanged

Physical selection before generation; no prompt replay; persisted reliability
state; no model IDs in defaults; the default footer; classifier choices limited
to configured tiers; classification cache never storing model answers.

## Open questions

These need an owner decision. Items marked with a recommendation are my calls
until confirmed.

1. **Default state.** Recommendation: both blocks ship disabled; a user's own
   config enables them.
2. **Mode.** Recommendation: `floor` as the documented mode, with `inherit`
   available. Is `inherit` worth shipping in v1 at all?
3. **Tier order.** Recommendation: explicit `order` list. Alternative: derive
   from `models` key order, which is fragile.
4. **Bare-reply thresholds.** 40 characters and 6 words are my starting guess,
   to be tuned on the B0 corpus.
5. **Decay.** Should consecutive bare replies lose the incumbent after N turns,
   or only a substantive prompt resets it?
6. **Cache exclusion scope.** Should bare replies be excluded from the fuzzy
   cache regardless of the continuation flag? That is arguably #179's scope.
7. **Privacy appetite for Part B.** What may be sent (previous assistant text
   only, or also the previous tier and turn count), and is redaction beyond
   code-fence removal required?
8. **Upstream or fork-only.** Pursue the comments and PRs in the delivery order,
   or keep this as a private direction in the fork?
