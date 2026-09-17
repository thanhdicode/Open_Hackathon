# Baseline semantic review — release gate remains open

The baseline exercised 57 cases against real stored evidence and the deployed gateway. 32 cases produced live answers; 25 cases had no published evidence for BN, KH, LA, MM, TL and failed before any model call. The baseline's 32 automatic passes are contract/citation checks, **not** 32 semantically accepted answers.

Observed failures and limitations:

- `p6gold_ambiguous`: “Can I do it there?” received “Likely yes, if you mean studying or joining an exchange program...” followed by caveats. This invents the intended activity instead of asking for clarification. **Semantic failure.** The harness now explicitly rejects this pattern on subsequent runs.
- `p6gold_VN_0` / `p6gold_VN_4`: response moves from student documentation / meal preferences to e-visa advice. The packet contains generic e-visa access, not verified suitability for the individual's exchange/study purpose. **Needs source-level review; not accepted as an exchange-visa recommendation.**
- TH administrative question returns an honest refusal, but retrieves counseling facts instead of immigration requirements. Safety caveats work; topic coverage remains missing.
- Comparison SG/VN clearly separates supported Singapore rules from unavailable Vietnam comparison evidence. This is honest partial coverage, not full comparison coverage.
- Preference questions acknowledge when vegetarian meals or quiet spaces cannot be verified. They test preferences explicitly typed into a question. They do not prove that saved user interests reached AI context.

Full claim-by-claim acceptance remains pending for the answers in `ai-golden-baseline.json`. Re-run `node --env-file=.env.local scripts/phase6/ai-golden.mjs` after published corpus changes; this writes `ai-golden.json` without replacing the baseline. Browser retrieval and actual user context require separate UI evidence.
