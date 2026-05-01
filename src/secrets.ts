/**
 * Secret detection + redaction.
 *
 * Scans inputs for known API key patterns and redacts them before they
 * reach transcripts, brain files, or the LLM. Keeps a small in-memory
 * stash so the /secret command can pull the raw value out.
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, 'anthropic_key'],
  [/\blin_api_[a-zA-Z0-9]{32,}\b/g, 'linear_key'],
  [/\blin_oauth_[a-zA-Z0-9]{32,}\b/g, 'linear_oauth'],
  [/\bghp_[A-Za-z0-9]{36,}\b/g, 'github_pat'],
  [/\bgho_[A-Za-z0-9]{36,}\b/g, 'github_oauth'],
  [/\bghs_[A-Za-z0-9]{36,}\b/g, 'github_server'],
  [/\bghr_[A-Za-z0-9]{36,}\b/g, 'github_refresh'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, 'github_fine_pat'],
  [/\bsk-proj-[a-zA-Z0-9_-]{20,}\b/g, 'openai_proj'],
  [/\bsk-[a-zA-Z0-9]{40,}\b/g, 'openai_key'],
  [/\bxox[baprs]-[0-9]+-[0-9]+-[0-9]+-[a-zA-Z0-9]+\b/g, 'slack_token'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, 'aws_access_key'],
  [/\bsk_live_[a-zA-Z0-9]{24,}\b/g, 'stripe_live'],
  [/\brk_live_[a-zA-Z0-9]{24,}\b/g, 'stripe_restricted'],
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, 'telegram_bot_token'],
  [/\bre_[a-zA-Z0-9_]{20,}\b/g, 'resend_key'],
  [/\bbu_[a-zA-Z0-9_-]{20,}\b/g, 'browser_use_key'],
  [/\bdf_[a-zA-Z0-9]{32,}\b/g, 'datafast_key'],
];

export interface Found {
  kind: string;
  length: number;
}

export interface RedactionResult {
  text: string;
  found: Found[];
}

export function redactSecrets(text: string): RedactionResult {
  if (typeof text !== 'string' || !text) return { text: text || '', found: [] };
  let redacted = text;
  const found: Found[] = [];
  for (const [pattern, kind] of PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      found.push({ kind, length: match.length });
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: redacted, found };
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text).found.length > 0;
}

// Map detected kind → canonical env var name for /secret auto-naming.
export const KIND_TO_ENV: Record<string, string> = {
  openai_proj: 'OPENAI_API_KEY',
  openai_key: 'OPENAI_API_KEY',
  anthropic_key: 'ANTHROPIC_API_KEY',
  browser_use_key: 'BROWSER_USE_API_KEY',
  linear_key: 'LINEAR_API_KEY',
  linear_oauth: 'LINEAR_API_KEY',
  github_pat: 'GITHUB_TOKEN',
  github_oauth: 'GITHUB_TOKEN',
  github_fine_pat: 'GITHUB_TOKEN',
  slack_token: 'SLACK_BOT_TOKEN',
  aws_access_key: 'AWS_ACCESS_KEY_ID',
  stripe_live: 'STRIPE_SECRET_KEY',
  stripe_restricted: 'STRIPE_RESTRICTED_KEY',
  telegram_bot_token: 'TELEGRAM_BOT_TOKEN',
  resend_key: 'RESEND_API_KEY',
  datafast_key: 'DATAFAST_API_KEY',
};
