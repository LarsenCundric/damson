# 0006: First-run is mandatory and investigates the user

Date: 2026-04-30
Status: Accepted

## Context

Most agents start from zero context — you tell them what you want, they do it. damson aims to be **personal** — to know you. That requires context the user shouldn't have to dump into a settings form.

## Decision

First-run is a mandatory onboarding flow that:

1. Prompts pairing via Telegram `/start <token>`
2. Asks one starting question: "Got a GitHub username? I'll look around so I'm not starting blank."
3. In parallel: reads the user's GitHub profile, recent repos, recent activity, languages, top collaborators
4. Reports findings as a draft `self.md`: "Here's what I figured out — anything wrong?"
5. User corrects the draft inline in chat
6. damson asks 2-3 targeted follow-ups based on findings
7. damson proposes the first watcher ("Want me to watch X repo for PRs?")
8. First watcher activates

## Why mandatory

Without onboarding, damson on day-1 is "a Telegram interface to Claude with no opinion." The same as Open Interpreter, but on Telegram. That's a worse Open Interpreter, not a different product.

Mandatory onboarding means every damson install starts personalized. It also means setup ends with damson **doing his first proactive thing** — the value loop is demonstrated on day one.

## Why "investigate" instead of "configure"

Users won't fill in a 15-field config form. They will answer 3 questions in chat if the agent's already done the work of finding the obvious answers.

This shifts the cost from the user to damson. damson reads your public GitHub. Asks the small number of things he can't infer.

## Failure modes we've planned for

- **User has no GitHub.** Skip cleanly. Ask "what platforms do you use?" instead.
- **damson hallucinates findings ("you mostly write Rust" when you don't).** Always quote-source: "Based on your last 30 commits across 5 repos…" so the user can correct.
- **damson finds private/embarrassing info in a public profile.** Don't volunteer it. Stay focused on what's relevant for working together.
- **User abandons mid-flow.** Save partial state. Resume on next message.

## Onboarding doesn't end on day 1

After day 1, damson keeps a `setup-2.md` queue: "things I should ask the user about when they have a minute." Every week or two, surface one in the morning brief. Continuous onboarding instead of a one-shot wizard.

## Consequences

- damson can't function without `self.md`. If onboarding is incomplete, every message routes back to "let's finish setting up."
- Onboarding is the most failure-prone code in v0.x. Treat it as the highest-risk surface to test.
