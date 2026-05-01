# 0005: Always log, sometimes ping

Date: 2026-04-30
Status: Accepted

## Context

A proactive agent that pings you for everything becomes wallpaper within a week. Users learn to dismiss notifications without reading. The high-signal ping ("PR #16 is blocking your merge") gets the same flick as the low-signal one ("3 PRs merged in repos you starred").

The challenge: damson notices a lot. The user has limited attention. How do we connect them?

## Decision

Three delivery tiers:

- **Hot (Telegram interrupt)**: things you'd want to know within 10 minutes. Examples: a PR you opened got reviewed. An email from a flagged sender. A watcher's threshold tripped (e.g. "conversion rate dropped 30%").
- **Soft (morning brief)**: things you want to know about, but not now. Examples: PRs merged in repos you watch. Daily Datafast summary. Background task completed an investigation.
- **Silent (brain only)**: things damson noticed and recorded but never told you. Available via `memory_search` if you ask. Examples: low-confidence findings, routine cron output, long-tail watcher events.

Default to silent or soft. Hot is opt-in per watcher.

## How damson decides which tier

For watcher events: per-watcher config. Defaults conservatively (soft). User corrects ("ping me sooner on this") → preference stored → tier escalates next time.

For task completions: classified by the agent, not by the router. Boring success ("ran test suite, all green") → soft or silent. Important success ("PR opened against master") → hot. Failures → always hot.

For autonomous-think wakes: only ping if the agent has something user-visible to add. Otherwise just update brain.

## Why this matters

If damson pings you 5 times a day, you'll uninstall it. If damson pings you 1-2 times a day with things that mattered, plus a useful morning brief, you'll keep it.

The bar is high. Tightening signal is the feature.

## Consequences

- The morning brief is the daily payoff. It needs to be excellent — not just a list of events, but a narrative summary.
- Every watcher and event source has to declare a default tier.
- Per-watcher tier overrides are stored in `brain/preferences.md` (so the user can audit them).
