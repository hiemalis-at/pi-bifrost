# Conversation-Aware Routing

Status: draft for review (revision 3: owner decisions folded in)
Date: 2026-11-07
Branch: `docs/conversation-aware-routing` (fork: `hiemalis-at/pi-bifrost`)
Upstream: `iamaamir/pi-bifrost`

All line numbers refer to the files at commit `7477577` (`main`, v0.5.0).

This document designs two cooperating changes.

- **Part A, continuation floor:** a small deterministic safety net. A bare
  reply never routes below the tier of the work in progress.
- **Part B, context-fed classification:** the main change. The direct
  classifier (Jev) decides on the exchange so far, not on the current prompt
  alone.

Neither is approved for implementation: `AGENTS.md` requires an approved ADR
before behavior changes, and this document does not draft one (see
[Governance](#governance)).

## Owner decisions (revision 2)

These are the owner's answers to the revision 1 open questions. They are
requirements, not proposals.

| # | Decision |
|---|---|
| 1 | Revision 2 asked for default-on with a direct Jev backend. **Superseded in revision 3: both parts are opt-in (`enabled: false` by default), per repo etiquette.** The owner still considers the implementation broken while Jev decides only on the current prompt and cannot use what was already done, said or exchanged, so Part B remains the goal; only the default changes. |
| 2 | Mode: delegated. My call: ship `floor` only, drop `inherit` (see [Behavior](#behavior)). |
| 3 | Explicit tier `order` list in config. |
| 4 | Bare-reply thresholds: delegated. My call: 60 characters, 10 words, tuned later on the evaluation corpus. |
| 5 | Decay: only a substantive prompt resets the incumbent. |
| 6 | Whether bare replies are excluded from the fuzzy cache is **#179's scope** ([#179](https://github.com/iamaamir/pi-bifrost/issues/179)). This design only guarantees its own results are never cached. |
| 9 | **Confidence:** trust Jev's confidence. When Jev answered with context at or above `minConfidence`, its tier stands and the floor does not override it (revision 3). |
| 10 | **Context specifics** (3 turns, 6,000 characters, tool summaries, code-fence stubs, redaction) accepted as proposed. |
| 7 | Part B sends as much conversation context as possible while staying security-sensible. The more Jev can weigh, the better. |
| 8 | Pursue upstream (`iamaamir/pi-bifrost`), not a fork-only direction. |

## Problem

Bifrost classifies every eligible user prompt from the prompt text alone.
Workflows that are driven by short replies ("Approved", "yes", "looks right",
"continue", "try again", a lone option number) therefore get a tier that
describes the reply, not the work the reply triggers.

Those replies are often the most consequential turns in a session. The model
selected at input handles the whole agent turn that follows, including tool
calls. A reply that starts "write the plan", "dispatch the subagents" or "open
the PR" can run on the cheapest tier because the text of the reply is trivial.

The problem is wider than bare replies. Any prompt that is only meaningful
given earlier turns ("do the same for the other module", "use the second
approach") is classified blind.

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
  reply keeps its tier regardless of conversation state. Upstream issue
  [#179](https://github.com/iamaamir/pi-bifrost/issues/179) tracks the cache's
  correctness defects.
- The cache identity must stay a single scheme. #179 and
  [#180](https://github.com/iamaamir/pi-bifrost/issues/180) both own it. This
  design adds no second fingerprint.

## Goals

- Jev sees what was already done, said and exchanged, and decides on that, not
  on the current prompt alone.
- A bare reply should not route below the tier of the work in progress, unless
  the user says so.
- Every effect is visible in `/bifrost preview`, status and decision traces,
  with its reason.
- Every effect can be disabled, bypassed with an inline tier word, or defeated
  by `/bifrost pin`.
- Part A needs no network request, no extra latency and no new dependency.
- Nothing secret leaves the machine because context is sent. The context sent
  is bounded, redacted and reported (size, never content).

## Non-goals

- Summarizing or remembering the whole conversation.
- Re-routing in the middle of a turn. Tool continuations and retries keep the
  model that started the turn.
- Replacing the classifier, adding a learned scorer, or adding a second routing
  resolver.
- Session-level stickiness. That is ADR 0019 (proposed); see
  [Relationship to existing work](#relationship-to-existing-work).
- Sending tool results, file contents or raw tool arguments to any classifier.

## Anti-goals

These make the work a failure even if every test passes.

- A turn that triggers heavy work silently runs on a cheap model because the
  user typed a short reply.
- Repository content, tool output, file contents or credentials reach an
  external classifier.
- Context-dependent classifications are written to the fuzzy cache and reused
  in a different context.
- An effect the user cannot see, explain or switch off in one step.
- The router becomes harder to explain than "selected model, source, exclusions,
  fallback, override".

## Product gate

`docs/product-philosophy.md` asks five questions before a feature is approved.

| Question | Part A: continuation floor | Part B: context-fed classification |
|---|---|---|
| User value | Chooses better: bare replies stop undershooting. | Chooses better: Jev judges the work a reply triggers, not the reply text. |
| Explicit policy | `classifier.continuation` config block, disabled by default. | `classifier.context` config block, disabled by default. |
| Visibility | New `continuation` source in preview, status and trace, with the incumbent tier and the reason. | Preview and trace state whether context was sent, its size and what was redacted or elided, never its content. |
| Override | Inline tier word, `/bifrost pin`, `enabled: false`. | Same. |
| Proof | Deterministic pipeline and qualification tests. | Offline corpus evaluation, used to tune the budget and to guard against regressions on single-turn prompts. |

### Defaults

Both blocks ship **disabled** (`enabled: false`). That keeps the feature inside
the repo's escalation ladder (`explicit configuration → observable signal →
advisory recommendation → explicit user/config opt-in → bounded automation`) and
the privacy rule for prompt data (owner decision 1, revision 3).

- Phase 1 is advisory: with the block disabled, preview and trace can still
  report what the feature *would* have done, so the user can judge it before
  opting in.
- `/bifrost status` and the guide state what is sent and how to enable or
  disable each block.
- A later change may propose default-on for direct Jev backends (ADR 0020
  already fills an absent `classifier.backend` from detected credentials). That
  needs its own ADR and is not part of this design.

## Relationship to existing work

| Item | Relationship |
|---|---|
| ADR 0019, session-sticky routing (proposed) | Complementary. 0019 keeps the first prompt's model for the whole session until an explicit instruction. This design stays in adaptive mode: substantive prompts are still re-classified. The two can be combined, and sticky mode would simply never reach this design. |
| [#179](https://github.com/iamaamir/pi-bifrost/issues/179), classifier cache semantic safety | Must land first, or be coordinated. It also owns whether bare replies are excluded from the fuzzy cache regardless of this feature (owner decision 6). If #179 changes the cache API or lands a stricter rule, this design follows it. |
| [#180](https://github.com/iamaamir/pi-bifrost/issues/180), compiled classification policy | Owns the classifier instruction text and its identity. Part B's changed instruction text goes through #180's compiler, not a new constant. |
| [#161](https://github.com/iamaamir/pi-bifrost/issues/161), context-aware classification evaluation | Part B's evaluation phase is this experiment. This design adopts #161's acceptance criteria, including the retain-incumbent baseline, the privacy rule, truncation reporting and sticky/override precedence. #161 frames the work as an evaluation; owner decision 1 makes shipping the goal. That difference must be raised with the maintainer first (see [Delivery order](#delivery-order)). |
| [#160](https://github.com/iamaamir/pi-bifrost/issues/160), [#157](https://github.com/iamaamir/pi-bifrost/issues/157) (listed blockers of #161) | The evaluation harness should reuse #157's paired runner if it exists by then. |

## Part A: continuation floor

### Behavior

For a prompt that qualifies as a *bare reply*, the routed tier is the higher of
the classifier's tier and the tier of the work in progress (the *incumbent*).
If the classifier misses, the incumbent tier is used, never the default tier.

There is one mode, `floor`. Revision 1 also offered `inherit` (use the
incumbent tier and skip the classifier). It is dropped, because:

- it makes no classifier call, so it contradicts the direction that Jev decides
  on the exchange (decision 1);
- it undershoots when a short but genuinely harder request follows a trivial
  turn ("refactor it", "design the schema"), which `floor` handles;
- two modes double the tests, docs and explanation for no capability `floor`
  lacks. If it is wanted later it is an additive change.

Plainly: `floor` means "Jev (with context) picks a tier, and a short reply is
never allowed to go below what the previous turn was running on".

`floor` needs a total order over tiers. The order of keys in `models` is not a
contract (merged layers and bundled defaults change it, see upstream issue
[#199](https://github.com/iamaamir/pi-bifrost/issues/199)), so the order is
explicit:

```json
"classifier": {
  "continuation": {
    "enabled": false,
    "order": ["trivial", "light", "heavy", "critical"],
    "maxChars": 60,
    "maxWords": 10
  }
}
```

`enabled` defaults to `false`. `order` may be omitted when it can be derived
unambiguously (see [Edge cases](#edge-cases)).

**The floor yields to Jev only when Jev saw the context** (owner decision 9).
When Part B sent context and Jev answered at or above `minConfidence`, Jev's tier
stands: it is Jev's domain, and it judged the exchange. The floor applies when:

- context was not sent (Part B disabled, first turn, or an override path), because
  a confident answer on bare text is the failure the evidence shows (9 of 9
  cheapest-tier results, four at 0.96 or above, were confident);
- Jev missed or answered below `minConfidence`.

The trace shows which rule decided, and both tiers when they differ.

### What qualifies as a bare reply

A deterministic, language-independent test on the trimmed prompt (the same
text the classifier would see after the inline-override strip at
`index.ts:612`):

- at most `maxChars` (60) characters and at most `maxWords` (10)
  whitespace-separated words;
- a single line, with no code fence, URL or path-like token (contains `/` or `\`
  between non-space characters).

Thresholds are my guess. 60 characters matches the "short prompt" class in the
evidence; 10 words admits "looks right, go ahead and open the PR". Tune on the
evaluation corpus.

No word lists (they would be English-only). The test is intentionally broad: a
short imperative like "fix it" qualifies, and that is correct, because it refers
to something earlier in the conversation. The cost of over-qualifying is a
higher tier than strictly needed, bounded by the incumbent.

Qualification applies only when an incumbent exists. With no incumbent (a fresh
session or a resumed one), behavior is exactly today's, plus Part B.

### Incumbent

The final tier of the previous dispatched turn in this session, including a tier
lifted by the floor. It is stored next to `pinned` in `runtime-state.ts:12`:
session-local, ephemeral, never persisted, and not inherited by subagent
sessions (`PI_SUBAGENT_RUN_ID`, see `index.ts:592`).

**Only a substantive prompt resets it** (owner decision 5): a prompt that does
not qualify as a bare reply sets the incumbent to its own tier, which can be
lower. Consecutive bare replies never lower it and never decay it by count or
time. A user who wants a lower tier types an inline tier word, runs
`/bifrost pin`, or sends a substantive prompt.

### Where it sits in the pipeline

`classification-pipeline.ts:73` currently runs: direct-model regex pre-check
(`:74`), cache (`:88`), direct classifier (`:97`), prompt classifiers (`:114`),
regex tier rules (`:135`), default (`:152`). Precedence for a prompt becomes:

1. inline tier word (`index.ts:612`) and `/bifrost pin` (`index.ts:601`),
   unchanged and still highest;
2. direct-model regex rules (`:74`), unchanged: a destructive-command rule must
   beat the floor;
3. stages 4 onward run as today (with Part B context on the direct classifier);
4. **continuation floor** (new): for a bare reply with an incumbent, the result
   is the higher of the stage-3 result and the incumbent, except that a
   confident stage-3 answer that was given context stands as is. A stage-3 miss
   yields the incumbent.

Both call sites share `pipeline.classify`: the physical-selection input handler
(`index.ts:669`) and the `bifrost/auto` dispatcher (`index.ts:445`). The
incumbent must be maintained and read on both paths.

### Cache rule

Results with source `continuation` are never written to the cache. A bare reply
never reads from the cache while the floor is active, because a cached tier for
"Approved" is a tier for a different conversation state. Whether bare replies
are excluded from the cache independently of this feature is #179's scope
(owner decision 6). If #179 lands a stricter rule, that rule wins.

### Visibility

- `ClassificationResult` gains the source `continuation` and carries the
  incumbent tier, the classifier tier (when there was one), and the reason: bare
  reply, length, word count.
- `/bifrost preview` prints the same, and `--json` includes them. Preview runs
  inside the live session, so it can report the real incumbent.
- Status and decision traces (ADR 0007) show the source, whether the floor
  overrode the classifier, or that Jev's context-fed answer stood.
- Phase 1 (advisory): preview and trace report what the floor *would* have
  chosen without changing the route.

### Edge cases

| Case | Behavior |
|---|---|
| Incumbent tier has no healthy candidate | Existing tier fallback and reliability rules apply unchanged. |
| Incumbent tier no longer exists in config (reload) | Treated as no incumbent. |
| `order` missing a configured tier | Config validation error naming the tier, at load. The floor never silently ignores a tier. |
| `order` omitted | Allowed only when exactly one unambiguous order exists (a single `models` layer); otherwise config validation error asking for `order`. Detection never guesses (see #199). |
| Queued prompts while streaming (`event.streamingBehavior`) | Follow the existing virtual-auto and input handling; the incumbent is the last *dispatched* turn, not a queued one. |
| Session resume | No incumbent until the first dispatch. |
| Consecutive bare replies | Each keeps the incumbent. Cost can stay high for a long session of approvals; this is accepted (decision 5) and visible in status. |

## Part B: context-fed classification

### Hypothesis and status

Some prompts cannot be judged from the prompt text, or even from the previous
tier ("Use the second approach", "Fix it" after a long analysis). Giving Jev the
exchange so far lets it judge the work being triggered.

Owner decision 1 makes this the main change and the reason the feature exists.
Nothing in this repo yet shows that the TypeSafe classifier makes good use of
extra state, so the evaluation below tunes the design and guards against
regressions rather than deciding whether to build it. Part A is the backstop if
Jev ignores the context.

### What the code allows

- `ClassifierContext.state` is typed `JsonObject` in the Pi AI types. The
  pi-native backend sends `{ prompt }` (`classifier-pi-native.ts:96-100`), so
  adding fields is a local change.
- The direct TypeSafe backend sends `state: input.prompt` as a string
  (`typesafe-classifier.ts:45-49`). **Verified against the TypeSafe docs
  (revision 3): `state` accepts a string, a JSON object or a JSON array.** The
  OpenAPI schema for `POST /v1/systemone` types `state` as `anyOf` string,
  object, array (`x-accepts: string | object | array`), and the state page says
  "State is a string, JSON object, or array". Both direct backends therefore get
  the same object state; no string serialization fallback is needed. Limits of
  this verification: the docs' `POST /v1/systemone` request examples all pass a
  string, and no live call was made; the docs do not state key restrictions or
  nesting limits. Part B's first tests must include one real request with an
  object `state` before release (a deterministic fake-server test cannot prove
  the live endpoint).
- The docs describe referencing parts of an object state from the question's
  `instructions` with backticked dot paths (for example
  `previous_exchanges[0].assistant`). Part B uses named keys and says in the
  instruction text which key is the current prompt and which is history. This is
  a prompt convention; the docs do not say whether the server resolves the paths
  or the model only reads them.
- The question text ("Which model tier best fits this coding-agent request?") is
  fixed in both builders. Telling the classifier how to use context needs new
  instruction text, which belongs to #180's compiler, and changes the cache
  identity.
- Prompt text is bounded to 16,000 characters
  (`classifier-semantics.ts:8-10`). Context needs its own budget, and the total
  must still respect the classifier's input limit.
- Extensions can read history through `ctx.sessionManager.getBranch()`
  (`ReadonlySessionManager` in the Pi coding-agent types).

### What is sent

The goal is to maximize what Jev can weigh without sending repository content or
secrets. The calls below are mine; the owner asked for "as much as possible but
security-sensible" and has not reviewed the specifics.

Sent, newest first, within one character budget:

- the **current prompt** (as today);
- the last **N exchanges** (default 3): each is the user's prompt and the
  assistant's final text for that turn;
- the **tier each of those turns ran on**;
- per turn, a **tool activity summary**: tool names and counts only, for
  example "edit x4, bash x2, subagent x1". No arguments, no results, no paths.
  This tells Jev that real work happened, which is the signal a bare "continue"
  needs.

Never sent: tool results, file contents, tool arguments, system prompts,
reasoning blocks, attachments or images.

Shape: an object `state` with the keys `current_prompt`, `previous_exchanges`
(each with `user`, `assistant`, `tier`, `tools`) and `omitted_earlier_turns`.
Pi-native and direct TypeSafe send the same object.

Treatment of what is sent:

- **Code fences** in assistant text are replaced with a stub carrying language
  and line count (for example `[code: ts, 42 lines]`). Prose around them stays.
  That keeps "a large change was proposed" visible without sending the code.
- **Redaction:** a pattern scrub for credentials runs on all sent text: provider
  API key shapes, `Authorization` headers, private key blocks, `.env`-style
  `NAME=value` assignments with secret-like names, and long high-entropy tokens.
  Matches become `[redacted]`.
- **Budget:** `maxChars` total (default 6,000), filled newest first, each
  assistant message truncated at its own cap. When something is dropped, the
  request says so ("earlier turns omitted") so Jev does not treat the window as
  the whole conversation.
- **Truncation reporting:** the trace records how many turns were included,
  total characters, and whether anything was truncated or redacted.

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

`enabled` defaults to `false`. The prompt classifier backend never receives
context, even when enabled.

### Rules

- **Opt-in, with disclosure.** The guide and `/bifrost status` state that
  enabling this block sends conversation context (bounded, redacted, no tool
  output) to the classifier provider, and how to turn it off.
- **Cache:** when context was sent, the fuzzy cache is bypassed for both read
  and write, or keyed on a context hash under #179's scheme. Consequence: from
  the second turn of a session, most classifications skip the cache. The first
  turn has no context and caches as today. This cost is accepted; #179's keyed
  scheme is the way to recover it.
- **Visibility:** preview and trace report that context was sent, how many
  turns, its length, and what was elided or redacted, never its content. Debug
  output must not persist it (the existing TypeSafe debug rule: raw prompts and
  bodies are never persisted).
- **Failure:** a classifier miss, or an answer below `minConfidence`, falls
  through exactly as today, with the Part A floor applied if enabled.
- **Overrides:** inline tier word and `/bifrost pin` skip classification, so
  nothing is sent. Subagent sessions send no parent context.

### Evaluation

Follow #161 for the method. Build a **synthetic** multi-turn corpus, extending
the scenario format in `scripts/jev-benchmark.ts` and `tests/corpus/jev` with a
`context` field (previous exchanges, tool summaries, previous tiers). Families
include approvals, bare numbers and option letters, "Fix it.", "Continue.",
"Use the second approach.", "try again", a short new task after a trivial turn,
a short new task after a heavy turn, and ordinary single-turn prompts. Gold tier
is the tier of the *work triggered*, with a rationale and an ambiguity note.

Arms:

1. today (prompt only);
2. Part A floor on top of arm 1;
3. prompt plus context;
4. prompt plus context plus Part A floor, with Jev's confident context-fed
   answer standing (the configuration both blocks enabled).

Report per family: accuracy, under-routing (gold higher than chosen) and
over-routing (gold lower than chosen), the classifier-miss rate on
context-dependent requests separately from ordinary low confidence, how often
the floor lifts a miss or low-confidence answer, how often a confident
context-fed answer is lower than gold, and requests whose decisive
text falls beyond the input bound. Also sweep `turns` and `maxChars` to pick the
defaults.

Constraints from #161 apply: no prompt text or repository content in committed
artifacts, offline except where paid evaluation is explicitly authorized, and
sticky/override precedence unchanged during the experiment.

**Release guard, set before running anything and recorded in the PR:** arm 4 must
not under-route more than arm 1 on any family, and must not regress on the
single-turn families. The margin by which arm 3 should beat arm 2 on the
context-dependent families is recorded as a target. Missing the guard blocks the
change; missing the target does not cancel it (decision 1) but is reported in the
ADR. Because both blocks are opt-in, the result informs the documentation
(what to enable and what to expect), not a default.

## Testing

Deterministic, per `AGENTS.md`: fake registry and fake classifier, no live
providers.

Part A:

- table-driven qualification tests: boundaries of `maxChars` and `maxWords`,
  multi-line, code fence, URL, path, non-English replies, empty string;
- pipeline tests (`tests/pipeline.test.ts` style): the classifier tier lower
  than, equal to and higher than the incumbent; classifier miss; no incumbent;
  a substantive prompt lowering the incumbent; consecutive bare replies not
  lowering it;
- precedence tests: inline tier word, pin, direct-model rule, then the floor;
- cache tests: a `continuation` result is never stored, and a bare reply never
  reads the cache while the floor is active;
- both call sites: physical input handler and `bifrost/auto`
  (`tests/dispatch-ownership.test.ts` style);
- default tests: both blocks disabled when `enabled` is absent, with every
  effective backend;
- confidence tests: a confident context-fed answer below the incumbent stands;
  the same answer without context is lifted; a low-confidence context-fed
  answer is lifted;
- config tests: `order` validation, unknown tier, schema agreement
  (`tests/schema.test.ts`), docs drift (`tests/docs-command-drift.test.ts`);
- reverted-guard run showing the new assertions go red, plus `npm test` and
  `npm run typecheck` output in the PR.

Part B:

- fake-registry tests that the request carries exactly the bounded context and
  nothing else (no tool results, arguments or file contents);
- redaction table tests, including near-miss strings that must not be redacted;
- code-fence stub and truncation tests, including the "earlier turns omitted"
  marker;
- pi-native and direct TypeSafe send the same object `state`;
- one live (explicitly authorized) request with object `state` to the real
  endpoint before release, with synthetic content only;
- the cache is bypassed when context is sent and not when none is;
- debug output never contains context;
- the evaluation corpus and runner (above).

## Delivery order

1. Comment on upstream #161, #179 and #180 with the evidence and the proposed
   direction, and ask the maintainer whether #161's evaluation framing can
   become a shipping (opt-in) change. Drafts are
   prepared but not posted until the owner approves the wording.
2. Land or track #179. Open the ADR (proposed), covering Part A and Part B; or
   two ADRs if the maintainer prefers.
3. Part A phase 1 (advisory: preview and trace only), then phase 2 (opt-in
   routing effect).
4. Part B evaluation corpus and runner (no product change), including the
   release guard.
5. Part B product change behind the same advisory-then-effect phases, with its
   ADR accepted.

Each step is its own PR to `iamaamir/pi-bifrost` with Conventional Commit
messages, branched from the fork (`hiemalis-at/pi-bifrost`). Steps 3 to 5 do not
start before the ADR is accepted.

## Governance

`AGENTS.md`: "proposed ADRs are not implementation approval", and ADR drafts
are not committed unless requested. This document is a design, not an ADR.
The ADR (next free number, assigned upstream) is needed before product code. It
should also record the decision that Jev's confident context-fed answer beats the
floor.

## Risks

| Risk | Mitigation |
|---|---|
| Enabling Part B sends conversation context to the classifier provider | Opt-in; same recipient as the prompt; bounded, redacted, no tool output; disclosed in status and guide; reported by size in preview and trace. |
| Redaction misses a secret shape | Pattern scrub plus never sending tool results, arguments or files; redaction table tests; the assistant's own text is the only prose source. |
| Over-routing: a long session of approvals stays on an expensive tier | Visible source in status; opt-out; user can lower with an inline tier word, pin or a substantive prompt. Accepted cost of decision 5. |
| A confident context-fed answer is too low and nothing lifts it | Accepted (decision 9). Trace shows the answer and incumbent; the evaluation reports how often it is below gold; the user can enable only the floor or pin. |
| Jev ignores or misreads the extra state | The floor still covers misses, low confidence and runs without context; evaluation and release guard. |
| Cache bypass raises cost and latency from turn two when Part B is enabled | Accepted in v1; #179's keyed scheme recovers it. |
| Cache serves a stale or wrong-context tier | Never cache continuation or context results. |
| Incumbent or context leaks across sessions or subagents | Session-local, ephemeral, excluded for subagent runs. |
| Config order drift between layers | Explicit `order`, validated at load. |
| Evidence is one user's history | The evaluation uses a synthetic public corpus and a pre-set release guard. |

## What stays unchanged

Physical selection before generation; no prompt replay; persisted reliability
state; no model IDs in defaults; the default footer; classifier choices limited
to configured tiers; classification cache never storing model answers.

## Open questions

Owner decisions 1 to 10 are recorded above. What remains:

1. **Live confirmation of object `state`.** The docs say object state is
   accepted, and pi-native already sends one. A live call with synthetic content
   has not been made; it needs the owner's go-ahead because it uses their
   credential and sends data to the provider.
2. **Does Jev weigh object history as well as a string?** The docs describe
   backticked paths as a prompt convention only. The evaluation answers this;
   the maintainer may know.
3. **Cache cost.** Is bypassing the fuzzy cache whenever context is sent
   acceptable in v1, pending #179?
4. **Default-on later.** Out of scope here; worth a follow-up ADR only after the
   evaluation shows the benefit.
