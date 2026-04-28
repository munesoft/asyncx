'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

// src/cache/index.ts
var MemoryStore = class {
  constructor() {
    this.store = /* @__PURE__ */ new Map();
  }
  get(key) {
    return this.store.get(key);
  }
  set(key, entry) {
    this.store.set(key, entry);
  }
  delete(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
  keys() {
    return Array.from(this.store.keys());
  }
};
var CacheManager = class {
  constructor() {
    this.store = new MemoryStore();
    // in-flight promises for deduplication
    this.inflight = /* @__PURE__ */ new Map();
    // stale background refresh tracking
    this.revalidating = /* @__PURE__ */ new Set();
  }
  use(store) {
    this.store = store;
  }
  isValid(entry) {
    if (entry.expiresAt === null) return true;
    return Date.now() < entry.expiresAt;
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return { hit: false };
    const valid = this.isValid(entry);
    return { hit: true, value: entry.value, stale: !valid };
  }
  set(key, value, ttl) {
    const entry = {
      value,
      expiresAt: ttl ? Date.now() + ttl : null,
      createdAt: Date.now()
    };
    this.store.set(key, entry);
  }
  clear(key) {
    this.store.delete(key);
    this.inflight.delete(key);
  }
  clearAll() {
    this.store.clear();
    this.inflight.clear();
    this.revalidating.clear();
  }
  getInflight(key) {
    return this.inflight.get(key);
  }
  setInflight(key, promise) {
    this.inflight.set(key, promise);
  }
  deleteInflight(key) {
    this.inflight.delete(key);
  }
  isRevalidating(key) {
    return this.revalidating.has(key);
  }
  setRevalidating(key, value) {
    if (value) this.revalidating.add(key);
    else this.revalidating.delete(key);
  }
};
var globalCache = new CacheManager();

// src/retry/index.ts
function shouldRetry(condition, error, attempt) {
  if (typeof condition === "number") return attempt < condition;
  return condition(error);
}
function getDelay(attempt, delay = 100, backoff = "fixed", maxDelay = 3e4) {
  let ms;
  switch (backoff) {
    case "exponential":
      ms = delay * Math.pow(2, attempt);
      break;
    case "jitter":
      ms = delay * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      break;
    default:
      ms = delay;
  }
  return Math.min(ms, maxDelay);
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

// src/timeout/index.ts
var TimeoutError = class extends Error {
  constructor(ms) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
};
function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new TimeoutError(ms));
    }, ms);
    signal.addEventListener("abort", () => clearTimeout(id), { once: true });
    promise.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      }
    );
  });
}

