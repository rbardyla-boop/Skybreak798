# StateForge equal-model sealed evaluation

This experiment runs one model through three wrappers:

- `stateforge`: explicit versioned statechart with candidate guards, evidence-driven repair, hard retained counterexamples, and replayable transition logs.
- `loop`: unrestricted unstructured trace/scratchpad loop with no explicit statechart.
- `static`: immutable graph selected by frozen development-set tuning.

## Fairness contract

Each paired episode uses the same public observation and correct hidden action. Every wrapper receives:

- model `openai/gpt-4o-mini` at temperature 0;
- the same `rank_actions` JSON interface;
- a two-action episode limit;
- 13 batched model calls per 100-episode run;
- equal input/output token ceilings;
- equal active model-time ceilings;
- the same disclosed rule grammar.

Three independently seeded 100-episode runs are planned. Each run contains eight unpublished family instances. Family parameters are generated with cryptographic randomness only after the frozen evaluator commit executes on the GitHub-hosted runner, remain inside the evaluator during play, and are released in the result artifact after scoring.

Completion differences use a paired cluster bootstrap over run-family clusters with 20,000 resamples.

## Local plumbing test

```bash
node experiments/stateforge-equal-model/run.mjs \
  --provider mock \
  --runs 1 \
  --output artifacts/stateforge-equal-model-mock \
  --requestGapMs 0
```

The mock mode validates orchestration and integrity only. It is not valid model evidence.
