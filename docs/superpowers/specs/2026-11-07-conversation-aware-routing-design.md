# Conversation-Aware Classification

Status: draft for review (revision 4: continuation floor removed, single feature)
Date: 2026-11-07
Branch: `docs/conversation-aware-routing` (fork: `hiemalis-at/pi-bifrost`)
Upstream: `iamaamir/pi-bifrost`

All line numbers refer to the files at commit `7477577` (`main`, v0.5.0).

This document designs one change: the direct classifier (Jev) decides on the
exchange so far, not on the current prompt alone. It is not approved for
implementation: `AGENTS.md` requires an approved ADR before behavior changes
(see [Governance](#governance)).

Revision 3 had a second part, a "continuation floor" that kept a bare reply at
the tier of the previous turn. The owner rejected it (see
[Owner decisions](#owner-decisions)) and revision 4 removes it. The reasoning is
kept in [What was dropped, and why](#what-was-dropped-and-why).

## Owner decisions

| # | Decision |
|---|---|
| 1 | The feature is **opt-in** (`enabled: false` by default), per repo etiquette. The owner still considers Bifrost broken for their workflows while Jev can only judge the current prompt, so the feature itself is the goal; only the default is opt-in. |
| 2 | **No tier floor and no tier inheritance** (revision 4). Keeping the previous turn's tier is the wrong behavior: after a planning turn it keeps the expensive model on the execution that follows. The classifier must judge the work a turn will do, not the tier the last turn ran on. |
| 3 | Jev's confidence is trusted. A returned judgment (which already met `minConfidence`) decides. There is one `classifier.minConfidence`, no second threshold. |
| 4 | Cache handling for short replies is #179's scope ([#179](https://github.com/iamaamir/pi-bifrost/issues/179)). |
| 5 | Send as much conversation context as possible while staying security-sensible. The more Jev can weigh, the better. Context specifics (3 exchanges, 6,000 characters, tool summaries, code-fence stubs, redaction) accepted. |
| 6 | Pursue upstream: ADR first, then an issue to get the maintainer's reaction. Implementation happens in the fork regardless. |

## Problem

Bifrost classifies every eligible user prompt from the prompt text alone. That
cannot tell what **stage** of the work a turn is in.

Agent work alternates between planning and orchestration, where a strong model
pays off, and execution, where a cheaper model usually suffices. A strong
planning model rarely should also do the coding as an agent. The prompt text
does not say which stage a turn is in; the conversation does.

The clearest symptom is short replies ("Approved", "yes", "continue", "try
again", a lone option number). They are often the most consequential turns of a
session, because the model selected at input runs the whole agent turn that
follows, tool calls included. The same "Approved" can mean "start executing the
plan" or "ship the one-line fix", and nothing in its text says which.

More generally, any prompt that only makes sense given earlier turns ("do the
same for the other module", "use the second approach") is classified blind.

### Evidence

Reported from sustained real use by the author, not from a benchmark:

1. Short replies that approve or continue earlier work were routinely
   classified into the cheapest tier, with high confidence, including when the
   work they started was the most consequential of the session. The classifier
   is not wrong about the text. Raising `minConfidence` cannot fix this.
2. Editing the tier criteria text can steer bare replies to a middle tier, but
   it cannot know the task state. The same "yes" after a trivial turn and after
   an architecture turn gets the same tier.

A small live check on synthetic text is recorded in the
[implementation plan](../plans/2026-11-07-conversation-aware-routing.md):
object `state` is accepted by Jev, and whether Jev uses the history depends on
the instruction text. Quantified evidence is deliberately left to the
evaluation.

### Related defects this design must respect

- `normalize()` in `cache.ts:31` discards word order, and the fuzzy cache
  (`cache.ts:138`, `cache.ts:214`, default threshold 0.85, default retention 30
  days) can return one prompt's tier for a different prompt. A cached short
  reply keeps its tier regardless of conversation state. Upstream issue
  [#179](https://github.com/iamaamir/pi-bifrost/issues/179) tracks the cache's
  correctness defects.
- The cache identity must stay a single scheme. #179 and
  [#180](https://github.com/iamaamir/pi-bifrost/issues/180) both own it. This
  design adds no second fingerprint.

## Goals

- Jev sees what was already done, said and exchanged, and decides the tier of
  the work the turn will do.
- Users can express "strong model plans, cheaper model executes" in
  configuration, through tier criteria written by role (see
  [Expressing stages](#expressing-stages-in-configuration)).
- Every effect is visible in `/bifrost preview`, status and decision traces.
- Every effect can be disabled, bypassed with an inline tier word, or defeated
  by `/bifrost pin`.
- Nothing secret leaves the machine because context is sent. The context is
  bounded, redacted and reported (size, never content).

## Non-goals

- Summarizing or remembering the whole conversation.
- Re-routing in the middle of a turn. A prompt that asks for planning and
  implementation in one turn still runs on one model. That is
  [#160](https://github.com/iamaamir/pi-bifrost/issues/160)'s territory
  (execution-stage classification) and is not solved here.
- Replacing the classifier, adding a learned scorer, or adding a second routing
  resolver.
- Any rule that derives a tier from the previous turn's tier (no floor, no
  inheritance, no stickiness). Session-level stickiness is ADR 0019.
- Sending tool results, file contents or raw tool arguments to any classifier.

## Anti-goals

These make the work a failure even if every test passes.

- A tier chosen because the previous turn used it, so that planning-tier cost
  follows the session into execution.
- Repository content, tool output, file contents or credentials reach an
  external classifier.
- Context-dependent classifications are written to the fuzzy cache and reused
  in a different context.
- An effect the user cannot see, explain or switch off in one step.
- The router becomes harder to explain than "selected model, source, exclusions,
  fallback, override".

## Product gate

`docs/product-philosophy.md` asks five questions before a feature is approved.

| Question | Answer |
|---|---|
| User value | Chooses better: Jev judges the work a reply triggers, not the reply text. |
| Explicit policy | `classifier.context` config block, disabled by default. Stage intent is expressed in the user's own tier criteria. |
| Visibility | Preview and trace state whether context was sent, how many exchanges, its size, and what was redacted or elided, never its content. |
| Override | Inline tier word, `/bifrost pin`, `enabled: false`. |
| Proof | Deterministic request-shape, redaction and cache tests; an offline multi-turn corpus evaluation with a release guard fixed beforehand. |

The escalation ladder (`explicit configuration → observable signal → advisory
recommendation → explicit opt-in → bounded automation`) is respected: the block
ships disabled, and with it disabled, preview and trace can still report what
context would have been sent (size only).

## Relationship to existing work

| Item | Relationship |
|---|---|
| ADR 0019, session-sticky routing (proposed) | Complementary. 0019 keeps the first prompt's model for the whole session; this design stays in adaptive mode. Sticky mode never reaches the classifier after the first prompt. |
| [#179](https://github.com/iamaamir/pi-bifrost/issues/179), classifier cache semantic safety | Must land first, or be coordinated. It owns whether short replies are excluded from the fuzzy cache regardless of this feature. This design only guarantees that context-fed calls bypass the cache. |
| [#180](https://github.com/iamaamir/pi-bifrost/issues/180), compiled classification policy | Owns the classifier instruction text and its identity. The context instruction goes through #180's compiler, not a new constant. |
| [#161](https://github.com/iamaamir/pi-bifrost/issues/161), context-aware classification evaluation | The evaluation phase is this experiment. This design adopts #161's acceptance criteria, including the retain-incumbent baseline (as an evaluation arm only), the privacy rule, truncation reporting and sticky/override precedence. #161 frames the work as an evaluation; the owner needs a shipping, opt-in change. That difference must be raised with the maintainer first. |
| [#160](https://github.com/iamaamir/pi-bifrost/issues/160), [#157](https://github.com/iamaamir/pi-bifrost/issues/157) | #160 is the mid-turn counterpart (non-goal here). #157's paired runner should be reused by the evaluation if it exists by then. |

## Design

### What the code allows

- `ClassifierContext.state` is typed `JsonObject` in the Pi AI types. The
  pi-native backend sends `{ prompt }` (`classifier-pi-native.ts:96-100`), so
  adding fields is a local change.
- The direct TypeSafe backend sends `state: input.prompt` as a string
  (`typesafe-classifier.ts:45-49`). **Verified against the TypeSafe docs:
  `state` accepts a string, a JSON object or a JSON array.** The OpenAPI schema
  for `POST /v1/systemone` types `state` as `anyOf` string, object, array. Both
  direct backends therefore get the same object state. Limits of this
  verification: the documented request examples all pass a string, and the docs
  give no key or nesting limits. A live check through Pi's registry accepted an
  object; the direct endpoint is checked before release.
- The docs describe referencing parts of an object state from the question's
  `instructions` with backticked dot paths. This is a prompt convention; the
  docs do not say whether the server resolves the paths. The design uses named
  keys and says in the instruction text which key is the current prompt and
  which is history.
- The question text ("Which model tier best fits this coding-agent request?") is
  fixed in both builders. Telling the classifier how to use context needs new
  instruction text, which belongs to #180's compiler.
- Prompt text is bounded to 16,000 characters
  (`classifier-semantics.ts:8-10`). Context has its own budget.
- Extensions can read history through `ctx.sessionManager.getBranch()`
  (`ReadonlySessionManager` in the Pi coding-agent types).

### What is sent

The goal is to maximize what Jev can weigh without sending repository content or
secrets. The specifics are accepted by the owner.

Sent, newest first, within one character budget:

- the **current prompt** (as today);
- the last **N exchanges** (default 3): the user's prompt and the assistant's
  final text for each turn;
- the **tier each of those turns ran on**, derived by matching the assistant
  message's model against the configured pools (omitted when ambiguous). This
  is information for Jev, never an input to a tier rule;
- per turn, a **tool activity summary**: tool names and counts only, for
  example "edit x4, bash x2, subagent x1". No arguments, no results, no paths.
  This tells Jev whether the previous turn planned (reads, questions) or
  executed (edits, commands).

Never sent: tool results, file contents, tool arguments, system prompts,
reasoning blocks, attachments or images, anything from a parent session.

Treatment:

- **Code fences** in assistant text become a stub carrying language and line
  count (`[code: ts, 42 lines]`). Prose around them stays.
- **Redaction:** a pattern scrub on all sent text: provider API key shapes,
  `Authorization` headers, private key blocks, `.env`-style `NAME=value`
  assignments with secret-like names, and long high-entropy tokens become
  `[redacted]`. Applies to earlier user prompts as well as assistant text.
- **Budget:** `maxChars` total (default 6,000), per-assistant cap 2,000
  characters, per-user cap 1,000, filled newest first. When something is
  dropped, `omitted_earlier_turns` is true, so Jev does not treat the window as
  the whole conversation.
- **Trailing user message:** an unanswered final user message in the branch is
  the current prompt and is never sent as a previous exchange.

Request shape (identical for `pi-native` and direct TypeSafe):

```text
state = {
  current_prompt,
  previous_exchanges: [{ user, assistant, tier?, tools? }],
  omitted_earlier_turns
}
```

Without context (feature disabled, first turn of a session, subagent session,
prompt backend) the request is byte-identical to today's.

Config:

```json
"classifier": {
  "context": {
    "enabled": false,
    "turns": 3,
    "maxChars": 6000,
    "includeToolSummary": true,
    "includeTiers": true
  }
}
```

### Expressing stages in configuration

"Strong model plans, cheaper model executes" is policy, so it lives in the
user's tier criteria, not in code. With context, criteria written by role let
Jev map "approve the plan" to the execution tier. The guide gets an example:

```json
"criteria": {
  "planner": "Planning, design, orchestration, review and decisions between options. Not carrying out an agreed plan.",
  "worker":  "Carrying out an agreed plan: implementation, edits, tests, mechanical follow-through. Not choosing between designs."
}
```

The context instruction tells Jev to judge the work the assistant will perform
as a result of the current prompt, not the length of the prompt. When the prompt
is a short reply, that work is whatever the most recent exchange proposed or
asked to do.

### Behavior

- Context is sent to the direct classifier only, on every classification while
  enabled (not only for short prompts: the owner wants Jev to weigh as much as
  is sensible).
- A returned judgment decides. There is no floor and no inheritance.
- When the classifier misses (error, invalid answer, or below
  `classifier.minConfidence`) the pipeline falls through exactly as today:
  prompt classifier fallback if configured, regex rules, default tier. The
  report says the classification was made without usable context so the user can
  see it.
- Precedence is unchanged: inline tier word and `/bifrost pin` first (they skip
  classification, so nothing is sent), direct-model regex rules next, then the
  classifier stages.
- Subagent sessions (`PI_SUBAGENT_RUN_ID`, `index.ts:592`) send no context.
- Both call sites share `pipeline.classify`: the physical-selection input
  handler (`index.ts:669`) and the `bifrost/auto` dispatcher (`index.ts:445`).
  Both build context the same way.

### Cache

When context was sent, the fuzzy cache is bypassed for read and write, or keyed
on a context hash under #179's scheme. Consequence: with the block enabled, from
the second turn of a session most classifications skip the cache. The first turn
has no context and caches as today. This cost is accepted; #179's keyed scheme
is the way to recover it. Whether short replies are excluded from the cache
regardless of this feature is #179's scope.

### Visibility

- `ClassificationJudgment` carries `contextSent`. Preview, status and decision
  traces (ADR 0007) report that context was sent, the number of exchanges, the
  character count, and whether anything was redacted or truncated. Never
  content.
- `/bifrost preview --json` includes the same fields. Preview runs inside the
  live session, so it reports the real context size.
- Debug output must not persist context (the existing TypeSafe debug rule: raw
  prompts and bodies are never persisted).
- With the block disabled, preview can still report what would have been sent
  (size only), so the user can judge it before opting in.

### Disclosure

Enabling the block sends assistant text to the classifier provider. The guide
and `/bifrost status` say so plainly and state how to turn it off. The provider
is the one the user already chose for prompt classification, over the same
transport.

## What was dropped, and why

Revision 3 proposed a continuation floor: for a short reply, route at the higher
of the classifier tier and the tier of the previous turn. It is removed because
it encodes the wrong rule. After a planning turn, the next reply usually starts
execution, which should go to a cheaper model; a floor keeps the expensive model
there. The right question is never "what tier did the last turn use" but "what
work does this turn trigger". Dropping it also removes the bare-reply test
(character and word thresholds), the explicit tier `order`, the incumbent
state, the `continuation` source and its cache rules.

The previous-tier idea survives in exactly one place: the **retain-incumbent
baseline arm** of the evaluation, as #161 asks, to measure how far inertia would
get. It is never product behavior.

## Evaluation

Follow #161 for the method. Build a **synthetic** multi-turn corpus, extending
the scenario format in `scripts/jev-benchmark.ts` and `tests/corpus/jev` with a
`context` field (previous exchanges, tool summaries, tiers). Families include
approvals after a plan, approvals after a small fix, bare numbers and option
letters, "Fix it.", "Continue.", "Use the second approach.", "try again", a
short new task after a trivial turn, a short new task after a heavy turn, and
ordinary single-turn prompts. Gold tier is the tier of the *work triggered*,
with a rationale and an ambiguity note.

Arms:

1. today (prompt only);
2. retain-incumbent baseline (evaluation only);
3. prompt plus context.

Report per family: accuracy, under-routing (gold higher than chosen),
over-routing (gold lower than chosen), the classifier-miss rate on
context-dependent requests, the confidence distribution of context-fed answers,
and requests whose decisive text falls beyond the input bound. Also sweep
`turns` and `maxChars` to pick defaults, and compare instruction wordings.

Constraints from #161 apply: no prompt text or repository content in committed
artifacts, offline except where paid evaluation is explicitly authorized, and
sticky/override precedence unchanged during the experiment.

**Release guard, recorded before running anything:** arm 3 must not be less
accurate than arm 1 on the single-turn families, and must be more accurate than
arms 1 and 2 on the context-dependent families. Missing the guard blocks the
change; the exact margin is recorded in the PR first.

## Testing

Deterministic, per `AGENTS.md`: fake registry and fake classifier, no live
providers.

- request shape: pi-native and direct TypeSafe send the same object `state`;
  without context the request is unchanged; nothing but the documented keys is
  sent;
- context builder: turn pairing, trailing unanswered user message dropped,
  non-message branch entries skipped, thinking and image blocks ignored, caps and
  budget, truncation marker, tier lookup (unique match only), tool summary;
- redaction table tests, including near-miss strings that must survive; code
  fence stubs including unclosed fences;
- pipeline: context passed to the direct classifier, `contextSent` on the
  judgment, cache bypassed for read and write when context was sent, a context-fed
  miss falls through as today;
- subagent sessions and the prompt backend send no context;
- debug output never contains context;
- config and schema agreement (`tests/schema.test.ts`), docs drift
  (`tests/docs-command-drift.test.ts`);
- a reverted-guard run showing the new assertions go red, plus `npm test` and
  `npm run typecheck` output in the PR.

## Delivery order

1. Open an upstream issue (problem, proposal, questions) and wait for the
   maintainer's reaction. Draft the ADR (proposed) meanwhile; it is submitted
   only on the owner's say-so.
2. Land or track #179.
3. Evaluation corpus and runner (no product change), release guard recorded
   first.
4. Product change in the fork (and upstream once agreed), advisory reporting
   first, then the opt-in effect.
5. After implementation: comments on #161, #179, #180 with the problem
   statement and results, text approved by the owner first.

Each step is its own PR with Conventional Commit messages. The fork
(`hiemalis-at/pi-bifrost`) carries the work regardless of upstream's answer,
because the owner needs the feature.

## Governance

`AGENTS.md`: "proposed ADRs are not implementation approval", and ADR drafts
are not committed unless requested (`docs/adr/*` is gitignored upstream). This
document is a design, not an ADR. The ADR (next free number, assigned upstream)
is needed before product code upstream.

## Risks

| Risk | Mitigation |
|---|---|
| Jev ignores or misreads the extra state | The evaluation and release guard decide; instruction text is a single constant; users keep inline tier words and `/bifrost pin`. |
| Context-fed answers come back at low confidence and miss | The evaluation reports the confidence distribution. Misses fall through as today, visibly. A separate threshold is rejected for config complexity; revisit only with data. |
| Enabling the block sends conversation context to the classifier provider | Opt-in; same recipient as the prompt; bounded, redacted, no tool output; disclosed in status and guide; size-only reporting. |
| Redaction misses a secret shape | Pattern scrub plus never sending tool results, arguments or files; redaction table tests. |
| Cache bypass raises cost and latency from turn two | Accepted in v1; #179's keyed scheme recovers it. |
| Context-dependent tier served from the cache | Context-fed calls never read or write the cache. |
| Context leaks across sessions or subagents | Built per call from the current session branch; excluded for subagent runs. |
| A planner-tier model still executes within a single turn | Out of scope (#160); stated in non-goals and the issue. |

## What stays unchanged

Physical selection before generation; no prompt replay; persisted reliability
state; no model IDs in defaults; the default footer; classifier choices limited
to configured tiers; classification cache never storing model answers.

## Open questions

1. **Does Jev weigh object history well enough?** The evaluation answers it; the
   live probe suggests it depends on the instruction text and that confidence
   may be low.
2. **Direct endpoint.** Does `api.typesafe.ai/v1/systemone` (`jev-1.13.0`) behave
   like the Pi-routed model? Verified before release.
3. **Cache cost.** Is bypassing the fuzzy cache whenever context is sent
   acceptable in v1, pending #179?
4. **ADR.** One ADR is enough now that the feature is a single change; the
   maintainer may prefer otherwise.