// src/concurrency/index.ts
var ConcurrencyLimiter = class {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  acquire() {
    if (this.running < this.limit) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }
  release() {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
};
async function mapWithConcurrency(items, fn, concurrency) {
  const limiter = new ConcurrencyLimiter(concurrency);
  return Promise.all(items.map((item, i) => limiter.run(() => fn(item, i))));
}

// src/abort/circuit.ts
var registry = /* @__PURE__ */ new Map();
var CircuitBreaker = class _CircuitBreaker {
  constructor(options) {
    this.options = options;
    this.failures = 0;
    this.state = "closed";
    this.openedAt = 0;
  }
  static getInstance(options) {
    const key = `${options.threshold}:${options.cooldown}`;
    if (!registry.has(key)) registry.set(key, new _CircuitBreaker(options));
    return registry.get(key);
  }
  static clearAll() {
    registry.clear();
  }
  get isOpen() {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.options.cooldown) {
        this.state = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }
  onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }
  onFailure() {
    this.failures++;
    if (this.failures >= this.options.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
  getState() {
    return this.state;
  }
};
var CircuitOpenError = class extends Error {
  constructor() {
    super("Circuit breaker is open");
    this.name = "CircuitOpenError";
  }
};

// src/hooks/index.ts
function fireHook(hooks, name, ctx) {
  if (!hooks) return;
  try {
    hooks[name]?.(ctx);
  } catch {
  }
}

// src/core/index.ts
function resolveCacheKey(cache, task) {
  if (cache === true) return task.toString().slice(0, 64);
  if (typeof cache.key === "string") return cache.key;
  if (typeof cache.key === "function") return cache.key();
  return task.toString().slice(0, 64);
}
async function execute(task, options = {}) {
  const {
    timeout,
    retry,
    delay,
    backoff,
    maxDelay,
    signal: externalSignal,
    fallback,
    cache,
    circuit,
    hooks
  } = options;
  const startTime = Date.now();
  const breaker = circuit ? CircuitBreaker.getInstance(circuit) : null;
  if (breaker?.isOpen) throw new CircuitOpenError();
  const useCache = cache !== void 0 && cache !== false;
  const cacheKey = useCache ? resolveCacheKey(cache, task) : null;
  if (useCache && cacheKey) {
    const cached = globalCache.get(cacheKey);
    if (cached.hit && !cached.stale) {
      fireHook(hooks, "onCacheHit", { key: cacheKey });
      return cached.value;
    }
    if (cached.hit && cached.stale) {
      const cacheOpts2 = typeof cache === "object" ? cache : {};
      if (cacheOpts2.stale) {
        fireHook(hooks, "onCacheHit", { key: cacheKey });
        if (!globalCache.isRevalidating(cacheKey)) {
          globalCache.setRevalidating(cacheKey, true);
          void runWithRetry(task, { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks }).then((v) => {
            globalCache.set(cacheKey, v, cacheOpts2.ttl);
          }).catch(() => {
          }).finally(() => globalCache.setRevalidating(cacheKey, false));
        }
        return cached.value;
      }
    }
    const inflight = globalCache.getInflight(cacheKey);
    if (inflight) return inflight;
    fireHook(hooks, "onCacheMiss", { key: cacheKey });
    const cacheOpts = typeof cache === "object" ? cache : {};
    const promise = runWithRetry(task, { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks }).then((value) => {
      globalCache.set(cacheKey, value, cacheOpts.ttl);
      globalCache.deleteInflight(cacheKey);
      return value;
    }).catch((err) => {
      globalCache.deleteInflight(cacheKey);
      throw err;
    });
    globalCache.setInflight(cacheKey, promise);
    const result = await promise;
    breaker?.onSuccess();
    fireHook(hooks, "onSuccess", { key: cacheKey, duration: Date.now() - startTime, result });
    return result;
  }
  try {
    const result = await runWithRetry(task, { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks });
    breaker?.onSuccess();
    fireHook(hooks, "onSuccess", { duration: Date.now() - startTime, result });
    return result;
  } catch (err) {
    breaker?.onFailure();
    fireHook(hooks, "onError", { error: err, duration: Date.now() - startTime });
    if (fallback) return fallback(err);
    throw err;
  }
}
async function runWithRetry(task, opts) {
  const { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks } = opts;
  let attempt = 0;
  fireHook(hooks, "onStart", { attempt });
  while (true) {
    const controller2 = new AbortController();
    const signal = controller2.signal;
    const onAbort = () => controller2.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      let resultPromise = task(signal);
      if (timeout) {
        resultPromise = withTimeout(resultPromise, timeout, signal);
      }
      const result = await resultPromise;
      return result;
    } catch (err) {
      controller2.abort();
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isAbort) throw err;
      const hasRetry = retry !== void 0;
      if (hasRetry && shouldRetry(retry, err, attempt)) {
        attempt++;
        fireHook(hooks, "onRetry", { attempt, error: err });
        const waitMs = getDelay(attempt - 1, delay, backoff, maxDelay);
        await sleep(waitMs, externalSignal);
        continue;
      }
      throw err;
    } finally {
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}
async function safe(task) {
  try {
    return [await execute(task), null];
  } catch (err) {
    return [null, err];
  }
}
async function map(tasks, options = {}) {
  const { concurrency = Infinity, ...execOptions } = options;
  if (concurrency === Infinity) {
    return Promise.all(tasks.map((t) => execute(t, execOptions)));
  }
  return mapWithConcurrency(tasks, (t) => execute(t, execOptions), concurrency);
}
function queue(tasks, options = {}) {
  const pending = [...tasks];
  return {
    add(t) {
      pending.push(t);
    },
    run() {
      return map(pending, options);
    }
  };
}
async function race(tasks) {
  const controller2 = new AbortController();
  try {
    return await Promise.race(
      tasks.map((t) => execute(t, { signal: controller2.signal }))
    );
  } finally {
    controller2.abort();
  }
}
function controller() {
  return new AbortController();
}
var cacheAPI = {
  use(store) {
    globalCache.use(store);
  },
  clear(key) {
    globalCache.clear(key);
  },
  clearAll() {
    globalCache.clearAll();
  }
};
var asyncx = Object.assign(execute, {
  safe,
  map,
  queue,
  race,
  controller,
  cache: cacheAPI
});
var core_default = asyncx;

exports.CircuitOpenError = CircuitOpenError;
exports.MemoryStore = MemoryStore;
exports.TimeoutError = TimeoutError;
exports.asyncx = execute;
exports.default = core_default;
