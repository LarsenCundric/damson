/**
 * Brain — markdown filesystem memory.
 *
 * Loads identity (soul.md), personal context (self.md), preferences,
 * project notes, daily logs. Saves with dedup on append.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = (() => {
  // Resolve template dir relative to this file. After build, dist/brain.js,
  // templates live alongside the repo's brain/templates/.
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/brain.js → ../../brain/templates  (when running via npm start)
    // src/brain.ts → ../brain/templates       (during dev)
    const candidates = [join(here, '..', '..', 'brain', 'templates'), join(here, '..', 'brain', 'templates')];
    for (const c of candidates) if (existsSync(c)) return c;
  } catch {}
  return null;
})();

export class Brain {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    for (const sub of ['daily', 'people', 'projects', 'decisions', 'transcripts', 'watchers', 'digests']) {
      mkdirSync(join(this.dir, sub), { recursive: true });
    }
    this.bootstrapTemplates();
  }

  /** Copy template files (soul.md, self.md, config.json) on first run. */
  private bootstrapTemplates(): void {
    if (!TEMPLATE_DIR) return;
    for (const f of ['soul.md', 'self.md', 'config.json']) {
      const target = join(this.dir, f);
      const source = join(TEMPLATE_DIR, f);
      if (!existsSync(target) && existsSync(source)) {
        copyFileSync(source, target);
      }
    }
  }

  today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  read(subpath: string): string | null {
    const file = join(this.dir, subpath);
    return existsSync(file) ? readFileSync(file, 'utf-8') : null;
  }

  /** Append content to brain/<subdir>/<name>.md, dedup'd. */
  save(subdir: string, name: string, content: string): boolean {
    const dir = join(this.dir, subdir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    const trimmed = content.trim();
    if (!trimmed) return false;
    const normalize = (s: string) => s.replace(/^-?\s*(?:\d{2}:\d{2}|\d{4}-\d{2}-\d{2})[:\s-]*/gm, '').trim().toLowerCase();
    const needle = normalize(trimmed);
    if (needle.length > 0 && existsSync(file)) {
      const existing = readFileSync(file, 'utf-8');
      if (normalize(existing).includes(needle)) {
        console.log(`[brain] dedup skip: ${subdir}/${name}`);
        return true;
      }
    }
    appendFileSync(file, (existsSync(file) ? '\n' : '') + trimmed + '\n');
    return true;
  }

  overwrite(subpath: string, content: string): void {
    const file = join(this.dir, subpath);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }

  /** Tails of files modified in the last N hours, capped per entry. */
  recentSaves(opts: { hours?: number; maxEntries?: number; maxCharsPerEntry?: number } = {}): string {
    const { hours = 48, maxEntries = 8, maxCharsPerEntry = 400 } = opts;
    const cutoffMs = Date.now() - hours * 3600 * 1000;
    const all: Array<{ path: string; mtime: number; tail: string }> = [];
    for (const subdir of ['projects', 'decisions', 'daily']) {
      const dir = join(this.dir, subdir);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const path = join(dir, f);
        try {
          const s = statSync(path);
          if (s.mtimeMs < cutoffMs) continue;
          const content = readFileSync(path, 'utf-8');
          if (content.trim().length < 20) continue;
          const tail =
            content.length > maxCharsPerEntry
              ? '...(earlier content truncated)...\n' + content.slice(-maxCharsPerEntry)
              : content;
          all.push({
            path: `${subdir}/${f.replace(/\.md$/, '')}`,
            mtime: s.mtimeMs,
            tail: tail.trim(),
          });
        } catch {}
      }
    }
    all.sort((a, b) => b.mtime - a.mtime);
    const top = all.slice(0, maxEntries);
    if (top.length === 0) return '';
    return top.map((e) => `### ${e.path}\n${e.tail}`).join('\n\n');
  }

  /** Keyword-substring search with temporal decay. */
  search(query: string, limit = 5): Array<{ file: string; relevance: number; snippet: string }> {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return [];
    const results: Array<{ file: string; relevance: number; snippet: string; mtime: number }> = [];
    const HALF_LIFE_DAYS = 14;
    const lambda = Math.LN2 / HALF_LIFE_DAYS;
    for (const subdir of ['daily', 'decisions', 'people', 'projects']) {
      const dir = join(this.dir, subdir);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        const path = join(dir, f);
        let s;
        try {
          s = statSync(path);
        } catch {
          continue;
        }
        const content = readFileSync(path, 'utf-8');
        const lower = content.toLowerCase();
        const matches = keywords.filter((k) => lower.includes(k));
        if (matches.length === 0) continue;
        const ageDays = (Date.now() - s.mtimeMs) / 86_400_000;
        const decay = Math.exp(-lambda * ageDays);
        const relevance = matches.length * decay;
        const idx = lower.indexOf(matches[0]);
        const snippet = content.slice(Math.max(0, idx - 50), idx + 250).replace(/\s+/g, ' ').trim();
        results.push({
          file: `${subdir}/${f.replace(/\.md$/, '')}`,
          relevance,
          snippet,
          mtime: s.mtimeMs,
        });
      }
    }
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit).map(({ file, relevance, snippet }) => ({ file, relevance, snippet }));
  }
}
