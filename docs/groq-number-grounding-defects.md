# Groq summary numeric grounding: known gaps

The grounding check in `src/groq-summary.mjs` compares numeric tokens in each report item with the cited transcript segments. It is a limited guard, not semantic fact verification. Do not normalize or loosen it as part of the raw:8 prompt correction.

| Cited source | Report text | Current check | Issue |
| --- | --- | --- | --- |
| `5만 원` | `5만원` | `UNSUPPORTED_NUMBER` | False positive: spacing separates `만` from `원` in the source tokenization. |
| `5명` | `5천명` | Passes | False negative: `천명` is not recognized as a unit after `5`, so the bare `5` matches. |
| `올해 3.3%, 내년 2.9%` | `2024년 3.3%, 2025년 2.9%` | `UNSUPPORTED_NUMBER` for the two years | The source does not give those calendar years. This is the raw:8 correction failure currently under review. |

The raw:8 correction prompt now explicitly keeps relative time expressions such as `올해`, `내년`, `작년`, and `오늘` relative. Its change does not alter `groqRawPrompt`, transcript partitioning, the strict response schema, `assertGrounding`, saved attempts, or ledgers. The already used correction attempt remains failed and cannot be reused. The UI count is the number of mismatching **token occurrences** across report fields; repeated text contributes repeated counts. It is not the number of distinct fabricated values.

Any future tokenization change needs a separate review with Korean amounts, scale words, spacing, dates, negative numbers, units, and evidence ID scope fixtures. A local draft checked against the full original transcript is review material only; it is not an app summary success or a D1 checkpoint.
