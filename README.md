# damson

Proactive personal agent for devs who actually ship.

> **Status: 0.1 — early days. Working name. APIs will break.**

## What it is

damson lives on a server you own (a $5 VPS, a Raspberry Pi, your laptop). You talk to it on Telegram. It watches the things you care about — your GitHub queue, your repos, your analytics — and pushes work forward while you're not looking. When you ask it to do something, it spawns Claude Code workers to actually do it.

Not a framework. Not a chat shell. An agent for one user that gets shit done.

## Install

```bash
git clone https://github.com/LarsenCundric/damson ~/damson
cd ~/damson
npm install
npm run build
cp .env.example .env
# fill in ANTHROPIC_API_KEY and BOT_TOKEN
npm start
```

On first run, damson prints a `https://t.me/<your-bot>?start=<token>` link. Tap it from your phone — you're paired.

## Requirements

- Node 22+ (Node 24 recommended; `.nvmrc` pins it)
- Anthropic API key
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- `claude` CLI for code task workers (optional but most features need it)

## License

MIT
