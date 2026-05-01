# 0007: No "dreaming" / 6h memory consolidation

Date: 2026-04-30
Status: Accepted

## Context

Boris had a `dreaming.js` module that ran every 6 hours, read recent activity, and wrote consolidated narratives to `brain/dreams/<date>.md`. Each dream cycle re-ingested the previous dream as input. Pattern: light sleep → REM → deep sleep → promote insights.

In practice it produced two problems:

1. **Compounding hallucinations.** A single misremembering ("Datadog deployment system is broken") got cited by the next dream, which got cited by the next, until the brain had an entire fictional infrastructure system documented across 5 days of dream entries. The user had to manually scrub them.

2. **Net-negative signal density.** Dreams were flowery prose summaries that the agent then had to filter through to find anything useful. Real signal (a decision, a TODO, a finding) was already being captured by `memory_save`. Dreams added narrative on top without adding new information.

## Decision

damson does not include any dreaming / consolidation / autonomous-narrative module. The brain is what `memory_save` and `code_task` outputs put into it — flat markdown files, no auto-generated narratives.

## Rationale

The OpenClaw / Hermes pattern of "agent reflects on its own memory" sounds appealing. In practice for a personal assistant it's a recursive-citation amplifier of any error. The simpler design — agent writes facts as it learns them, never reads its own poetry — is more reliable.

If a real "consolidation" use case emerges (e.g. `memory_search` over hundreds of project files needs an index), we add that as a deterministic indexing job, not as another agent loop reading another agent's prose.

## Consequences

- No `brain/dreams/` directory. No 6h schedule. No "promoted insights" file.
- The morning brief (separate feature, see `morning-brief.ts`) consumes `brain/digests/` items written by silent watchers and schedules — these are factual, not narrative.
- If a user really wants dreaming, they can write a `type: 'agent'` schedule with a "reflect on this week's brain" prompt. It's opt-in, not built-in.
