# 0002: Anthropic-only for v0.x

Date: 2026-04-30
Status: Accepted

## Context

Hermes Agent ships with provider-agnostic LLM transport (OpenAI-compat HTTP everywhere). It supports 20+ providers. This is its strongest architectural decision.

Should damson copy this?

## Decision

No, not for v0.x. Anthropic only. Both for damson's reasoning loop and for Claude Code as the task engine.

## Reasoning

Provider-agnosticism is a feature for a framework. damson is not a framework — it's an opinionated agent for one user. Multiple providers means:

- More abstraction layers in the agent loop
- Tool-calling shape differences between providers (Anthropic uses one schema, OpenAI another)
- Fragmented testing surface — "does this work on Llama? Gemini? Mistral?"
- Spec creep on the brain prompt (different models respond to different system-prompt styles)

We pick Anthropic because:

- Claude Code is the spawned-worker engine. CC is Anthropic-native. Multiple LLM transport without multiple worker engines is half-async.
- Tool calling in Claude is well-shaped for the kinds of tools we have.
- One provider = one place to debug. v0.x debugging time is precious.

## When this changes

If damson reaches v1.0 and there's a real demand for "use my local Llama" or "use OpenAI to save money," we revisit. The cost is real (~1 week of refactoring through the agent loop). The benefit is wide-audience reach. v0.x doesn't need wide-audience reach yet.
