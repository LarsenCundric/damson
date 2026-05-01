# 0001: TypeScript over JavaScript or Go

Date: 2026-04-30
Status: Accepted

## Context

The predecessor project was written in plain JavaScript. It accumulated a class of bugs that types would catch:

- Tool input shape mismatches (passing a number where a string was expected, undefined property accesses)
- Event payload shape drift (different parts of the codebase assumed different fields)
- Silent typos in dispatch logic

We considered three options for the OSS rewrite: stay JS, port to TypeScript, or rewrite in Go.

## Decision

TypeScript.

## Why not JavaScript

A public OSS codebase needs to be readable to drive-by contributors. Untyped JS forces every reader to derive shapes from runtime evidence. Even a single PR-sized contribution becomes harder than it should be.

## Why not Go

Go would give us single-binary distribution (compelling for "curl-bash to install"), strong concurrency primitives for watchers and supervisors, and tighter types. But:

- Agent loops and tool-calling code are noisier in Go. The Anthropic SDK in Go is less mature than in TypeScript.
- The contributor pool that wants to write Go agent code is smaller than the JS/TS pool. Hermes is winning Python mindshare; Aider is Python; Open Interpreter is Python. There is no major TS-native agent. That's a niche to occupy.
- The maintainer (Larsen) is faster in TS. Contributor velocity matters more than community size at v0.x.

## Why not Python

Python is the consensus language for agents right now. We're deliberately not in that lane. Hermes and Open Interpreter dominate it. The TS/Node story is comparatively empty, and Telegram bots are well-served by grammY.

## Consequences

- Build step required (`tsc`). Distribution ships compiled output in `dist/`.
- `node:test` for tests; we may revisit.
- Strict mode on by default — catches most of the bug class we care about.
