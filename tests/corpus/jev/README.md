# Jev development corpus

`scenarios.jsonl` is labelled **DEVELOPMENT** data for evaluation-only comparison of the current regex/default baseline and TypeSafe Jev. Labels describe task complexity, not preferred price or model. They do not authorize production routing.

Each record includes stable ID, synthetic prompt, task family, gold tier, rationale, ambiguity, and split. The harness computes baseline metadata from current rules at run time so it cannot become stale. Keep prompts synthetic/redacted: do not add source files, tool output, session history, secrets, or real user prompts. Append records; do not reuse IDs.

## Tier policy

- `quick`: bounded, reversible, obvious work such as formatting, lookup, or small mechanical edits.
- `general`: normal implementation, tests, API changes, and moderate reasoning with clear scope.
- `frontier`: complex debugging, architecture, security, ambiguity, concurrency, or consequential work.

Use contrastive pairs where possible. Record ambiguity and acceptable alternatives rather than hiding disagreements. Unresolved records stay out of primary strict accuracy. Baseline is current default regex behavior, not gold truth.

Run offline:

```sh
npm run --silent benchmark:jev -- --baseline tests/corpus/jev/scenarios.jsonl --split dev > report.json
```

Run live only by explicit opt-in after exporting `TYPESAFE_API_KEY` outside shell history:

```sh
npm run --silent benchmark:jev -- --live tests/corpus/jev/scenarios.jsonl --split dev > report.json
```

The default split is `dev`. Running `review` requires explicit `--split review`; do not use review results to tune criteria and then present the same split as untouched evidence.

Live output is preliminary development evidence. It does not change routing, persist prompts, or establish a promotion claim.

## Multi-turn context scenarios

Multi-turn scenarios live in a separate file, `multi-turn.jsonl`, so the single-turn corpus, `manifest.json` and their tests stay untouched. A record has the same fields as above plus `context`:

```json
{"id": "mt-0001", "prompt": "Yes, go ahead.", "family": "approval-after-plan", "goldTier": "frontier", "goldRationale": "...", "ambiguity": "none", "split": "dev", "context": {"exchanges": [{"user": "...", "assistant": "...", "tier": "frontier", "tools": "..."}], "previousTier": "frontier"}}
```

- `goldTier` is the tier of the **work the prompt triggers**, not of the prompt's length.
- `context.exchanges` is oldest first; `tier` and `tools` are optional. `context.previousTier` is the tier the most recent exchange ran on. Only the retain-previous-tier arm reads it.
- The same short reply (for example "Yes, go ahead.") may appear in several records with different contexts; an identical prompt plus identical context is still rejected as a duplicate.
- Context-dependent families: `approval-after-plan`, `approval-after-small-fix`, `bare-option`, `fix-it`, `continue`, `use-second-approach`, `try-again`, `short-task-after-trivial`, `short-task-after-heavy`. The control family is `single-turn` (self-contained prompts with an irrelevant history). The report treats every family except `single-turn` as context-dependent.
- Keep text synthetic. Never add real session text, source files, tool output or secrets.

The harness only ever prints ids, families, counts and tiers. It never prints prompt or exchange text.

### Arms

| Arm | What it answers | Network |
| --- | --- | --- |
| `prompt-only` | Classifies the prompt text alone (today's behavior). | yes |
| `retain-previous-tier` | `context.previousTier`, or the baseline default (regex rules, then `general`) when absent. Evaluation only; never a routing option. | no |
| `prompt-plus-context` | Classifies with the context through `buildTypeSafeRequest({ prompt, tiers, criteria, context })`: object `state` plus `CONTEXT_INSTRUCTIONS`. | yes |

```sh
# Offline: only retain-previous-tier is computed
npm run --silent benchmark:jev -- --baseline tests/corpus/jev/multi-turn.jsonl --split dev --arms retain-previous-tier > arms.json

# Offline replay of recorded responses; fixture keys are "<scenario id>:<arm>" mapping to a raw TypeSafe response
npm run --silent benchmark:jev -- --fixture fixture.json tests/corpus/jev/multi-turn.jsonl --split dev --arms all > arms.json

# Live, explicit opt-in only (TYPESAFE_API_KEY exported outside shell history)
npm run --silent benchmark:jev -- --live tests/corpus/jev/multi-turn.jsonl --split dev --arms all > arms.json
```

The arm report gives, per family and per arm: `n`, `correct`, `accuracy` (exact tier match on non-unresolved scenarios), `underRouted` (gold higher than chosen), `overRouted` (gold lower than chosen), `errors`, `belowFloor` and `misses` (errors plus below-floor answers). Classifier arms also report the confidence distribution in buckets `<0.5`, `0.5-0.7`, `0.7-0.9`, `>=0.9`. Answers below the 0.7 confidence floor are misses: counted as incorrect in `accuracy` and reported separately in `belowFloor`. Pooled `contextDependent` and `singleTurn` sections and a `guard` section follow the per-family section.

### Context arm release guard (recorded before the first run)

Written before any context-arm result exists. The guard is computed by the harness (`guard: { singleTurnOk, contextBeatsBothBy, contextOk }`) and must not be loosened after seeing results.

1. **Single-turn control.** `prompt-plus-context` strict accuracy must be greater than or equal to `prompt-only` strict accuracy on the `single-turn` family. `singleTurnOk` is true when this holds.
2. **Context-dependent families, pooled.** `prompt-plus-context` strict accuracy must exceed the better of `prompt-only` and `retain-previous-tier` by at least 15 percentage points. `contextBeatsBothBy` is that margin in percentage points (arm 3 minus the better of arms 1 and 2); `contextOk` is true when it is at least 15.
3. Strict accuracy counts misses (transport errors and answers below the 0.7 confidence floor) as incorrect in every arm.

Passing the guard is necessary, not sufficient, to ship context-aware routing. The corpus is development data and the guard does not authorize routing changes by itself.
