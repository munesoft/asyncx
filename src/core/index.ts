import { globalCache, CacheStore } from "../cache/index.js";
import { shouldRetry, getDelay, sleep, BackoffStrategy, RetryCondition } from "../retry/index.js";
import { withTimeout, TimeoutError } from "../timeout/index.js";
import { mapWithConcurrency, ConcurrencyLimiter } from "../concurrency/index.js";
import { CircuitBreaker, CircuitOptions, CircuitOpenError } from "../abort/circuit.js";
import { fireHook, Hooks } from "../hooks/index.js";

export { TimeoutError, CircuitOpenError };
export type { CacheStore };

// ─── Types ────────────────────────────────────────────────────────────────────

export type Task<T> = (signal: AbortSignal) => Promise<T>;

export interface CacheOptions {
  key?: string | ((...args: unknown[]) => string);
  ttl?: number;
  stale?: boolean;
}

export interface AsyncxOptions<T> {
  // Timeout
  timeout?: number;
  // Retry
  retry?: RetryCondition;
  delay?: number;
  backoff?: BackoffStrategy;
  maxDelay?: number;
  // Cancellation
  signal?: AbortSignal;
  // Fallback
  fallback?: (error: unknown) => T | Promise<T>;
  // Cache
  cache?: boolean | CacheOptions;
  // Circuit
  circuit?: CircuitOptions;
  // Hooks
  hooks?: Hooks;
}

export interface MapOptions<T> extends Omit<AsyncxOptions<T>, "cache"> {
  concurrency?: number;
}

export interface QueueOptions<T> extends MapOptions<T> {}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveCacheKey(cache: boolean | CacheOptions, task: Task<unknown>): string {
  if (cache === true) return task.toString().slice(0, 64);
  if (typeof cache.key === "string") return cache.key;
  if (typeof cache.key === "function") return cache.key();
  return task.toString().slice(0, 64);
}

// ─── Core Engine ─────────────────────────────────────────────────────────────

async function execute<T>(task: Task<T>, options: AsyncxOptions<T> = {}): Promise<T> {
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
    hooks,
  } = options;

  const startTime = Date.now();

  // Circuit breaker
  const breaker = circuit ? CircuitBreaker.getInstance(circuit) : null;
  if (breaker?.isOpen) throw new CircuitOpenError();

  // Cache resolution
  const useCache = cache !== undefined && cache !== false;
  const cacheKey = useCache ? resolveCacheKey(cache!, task as Task<unknown>) : null;

  if (useCache && cacheKey) {
    const cached = globalCache.get<T>(cacheKey);

    if (cached.hit && !cached.stale) {
      fireHook(hooks, "onCacheHit", { key: cacheKey });
      return cached.value!;
    }

    // Stale-while-revalidate: return stale data, refresh in background
    if (cached.hit && cached.stale) {
      const cacheOpts = typeof cache === "object" ? cache : {};
      if (cacheOpts.stale) {
        fireHook(hooks, "onCacheHit", { key: cacheKey });
        if (!globalCache.isRevalidating(cacheKey)) {
          globalCache.setRevalidating(cacheKey, true);
          void runWithRetry(task, { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks })
            .then((v) => {
              globalCache.set(cacheKey, v, cacheOpts.ttl);
            })
            .catch(() => {/* swallow background errors */})
            .finally(() => globalCache.setRevalidating(cacheKey, false));
        }
        return cached.value!;
      }
    }

    // Deduplication: if already in-flight, piggyback
    const inflight = globalCache.getInflight<T>(cacheKey);
    if (inflight) return inflight;

    fireHook(hooks, "onCacheMiss", { key: cacheKey });

    const cacheOpts = typeof cache === "object" ? cache : {};
    const promise = runWithRetry(task, { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks })
      .then((value) => {
        globalCache.set(cacheKey, value, cacheOpts.ttl);
        globalCache.deleteInflight(cacheKey);
        return value;
      })
      .catch((err) => {
        globalCache.deleteInflight(cacheKey);
        throw err;
      });

    globalCache.setInflight(cacheKey, promise);
    const result = await promise;
    breaker?.onSuccess();
    fireHook(hooks, "onSuccess", { key: cacheKey, duration: Date.now() - startTime, result });
    return result;
  }

  // Non-cached path
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

interface RunOptions<T> {
  timeout?: number;
  retry?: RetryCondition;
  delay?: number;
  backoff?: BackoffStrategy;
  maxDelay?: number;
  externalSignal?: AbortSignal;
  hooks?: Hooks;
}

async function runWithRetry<T>(task: Task<T>, opts: RunOptions<T>): Promise<T> {
  const { timeout, retry, delay, backoff, maxDelay, externalSignal, hooks } = opts;

  let attempt = 0;
  fireHook(hooks, "onStart", { attempt });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Merge external signal with internal abort controller for timeout
    const controller = new AbortController();
    const signal = controller.signal;

    // Forward external abort
    const onAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      let resultPromise = task(signal);

      if (timeout) {
        resultPromise = withTimeout(resultPromise, timeout, signal);
      }

      const result = await resultPromise;
      return result;
    } catch (err) {
      controller.abort();

      // Don't retry on abort
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isAbort) throw err;

      const hasRetry = retry !== undefined;
      if (hasRetry && shouldRetry(retry!, err, attempt)) {
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

// ─── asyncx.safe ─────────────────────────────────────────────────────────────

async function safe<T>(task: Task<T>): Promise<[T, null] | [null, unknown]> {
  try {
    return [await execute(task), null];
  } catch (err) {
    return [null, err];
  }
}

// ─── asyncx.map ──────────────────────────────────────────────────────────────

async function map<T, R>(
  tasks: Array<(signal: AbortSignal) => Promise<R>>,
  options: MapOptions<R> = {}
): Promise<R[]> {
  const { concurrency = Infinity, ...execOptions } = options;
  if (concurrency === Infinity) {
    return Promise.all(tasks.map((t) => execute(t, execOptions)));
  }
  return mapWithConcurrency(tasks, (t) => execute(t, execOptions), concurrency);
}

// ─── asyncx.queue ────────────────────────────────────────────────────────────

function queue<R>(
  tasks: Array<(signal: AbortSignal) => Promise<R>>,
  options: QueueOptions<R> = {}
): { run: () => Promise<R[]>; add: (t: (signal: AbortSignal) => Promise<R>) => void } {
  const pending = [...tasks];
  return {
    add(t) { pending.push(t); },
    run() { return map(pending, options); },
  };
}

// ─── asyncx.race ─────────────────────────────────────────────────────────────

async function race<T>(tasks: Task<T>[]): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race(
      tasks.map((t) => execute(t, { signal: controller.signal }))
    );
  } finally {
    controller.abort();
  }
}

// ─── asyncx.controller ───────────────────────────────────────────────────────

function controller(): AbortController {
  return new AbortController();
}

// ─── asyncx.cache ────────────────────────────────────────────────────────────

const cacheAPI = {
  use(store: CacheStore) { globalCache.use(store); },
  clear(key: string) { globalCache.clear(key); },
  clearAll() { globalCache.clearAll(); },
};

// ─── Main export ─────────────────────────────────────────────────────────────

const asyncx = Object.assign(execute, {
  safe,
  map,
  queue,
  race,
  controller,
  cache: cacheAPI,
});

export default asyncx;
export { execute as asyncx };
