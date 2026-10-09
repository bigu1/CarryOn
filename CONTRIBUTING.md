# Contributing

Use synthetic data only. Never attach a personal library or credentials. Keep the local, single-user, no-model workflows usable.

Before a change, read the product contract in `docs/specification/`. Run `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm audit` and `npm run check:public` on affected source. Browser tests use a temporary library and never the default daily-use port. For UI changes, inspect the actual page at desktop and narrow widths.

Explain a reproducible problem, resulting behavior and validation in a pull request. Preserve source versions, citation positions, human review, deletion propagation, preview/send consistency and failure semantics. Do not weaken requirements to make tests pass or treat a mock model as real-provider evidence.

The Chinese and English README files should remain materially equivalent and link to each other at the top.
