---
description: Draft a new Architecture Decision Record in docs/adr/NNNN-<slug>.md
---

# Architecture Decision Record (ADR) Workflow

Execute this workflow when a technical or architectural decision needs to be formally recorded in `docs/adr/`.

## Steps

1. Prompt the user for the architectural decision topic if not already provided.
2. Check existing files in `docs/adr/` to determine the next sequential 4-digit number `NNNN` (e.g., `0009`).
3. Generate a kebab-case slug for the topic (e.g., `0009-message-retry-strategy.md`).
4. Draft the ADR file at `docs/adr/NNNN-<slug>.md` with the following mandatory sections:
   - `# NNNN: <Title>`
   - `## Context`: Problem statement, business/operational drivers, and constraints.
   - `## Options Considered`: At least 3 viable technical options, with detailed Pros and Cons for each.
   - `## Decision`: Chosen option, concrete technology choices, and architectural implementation details.
   - `## Consequences`: Explicit positive benefits and negative trade-offs.
   - `## What would make us revisit this`: Specific scaling limits, operational conditions, or requirements that would trigger re-evaluating the choice.
   - `## My reasoning`: Leave this section completely empty (with `<!-- To be filled in by developer -->`) for the developer to write their personal rationale.
5. Review the drafted document with the user.
