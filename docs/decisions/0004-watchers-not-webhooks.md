# 0004: Watchers (polling) for v0, webhooks for later

Date: 2026-04-30
Status: Accepted

## Context

For damson to be proactive, it needs to know about external changes — PRs reviewed, issues assigned, emails received. Two implementation models:

- **Push (webhooks)**: services POST events to a damson endpoint. Real-time, low overhead, but requires a public URL.
- **Pull (polling)**: damson asks each service "what changed since I last asked." Higher latency, but works on any machine.

## Decision

Watchers (polling) only for v0.x. Webhook receivers in a later version.

## Reasoning

damson is meant to install in 5 minutes on any machine — a $5 VPS, a Raspberry Pi, the user's laptop. Webhooks require:

- A public URL (not always available)
- DNS (often not configured)
- TLS (more setup)
- Per-service signature verification (work per integration)
- A reverse tunnel (Cloudflare Tunnel, Tailscale Funnel) when public URL isn't available

Polling needs none of this. It's slower (10-15 min latency typical) but it works everywhere on day one.

## Implementation shape

A "watcher" is a small YAML file in `brain/watchers/<name>.yaml`:

```yaml
name: my-prs
poll_every: 10m
source: github_events
config:
  username: someone
  filter: pr_review_requested
```

The heartbeat ticks watchers on schedule. Each watcher's source has a `tick()` function that returns events. Events go through the EventBus → EventRouter, same as user messages and task completions.

## When this changes

When real users complain that "I want to know within 30 seconds that a PR landed." That's the threshold for adding a webhook receiver as an opt-in feature. Until then, polling is fine — the latency it adds is shorter than the response-time variance of a human.
