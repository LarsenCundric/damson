/**
 * Tests for the watcher registry and the two built-in watchers.
 * fetch is stubbed via globalThis.fetch override.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/event-bus.ts';
import { WatcherRegistry, registerWatcherType } from '../src/watchers.ts';
import { registerBuiltinWatchers } from '../src/watcher-types.ts';
import type { Event } from '../src/types.ts';

// Register built-ins once for all tests in this file
registerBuiltinWatchers(registerWatcherType);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'damson-test-watchers-'));
  mkdirSync(join(dir, 'watchers'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeWatcher(dir: string, name: string, body: string) {
  writeFileSync(join(dir, 'watchers', `${name}.yaml`), body);
}

interface FetchCall {
  url: string;
  headers?: Record<string, string>;
}

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  let idx = 0;
  const original = globalThis.fetch;
  // @ts-expect-error stub
  globalThis.fetch = async (url: string, opts: { headers?: Record<string, string> } = {}) => {
    calls.push({ url: String(url), headers: opts.headers });
    const r = responses[Math.min(idx, responses.length - 1)];
    idx++;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => r.body,
    } as unknown as Response;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('registry loads valid yaml watcher', () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(dir, 'one', 'name: one\ntype: http_poll\npoll_every: 5m\nnotify: ask\nconfig:\n  url: https://example.com\n');
    const bus = new EventBus();
    const reg = new WatcherRegistry(dir, bus);
    reg.load();
    const list = reg.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'one');
    assert.equal(list[0].type, 'http_poll');
    assert.equal(list[0].pollEveryMs, 5 * 60_000);
    assert.equal(list[0].notify, 'ask');
  } finally {
    cleanup();
  }
});

test('registry skips unknown type with error log', () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(dir, 'bad', 'name: bad\ntype: nonexistent\nconfig: {}\n');
    const bus = new EventBus();
    const reg = new WatcherRegistry(dir, bus);
    reg.load();
    assert.equal(reg.list().length, 0);
  } finally {
    cleanup();
  }
});

test('registry skips malformed yaml', () => {
  const { dir, cleanup } = setup();
  try {
    writeFileSync(join(dir, 'watchers', 'broken.yaml'), '::not yaml::');
    const bus = new EventBus();
    const reg = new WatcherRegistry(dir, bus);
    reg.load();
    assert.equal(reg.list().length, 0);
  } finally {
    cleanup();
  }
});

test('registry only ticks watchers past poll interval', async () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(dir, 'fast', 'name: fast\ntype: http_poll\npoll_every: 1s\nconfig:\n  url: https://example.com\n');
    const bus = new EventBus();
    const reg = new WatcherRegistry(dir, bus);
    reg.load();
    const stub = stubFetch([{ body: 'response1' }, { body: 'response2' }]);
    try {
      await reg.tick();
      // Second tick immediately — should be skipped (interval not elapsed)
      await reg.tick();
      assert.equal(stub.calls.length, 1, 'second tick within interval should be skipped');
    } finally {
      stub.restore();
    }
  } finally {
    cleanup();
  }
});

test('http_poll: no event on first tick, then on change', async () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(
      dir,
      'price',
      'name: price\ntype: http_poll\npoll_every: 1s\nconfig:\n  url: https://api.example.com/price\n  accept_jsonpath: data.value\n'
    );
    const bus = new EventBus();
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const reg = new WatcherRegistry(dir, bus);
    reg.load();

    const stub = stubFetch([
      { body: { data: { value: 100 } } },
      { body: { data: { value: 100 } } }, // same — no event
      { body: { data: { value: 110 } } }, // changed — emit
    ]);
    try {
      await reg.tick();
      // Wait > 1s so next tick fires
      await new Promise((r) => setTimeout(r, 1100));
      await reg.tick();
      await new Promise((r) => setTimeout(r, 1100));
      await reg.tick();
      assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
      assert.equal(events[0].type, 'watcher.price');
      const p = events[0].payload as { previous: string; current: string };
      assert.equal(p.previous, '100');
      assert.equal(p.current, '110');
    } finally {
      stub.restore();
    }
  } finally {
    cleanup();
  }
});

test('http_poll persists state across registry reloads', async () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(
      dir,
      'persist',
      'name: persist\ntype: http_poll\npoll_every: 1s\nconfig:\n  url: https://api.example.com/x\n'
    );
    const bus = new EventBus();
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));

    const stub = stubFetch([{ body: 'v1' }, { body: 'v2' }]);
    try {
      const reg1 = new WatcherRegistry(dir, bus);
      reg1.load();
      await reg1.tick(); // baseline → no event

      // Verify state file exists
      const stateFile = join(dir, 'watchers', 'persist.state.json');
      assert.ok(existsSync(stateFile), 'state file should exist');
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      assert.equal(state.lastValue, 'v1');

      // New registry instance simulates restart
      const reg2 = new WatcherRegistry(dir, bus);
      reg2.load();
      // Wait so poll interval elapses
      await new Promise((r) => setTimeout(r, 1100));
      await reg2.tick();
      assert.equal(events.length, 1, 'should emit event because lastValue v1 != current v2');
    } finally {
      stub.restore();
    }
  } finally {
    cleanup();
  }
});

test('github_events: emits per unread notification, dedups across ticks', async () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(
      dir,
      'gh',
      'name: gh\ntype: github_events\npoll_every: 1s\nconfig:\n  token_env: TEST_GH_TOKEN\n'
    );
    process.env.TEST_GH_TOKEN = 'fake-token';

    const bus = new EventBus();
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const reg = new WatcherRegistry(dir, bus);
    reg.load();

    const fakeNotifications = [
      {
        id: '1',
        reason: 'review_requested',
        updated_at: '2026-04-30T10:00:00Z',
        unread: true,
        subject: { title: 'Add feature X', type: 'PullRequest', url: 'https://api.github.com/repos/me/repo/pulls/42' },
        repository: { full_name: 'me/repo' },
      },
      {
        id: '2',
        reason: 'mention',
        updated_at: '2026-04-30T10:01:00Z',
        unread: true,
        subject: { title: 'Review needed', type: 'PullRequest', url: 'https://api.github.com/repos/me/repo/pulls/43' },
        repository: { full_name: 'me/repo' },
      },
      {
        id: '3',
        reason: 'subscribed',
        updated_at: '2026-04-30T10:02:00Z',
        unread: true,
        subject: { title: 'Random', type: 'Issue' },
        repository: { full_name: 'other/repo' },
      },
    ];

    const stub = stubFetch([{ body: fakeNotifications }, { body: fakeNotifications }]);
    try {
      await reg.tick();
      // Two events: review_requested + mention. NOT 'subscribed' (filtered)
      assert.equal(events.length, 2, `expected 2 events, got ${events.length}: ${events.map((e) => (e.payload as { reason: string }).reason).join(',')}`);
      const p0 = events[0].payload as { repo: string; reason: string; url: string; title: string };
      assert.equal(p0.repo, 'me/repo');
      assert.equal(p0.reason, 'review_requested');
      assert.match(p0.url, /github\.com\/me\/repo\/pull\/42/);

      // Second tick same data — should dedup, no new events
      await new Promise((r) => setTimeout(r, 1100));
      await reg.tick();
      assert.equal(events.length, 2, 'no dupes on re-poll');
    } finally {
      stub.restore();
    }
  } finally {
    delete process.env.TEST_GH_TOKEN;
    cleanup();
  }
});

test('github_events: throws when token missing', async () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(
      dir,
      'gh-notoken',
      'name: gh-notoken\ntype: github_events\npoll_every: 1s\nconfig:\n  token_env: NEVER_SET_TOKEN\n'
    );
    delete process.env.NEVER_SET_TOKEN;
    const bus = new EventBus();
    const reg = new WatcherRegistry(dir, bus);
    reg.load();
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    // Should log error but not crash
    await reg.tick();
    assert.equal(events.length, 0);
  } finally {
    cleanup();
  }
});

test('http_poll: env expansion in headers', async () => {
  const { dir, cleanup } = setup();
  try {
    writeWatcher(
      dir,
      'auth',
      'name: auth\ntype: http_poll\npoll_every: 1s\nconfig:\n  url: https://api.example.com/x\n  headers:\n    Authorization: "Bearer ${env:MY_TEST_TOKEN}"\n'
    );
    process.env.MY_TEST_TOKEN = 'secret-123';
    const bus = new EventBus();
    const reg = new WatcherRegistry(dir, bus);
    reg.load();
    const stub = stubFetch([{ body: 'ok' }]);
    try {
      await reg.tick();
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].headers?.Authorization, 'Bearer secret-123');
    } finally {
      stub.restore();
      delete process.env.MY_TEST_TOKEN;
    }
  } finally {
    cleanup();
  }
});
