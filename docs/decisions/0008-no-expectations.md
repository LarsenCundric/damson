# 0008: No `expect_event` primitive — watchers cover the use case

Date: 2026-04-30
Status: Accepted

## Context

Boris had an `expect_event` tool — the agent could register "ping me when X happens" patterns that got matched against future events on the bus. When a matching event fired, the user got an auto-announce.

It was useful but it also tangled with the routing logic. The router had to consult two registries (policy table + expectations) on every event, expectations had TTLs, prefix matches caused unintended consumption of nudge events (the v5.16.x bug we spent a day debugging).

## Decision

damson does not ship `expect_event`. The same use cases are covered by:

1. **Watchers** with `notify=always` — "ping me when a PR review comes in" is exactly what `github_events` does.
2. **`task.done.success` system events** — completion of a `code_task` already wakes the agent, who decides whether to surface to the user.
3. **One-shot reminders** — for "remind me at 3pm tomorrow", we'll add `remind_once` later as its own scheduling primitive (deferred to v0.6).

## Rationale

Watchers + routing tiers (ask/always/digest_only) form a clearer contract than `expect_event`'s match-anything-on-the-bus model. The user picks the watcher type and the tier; the agent doesn't have to invent expectation patterns.

The thing we'd lose: ad-hoc "ping me when X" registrations the agent creates mid-conversation. In practice this was Boris making promises it then dropped because the expectation pattern didn't match what actually fired. Watchers are pre-declared and observable in `/schedules` and `brain/watchers/` — easier to audit.

## Consequences

- No `expectations.ts` module.
- No `expect_event` tool.
- Agent learns to either (a) propose adding a watcher, or (b) tell the user honestly "I can't reliably ping you when X without a watcher — want me to set one up?"
- `remind_once` is the planned hole for time-based one-shots.
