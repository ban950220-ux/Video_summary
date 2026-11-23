# Gemini chapter-coverage failure: regression record

This change adds portable synthetic tests. It changes no runtime, schema,
prompt, deployment policy, binding, budget, credentials or provider flags.
It contains no private transcript or original model response prose.

## Reproduced cause

Private offline replay of two preserved responses reconstructed the historical
first-generation, count and repair request hashes exactly from code
`3b7af196a277e9a2346ac9f8b5396b3d63159d10`. Both HTTP200 responses ended with
`STOP` and stayed below the output cap. Basic schema, reference existence and
numeric/quote grounding checks passed. Chapter time-window coverage failed.

The validator required chapter references in every ten-minute window, but the
original prompt/schema did not expose that window-by-window contract. Both
outputs had four chapters. The first omitted chapter evidence for 30–40,
80–90 and the final 90-minute window. The repair also lost 70–80. Repair prose
claimed the missing ranges while citing valid IDs from different time windows;
repair notes did not add chapter coverage. These are reference-coverage
findings, not proof that every semantic topic in those windows was absent.
The later repair prompt did explicitly name the missing time ranges, but retained the generic report schema.

Replaying the historical runners with injected local responses saved raw
receipts and then halted at validation, before final result-file creation.
Those local runners did not save a final report into operational D1. A separate
operational SETTLED/REPORT_NOT_SAVED reservation cannot be equated with either
local response or with two invoice charges from the available evidence.

## Existing fix, not a new runtime modification

The window-manifest contract was added in
`7c05c2883a1ec06f8b32bd9e263134c29fc5f1bc`, after those failures. It is already
present in main `b009d0cc09097815457ef31966786ca332757414` and the reviewed PR37
tree `d5ac6ab65696e06484809794867610f6658fa97a`.

The request now carries deterministic window keys, primary IDs assigned by
segment start, and boundary references. It asks for one chapter per window;
the app validator enforces the complete ordered set, valid kinds and primary
evidence. Boundary-only references cannot satisfy a later primary window.
The JSON schema requires windowKey/kind but does not itself enforce the exact
chapter count. Prompt instructions and application validation remain distinct.
Passing structural checks does not prove semantic completeness or audio accuracy.

The existing runtime saves receipts and usage before content validation, blocks
repeat dispatch, reconciles complete receipts without another model call, and
uses explicit source-bound acceptance for final report storage/GET/TXT. This
test-only patch does not import historical responses into a new operational
attempt or reclassify a repair wrapper as a successful independent review.

## Regressions

Run:

```sh
node --test tests/gemini-coverage-root-cause.test.mjs tests/two-pass-windows.test.mjs tests/gemini-two-pass.test.mjs
```

The new tests reproduce both four-chapter failure patterns, misleading repair
time labels, the current prompt/schema contract, a valid draft, each missing
window, duplicates, ordering, cross-window IDs, a one-millisecond boundary,
explicit transcript gaps and immutable repeated validation. Existing runtime
tests cover duplicate/concurrent POSTs, uncertain dispatch/counts, before-commit
and ACK-loss receipt failures, recovery and strict two-call limits.

Separate private local Workerd replays used the actual saved source and response
bytes: both invalid responses stayed stored with their usage, report remained
null, and repeated run/recover/next-phase requests caused no additional mock
calls. Historical fixtures were preserved. These private files are intentionally
excluded from this repository patch; CI uses only synthetic data.

## Limits and execution boundary

Model compliance with the new request has not been established by these mocks.
The guards prevent silent completion and automatic recharging; they cannot
promise that a future model response will be valid or accurate. Private replay
is not a new model generation. No provider/countTokens request, transcript
transmission, deployment or operational write is authorized by these tests.
