# 0003: Claude Code as the only task engine

Date: 2026-04-30
Status: Accepted

## Context

When damson needs to do real coding work — multi-file edits, debugging, running test suites — it spawns a separate process to do that work. The "task engine" is what runs in that subprocess.

Options: Claude Code (CC), Codex CLI, Aider, OpenCode, custom subprocess wrapping the Anthropic SDK.

## Decision

Claude Code only.

## Reasoning

CC has a few properties that are hard to reproduce:

- Built-in tool surface (file edit, bash, search, web fetch) without us having to maintain it
- Plays well with detached subprocess invocation (`claude -p "..."` returns when done)
- `--session-id` and `--resume` give us session continuity for follow-up tasks
- Stream JSON output format means we can parse progress in real time

The alternatives all introduce coupling pain:

- Codex CLI: OpenAI-only, different tool surface, less mature for headless use
- Aider: file-edit-focused, doesn't handle ad-hoc bash work well
- Custom: would require us to reimplement the entire CC tool surface, a year of work for no gain

## Consequences

- damson hard-requires `claude` CLI on PATH for `code_task` to work
- Users must authenticate Claude Code separately (`claude /login`)
- The brain doesn't try to teach CC anything — every CC invocation is a fresh session unless explicit `--resume`

## When this changes

If a real competitor to CC ships with comparable quality and a different model behind it (e.g. a Gemini-based CLI that's measurably better for long agent runs), we add it as an alternative engine. The interface in `supervisor.ts` is small enough to make this swap not-painful — but until that competitor exists, single engine.
