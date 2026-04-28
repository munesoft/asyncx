# @munesoft/asyncx

> **One function. Total async control.**

![version](https://img.shields.io/badge/version-1.204.11-teal)
![tests](https://img.shields.io/badge/tests-53%20passing-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-blue)
![license](https://img.shields.io/badge/license-MIT-orange)
![node](https://img.shields.io/badge/node-%3E%3D14.0.0-green)
![types](https://img.shields.io/badge/types-TypeScript-informational)

The unified async execution engine for JavaScript and Node.js. Handle **retries**, **timeouts**, **caching**, **concurrency**, **cancellation**, and **circuit breakers** — all from a single, composable API.

---

## Why asyncx?

Async operations in JavaScript are fragmented. A typical production codebase pulls in:

- `p-retry` or `async-retry` for retry logic
- `p-timeout` for timeout wrapping  
- `p-limit` or `bottleneck` for concurrency limiting
- `lru-cache` or `node-cache` for caching
- Custom `AbortController` utilities for cancellation
- `opossum` for circuit breaking

That's **6 dependencies**, 6 different APIs, and no way to compose them together cleanly.

`asyncx` replaces all of them with one consistent API that composes naturally.

```js
// Before: 6 libraries, scattered logic, no composition
const result = await pRetry(
  () => pTimeout(fetchUser(id), { milliseconds: 2000 }),
  { retries: 3 }
);

// After: one function, everything works together
const result = await asyncx(fetchUser, {
  retry: 3,
  timeout: 2000,
  cache: { key: `user:${id}`, ttl: 60_000 },
});
```

---

## Features

| Feature | Description |
|---|---|
| 🔁 **Retry Engine** | Fixed, exponential, and jitter backoff with custom conditions |
| ⏱️ **Timeout Control** | Per-attempt timeout via `AbortController` |
| 💾 **First-Class Caching** | TTL, keyed cache, stale-while-revalidate, pluggable stores |
| 🔀 **Promise Deduplication** | Concurrent calls with the same key share one execution |
| 🚦 **Concurrency Limiting** | Queue and cap parallel async tasks |
| 🛑 **Cancellation** | Full `AbortSignal` support throughout |
| ⚡ **Circuit Breaker** | Auto-open/close with threshold and cooldown |
| 🎣 **Hooks** | `onStart`, `onRetry`, `onSuccess`, `onError`, `onCacheHit`, `onCacheMiss` |
| 🏁 **Race** | Resolve with the fastest of multiple async tasks |
| 🛡️ **Safe Mode** | Returns `[value, null] | [null, error]` — no try/catch needed |
| 📦 **Tree-Shakable** | ESM + CJS, zero runtime dependencies |
| 🔷 **Full TypeScript** | Generics, inference, strict types throughout |

---

## Installation

```bash
npm install @munesoft/asyncx
# or
yarn add @munesoft/asyncx
# or
pnpm add @munesoft/asyncx
```

**Requirements:** Node.js 14+ (uses native `AbortController` and `DOMException`)

---

## Quick Start

```js
import asyncx from "@munesoft/asyncx";

// Retry 3 times with 2s timeout and cache for 60 seconds
const user = await asyncx(fetchUser, {
  retry: 3,
  timeout: 2000,
  cache: { key: "user:123", ttl: 60_000 },
});
```

---

## Core Concepts

### The `task` function

Every task receives an `AbortSignal` as its first argument. Passing this to your `fetch` calls and other async operations enables true cancellation:

```js
const task = async (signal) => {
  const res = await fetch("/api/user", { signal }); // ← pass signal here
  return res.json();
};

await asyncx(task, { timeout: 5000 });
```

If you don't need cancellation, you can ignore the signal:

```js
await asyncx(async () => getData(), { retry: 3 });
```

---

## API Reference

### `asyncx(task, options?)` → `Promise<T>`

The main execution function. Wraps any async task with full execution controls.

```ts
await asyncx(task, {
  // Retry
  retry: 3,                      // number of retries, or custom condition function
  delay: 200,                    // base delay in ms between retries (default: 100)
  backoff: "exponential",        // "fixed" | "exponential" | "jitter" (default: "fixed")
  maxDelay: 30_000,              // cap on retry delay in ms

  // Timeout
  timeout: 5000,                 // ms before the attempt is aborted

  // Cancellation
  signal: controller.signal,    // external AbortSignal

  // Fallback
  fallback: (err) => null,       // returned on final error instead of throwing

  // Cache (see full cache docs below)
  cache: { key: "my-key", ttl: 5000 },

  // Circuit breaker
  circuit: { threshold: 5, cooldown: 10_000 },

  // Lifecycle hooks
  hooks: {
    onStart: ({ attempt }) => {},
    onRetry: ({ attempt, error }) => {},
    onSuccess: ({ result, duration }) => {},
    onError: ({ error, duration }) => {},
    onCacheHit: ({ key }) => {},
    onCacheMiss: ({ key }) => {},
  },
});
```

---

### Timeout

Cancels execution after `timeout` milliseconds. Each retry attempt gets a fresh timeout — the limit is per-attempt, not total.

```js
await asyncx(fetchData, { timeout: 2000 }); // throws TimeoutError after 2s
```

```js
import { TimeoutError } from "@munesoft/asyncx";

try {
  await asyncx(fetchData, { timeout: 2000 });
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log("Request took too long");
  }
}
```

---

### Retry

```js
// Retry up to 3 times with fixed 200ms delay
await asyncx(fn, { retry: 3, delay: 200 });

// Exponential backoff: 100ms → 200ms → 400ms → ...
await asyncx(fn, { retry: 5, delay: 100, backoff: "exponential" });

// Jitter (randomized exponential) — avoids thundering herd
await asyncx(fn, { retry: 5, delay: 100, backoff: "jitter" });

// Cap maximum delay
await asyncx(fn, { retry: 10, delay: 100, backoff: "exponential", maxDelay: 5000 });
```

**Smart retry conditions** — only retry on specific errors:

```js
// Only retry on server errors (5xx), not client errors (4xx)
await asyncx(fn, {
  retry: (error) => error.status >= 500,
  delay: 500,
  backoff: "exponential",
});

// Retry on network errors or specific status codes
await asyncx(fn, {
  retry: (error) => error.code === "ECONNRESET" || error.status === 429,
  delay: 1000,
});
```

---

### Cancellation

Use `asyncx.controller()` (a thin wrapper around `AbortController`) to cancel in-flight operations:

```js
const controller = asyncx.controller();

// Start the operation
const promise = asyncx(longRunningTask, { signal: controller.signal });

// Cancel it
controller.abort();

try {
  await promise;
} catch (err) {
  console.log("Cancelled"); // AbortError
}
```

Cancellation is propagated to the task via the `signal` argument, and also cancels any pending retry delays. It does **not** trigger retries.

---

### Caching

Caching is a first-class feature in `asyncx`, not an afterthought.

#### Basic cache (auto-keyed by function)

```js
await asyncx(fetchUser, { cache: true });
```

#### Explicit key

```js
await asyncx(fetchUser, { cache: { key: "user:123" } });
```

#### TTL (time-to-live)

```js
// Cache expires after 5 seconds
await asyncx(fetchUser, {
  cache: { key: "user:123", ttl: 5000 },
});
```

#### Dynamic key resolver

```js
const getUser = async (signal) => fetchUser(userId, signal);

await asyncx(getUser, {
  cache: { key: () => `user:${userId}` },
});
```

#### Stale-While-Revalidate

Return cached data immediately (even if expired), then refresh in the background:

```js
await asyncx(fetchConfig, {
  cache: { key: "app:config", ttl: 30_000, stale: true },
});
```

- First call: executes and caches the result
- Subsequent calls (cache valid): returns immediately ✅
- After TTL expires: returns the stale value instantly, refreshes in background ✅
- Next call after revalidation: returns the fresh value ✅

This pattern is ideal for configuration data, feature flags, or any data where a slightly stale value is better than blocking.

---

### Promise Deduplication

If multiple concurrent calls share the same cache key, only one request is made. All callers await the same promise:

```js
// These 3 calls result in exactly 1 HTTP request
const [a, b, c] = await Promise.all([
  asyncx(fetchUser, { cache: { key: "user:123" } }),
  asyncx(fetchUser, { cache: { key: "user:123" } }),
  asyncx(fetchUser, { cache: { key: "user:123" } }),
]);
// a === b === c
```

This is critical for high-traffic scenarios — if a cache entry expires under load, you don't want 500 simultaneous requests hitting your database. `asyncx` coalesces them into one.

---

### Cache Invalidation

```js
// Invalidate a specific key
asyncx.cache.clear("user:123");

// Wipe the entire cache
asyncx.cache.clearAll();
```

---

### Custom Cache Store

The default in-memory store is suitable for most use cases. For distributed caching (Redis, Memcached) or custom eviction policies, plug in your own store:

```js
import asyncx, { MemoryStore } from "@munesoft/asyncx";

// Custom store implementing CacheStore interface
const redisStore = {
  async get(key) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : undefined;
  },
  async set(key, entry) {
    const ttl = entry.expiresAt ? Math.ceil((entry.expiresAt - Date.now()) / 1000) : 0;
    if (ttl > 0) await redis.setex(key, ttl, JSON.stringify(entry));
    else await redis.set(key, JSON.stringify(entry));
  },
  async delete(key) { await redis.del(key); },
  async clear() { await redis.flushdb(); },
  async keys() { return redis.keys("*"); },
};

asyncx.cache.use(redisStore);
```

All subsequent `asyncx` calls will use this store.

---

### Concurrency Control

#### `asyncx.map(tasks, options)`

Process an array of tasks with a concurrency limit. Preserves result order.

```js
const urls = ["https://api.example.com/1", "https://api.example.com/2", /* ... */];

const results = await asyncx.map(
  urls.map((url) => (signal) => fetch(url, { signal }).then((r) => r.json())),
  { concurrency: 5 }  // max 5 requests at a time
);
```

All `asyncx` options work inside `.map()`:

```js
const results = await asyncx.map(tasks, {
  concurrency: 10,
  retry: 3,
  timeout: 5000,
  delay: 200,
  backoff: "exponential",
});
```

#### `asyncx.queue(tasks, options)`

Creates a queue you can add tasks to before running:

```js
const q = asyncx.queue(initialTasks, { concurrency: 3 });
q.add(extraTask);
const results = await q.run();
```

---

### Circuit Breaker

Automatically stops calling a failing service after a threshold of failures, then allows a retry after a cooldown period.

```js
const opts = {
  circuit: {
    threshold: 5,      // open after 5 consecutive failures
    cooldown: 10_000,  // try again after 10 seconds
  },
};

// First 5 calls fail → circuit opens
// 6th call throws CircuitOpenError immediately (no network call made)
// After 10 seconds → circuit goes "half-open", allows one attempt
// If that succeeds → circuit closes and normal operation resumes
```

```js
import { CircuitOpenError } from "@munesoft/asyncx";

try {
  await asyncx(callService, opts);
} catch (err) {
  if (err instanceof CircuitOpenError) {
    console.log("Service unavailable — circuit is open");
  }
}
```

Circuit state is shared across all calls that use the same `threshold` and `cooldown` values.

---

### Race

Resolves with the first task to complete. All other tasks are automatically cancelled:

```js
const result = await asyncx.race([
  (signal) => fetch("https://api-us.example.com/data", { signal }).then(r => r.json()),
  (signal) => fetch("https://api-eu.example.com/data", { signal }).then(r => r.json()),
]);
// Uses whichever region responds first
```

---

### Safe Mode

Avoid try/catch with the `safe` wrapper. Returns a `[value, error]` tuple:

```js
const [user, err] = await asyncx.safe(fetchUser);

if (err) {
  console.error("Failed:", err);
  return;
}

console.log(user);
```

Works as a standalone wrapper too:

```js
// Wrap any async function
const [config, err] = await asyncx.safe(() => loadConfig());
```

---

### Fallback

Return a default value instead of throwing on failure:

```js
const user = await asyncx(fetchUser, {
  retry: 3,
  fallback: () => ({ id: null, name: "Guest" }),
});
```

The fallback function receives the final error as an argument:

```js
const data = await asyncx(fetchData, {
  fallback: (error) => {
    console.error("Using cached fallback due to:", error.message);
    return cachedData;
  },
});
```

---

### Hooks

Instrument any execution for logging, metrics, or tracing:

```js
await asyncx(fetchUser, {
  hooks: {
    onStart: ({ attempt }) =>
      console.log(`Starting attempt ${attempt}`),

    onRetry: ({ attempt, error }) =>
      console.warn(`Retry #${attempt} after: ${error.message}`),

    onSuccess: ({ result, duration }) =>
      metrics.histogram("fetch.duration", duration),

    onError: ({ error, duration }) =>
      logger.error({ error, duration }, "Fetch failed"),

    onCacheHit: ({ key }) =>
      metrics.increment("cache.hit", { key }),

    onCacheMiss: ({ key }) =>
      metrics.increment("cache.miss", { key }),
  },
});
```

Hook callbacks are **fire-and-forget** — if a hook throws, it is silently ignored so hooks never affect execution.

---

## TypeScript

`asyncx` is written in TypeScript and ships with full type definitions. The return type is inferred from your task function:

```ts
import asyncx from "@munesoft/asyncx";
import type { Task, AsyncxOptions, CacheStore } from "@munesoft/asyncx";

// Type is inferred: Promise<User>
const user = await asyncx(
  async (signal): Promise<User> => {
    const res = await fetch("/api/user", { signal });
    return res.json();
  },
  { retry: 3, cache: { key: "user", ttl: 5000 } }
);

// Custom task type
const myTask: Task<User> = async (signal) => fetchUser(signal);

// Typed cache store
const myStore: CacheStore = { get, set, delete, clear, keys };
asyncx.cache.use(myStore);
```

---

## Comparison

### Feature comparison

| Feature | `asyncx` | `p-retry` | `p-timeout` | `p-limit` | `lru-cache` | `opossum` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Retry with backoff | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Timeout | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Caching + TTL | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Promise deduplication | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Stale-while-revalidate | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Concurrency limiting | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Cancellation (AbortSignal) | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Circuit breaker | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Composable (all together) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Zero dependencies | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| TypeScript native | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |

### Code comparison

**Retrying a fetch with timeout — before:**

```js
import pRetry from "p-retry";
import pTimeout from "p-timeout";

const result = await pRetry(
  () => pTimeout(fetch("/api/data").then(r => r.json()), { milliseconds: 2000 }),
  { retries: 3, minTimeout: 200, factor: 2 }
);
```

**After:**

```js
const result = await asyncx(
  (signal) => fetch("/api/data", { signal }).then(r => r.json()),
  { retry: 3, timeout: 2000, delay: 200, backoff: "exponential" }
);
```

---

**Concurrency limiting with retries — before:**

```js
import pLimit from "p-limit";
import pRetry from "p-retry";

const limit = pLimit(5);
const results = await Promise.all(
  tasks.map((task) => limit(() => pRetry(task, { retries: 3 })))
);
```

**After:**

```js
const results = await asyncx.map(tasks, { concurrency: 5, retry: 3 });
```

---

**Caching + deduplication — before:**

```js
const cache = new Map();
const inflight = new Map();

async function cachedFetch(key) {
  if (cache.has(key)) return cache.get(key); // no TTL!
  if (inflight.has(key)) return inflight.get(key);
  const promise = fetch(`/api/${key}`).then(r => r.json()).then(data => {
    cache.set(key, data);
    inflight.delete(key);
    return data;
  });
  inflight.set(key, promise);
  return promise;
}
```

**After:**

```js
await asyncx(fetchFn, { cache: { key: "myKey", ttl: 60_000 } });
// Deduplication and TTL are handled automatically
```

---

## Real-World Recipes

### Resilient API client

```js
const apiClient = {
  get: (path) => asyncx(
    (signal) => fetch(`https://api.example.com${path}`, { signal }).then(r => r.json()),
    {
      retry: (err) => err.status >= 500 || err.code === "ECONNRESET",
      delay: 500,
      backoff: "exponential",
      timeout: 10_000,
      circuit: { threshold: 10, cooldown: 30_000 },
      hooks: {
        onRetry: ({ attempt, error }) => logger.warn({ path, attempt, error }),
        onCacheHit: ({ key }) => metrics.increment("api.cache.hit"),
      },
    }
  ),
};
```

---

### Cached database queries

```js
async function getUser(id) {
  return asyncx(
    (signal) => db.query("SELECT * FROM users WHERE id = $1", [id], { signal }),
    {
      cache: { key: `user:${id}`, ttl: 5 * 60_000 }, // 5 min cache
      retry: 2,
      timeout: 3000,
    }
  );
}

// First call: hits DB
// Subsequent calls within 5 min: instant cache hit
// 100 concurrent calls for the same user: 1 DB query
await Promise.all(Array.from({ length: 100 }, () => getUser(42)));
```

---

### AI / LLM request caching

```js
async function askAI(prompt) {
  return asyncx(
    (signal) => openai.chat.completions.create({ messages: [{ role: "user", content: prompt }] }),
    {
      cache: { key: `ai:${hash(prompt)}`, ttl: 24 * 60 * 60_000 }, // cache 24h
      retry: 3,
      delay: 1000,
      backoff: "exponential",
      timeout: 30_000,
      fallback: () => "Service temporarily unavailable. Please try again.",
      hooks: {
        onCacheHit: () => console.log("Saved an AI API call 💰"),
      },
    }
  );
}
```

---

### Background job processor

```js
async function processJobs(jobs) {
  const results = await asyncx.map(
    jobs.map((job) => async (signal) => processJob(job, signal)),
    {
      concurrency: 10,
      retry: (err) => err.retryable === true,
      delay: 1000,
      backoff: "jitter",
      timeout: 30_000,
      fallback: (err) => ({ status: "failed", error: err.message }),
    }
  );
  return results;
}
```

---

### Feature flags with stale-while-revalidate

```js
async function getFeatureFlags() {
  return asyncx(
    (signal) => fetch("/api/flags", { signal }).then(r => r.json()),
    {
      cache: {
        key: "feature:flags",
        ttl: 60_000,   // expire after 1 minute
        stale: true,   // but never block — always return immediately
      },
    }
  );
}

// At 0s: fetches flags, caches them
// At 30s: returns cached flags instantly
// At 61s: returns stale flags instantly + refreshes in background
// At 62s: returns freshly fetched flags
```

---

## Architecture

```
@munesoft/asyncx/
├── src/
│   ├── core/          # Main execution engine (asyncx function)
│   ├── retry/         # Backoff strategies, shouldRetry, sleep
│   ├── timeout/       # TimeoutError, withTimeout
│   ├── concurrency/   # ConcurrencyLimiter, mapWithConcurrency
│   ├── abort/         # CircuitBreaker, CircuitOpenError
│   ├── cache/         # CacheManager, MemoryStore, CacheStore interface
│   └── hooks/         # fireHook, Hooks types
```

The execution flow for a call with `retry + timeout + cache`:

```
asyncx(task, options)
  ├── Check circuit breaker (throw CircuitOpenError if open)
  ├── Resolve cache key
  ├── Check cache
  │   ├── HIT (valid)    → return immediately (onCacheHit)
  │   ├── HIT (stale)    → return stale + background revalidate
  │   └── MISS           → check inflight, or start new execution
  └── runWithRetry(task)
        ├── Create AbortController (merged with external signal)
        ├── Execute task(signal)
        ├── Apply timeout wrapper if configured
        ├── On success → return result
        └── On failure
              ├── Check retry condition
              ├── Wait (backoff delay, cancellable)
              └── Loop
```

---

## Performance

- **Near-zero overhead** when no options are used — just wraps the promise
- **O(1) cache lookups** backed by `Map`
- **No allocations** on cache hits — returns the stored value directly
- **Minimal promise chain depth** — avoids unnecessary `.then()` chaining
- **No external dependencies** — ships only what it uses

---

## Testing

```bash
npm test          # run all 53 tests
npm run test:watch  # watch mode
```

Test coverage includes:

- Retry + timeout interactions (timeout is per-attempt)
- Cache correctness, TTL expiration, and key isolation
- Promise deduplication under concurrent load
- Stale-while-revalidate timing behavior
- Concurrency edge cases and result ordering
- AbortSignal cancellation during execution and retry delay
- Circuit breaker state machine (closed → open → half-open → closed)
- Hook firing order and error isolation
- Custom cache store plug-in

---

## Build Output

```bash
npm run build   # produces ESM + CJS in dist/
```

- `dist/index.js` — ESM (tree-shakable)
- `dist/index.cjs` — CommonJS
- `dist/index.d.ts` — TypeScript declarations

---

## License

MIT © munesoft

---

## Keywords

javascript async retry, promise retry nodejs, async timeout javascript, promise timeout wrapper, async cache nodejs, javascript caching library, promise deduplication, concurrency limiter javascript, p-limit alternative, p-retry alternative, abort controller nodejs, circuit breaker javascript, async control flow, stale while revalidate javascript, async queue nodejs, rate limit promises, retry with backoff javascript, exponential backoff nodejs, async error handling, promise utilities nodejs