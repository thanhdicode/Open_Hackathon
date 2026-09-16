# Paced failover soak

Generated: 2026-09-16T13:10:23.021Z
Runs per capability: 3. Pace: {"text":4000,"interpret":6000,"vision":45000,"stt":4000,"tts":6000} (ms between calls).

| capability | runs | ok | failure codes | median | p95 | providers used | fallbacks |
|---|---|---|---|---|---|---|---|
| text | 3 | 3 | — | 14249ms | 15151ms | explabs-luna×2, groq-text×1 | 2 |
| interpret | 3 | 3 | — | 2523ms | 3704ms | groq-text×3 | 0 |
| vision | 3 | 3 | — | 4381ms | 13041ms | groq-vision×2, explabs-luna×1 | 1 |
| tts | 1 | 0 | AI_UNAVAILABLE×1 | —ms | —ms | — | 0 |

## Circuit behaviour

- tripped provider skipped: **PASS** — tripped groq-text, request served by explabs-luna
- PAYMENT_REQUIRED parked: **PASS** — code=PAYMENT_REQUIRED, cooldown=600000ms

## Budget

```json
{
  "mode": "free-only",
  "sessionSpentUsd": 0,
  "totalSpentUsd": 0,
  "sessionBudgetUsd": 0.1,
  "demoBudgetUsd": 1,
  "remainingUsd": 0.1,
  "costedCalls": 4,
  "paidCalls": 0,
  "refusals": 0,
  "lastCostUsd": 0,
  "startedAt": "2026-09-16T13:10:23.010Z"
}
```

Overall: 9/10 successful (90%).
