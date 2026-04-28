import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import asyncx, { TimeoutError, CircuitOpenError } from "../src/index.js";
import { CircuitBreaker } from "../src/abort/circuit.js";

beforeEach(() => {
  asyncx.cache.clearAll();
  CircuitBreaker.clearAll();
});

// ─── Timeout ─────────────────────────────────────────────────────────────────

describe("timeout", () => {
  it("resolves before timeout", async () => {
    const result = await asyncx(async () => "ok", { timeout: 500 });
    expect(result).toBe("ok");
  });

  it("throws TimeoutError when exceeded", async () => {
    await expect(
      asyncx(
        () => new Promise((res) => setTimeout(res, 300)),
        { timeout: 50 }
      )
    ).rejects.toThrow(TimeoutError);
  });

  it("propagates abort signal to task", async () => {
    let receivedSignal: AbortSignal | null = null;
    await asyncx(async (signal) => {
      receivedSignal = signal;
      return "done";
    }, { timeout: 1000 });
    expect(receivedSignal).toBeTruthy();
  });
});

// ─── Retry ───────────────────────────────────────────────────────────────────

describe("retry", () => {
  it("retries and succeeds on 3rd attempt", async () => {
    let calls = 0;
    const result = await asyncx(
      async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "success";
      },
      { retry: 3, delay: 0 }
    );
    expect(result).toBe("success");
    expect(calls).toBe(3);
  });

  it("throws after exhausting retries", async () => {
    let calls = 0;
    await expect(
      asyncx(async () => { calls++; throw new Error("always fail"); }, { retry: 2, delay: 0 })
    ).rejects.toThrow("always fail");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("supports custom retry condition", async () => {
    let calls = 0;
    const result = await asyncx(
      async () => {
        calls++;
        if (calls < 2) { const e: any = new Error(); e.status = 503; throw e; }
        return "ok";
      },
      { retry: (err: any) => err.status >= 500, delay: 0 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry on non-matching condition", async () => {
    let calls = 0;
    await expect(
      asyncx(
        async () => { calls++; const e: any = new Error(); e.status = 400; throw e; },
        { retry: (err: any) => err.status >= 500, delay: 0 }
      )
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it("supports exponential backoff calculation", async () => {
    const { getDelay } = await import("../src/retry/index.js");
    expect(getDelay(0, 100, "exponential")).toBe(100);
    expect(getDelay(1, 100, "exponential")).toBe(200);
    expect(getDelay(2, 100, "exponential")).toBe(400);
  });

  it("caps delay at maxDelay", async () => {
    const { getDelay } = await import("../src/retry/index.js");
    expect(getDelay(10, 100, "exponential", 500)).toBe(500);
  });
});

// ─── Cancellation ────────────────────────────────────────────────────────────

describe("cancellation", () => {
  it("aborts execution via external signal", async () => {
    const controller = asyncx.controller();
    const promise = asyncx(
      (signal) => new Promise<void>((res, rej) => {
        const id = setTimeout(res, 500);
        signal.addEventListener("abort", () => { clearTimeout(id); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
      }),
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow();
  });

  it("does not retry on abort", async () => {
    let calls = 0;
    const controller = asyncx.controller();
    setTimeout(() => controller.abort(), 10);
    await expect(
      asyncx(
        async () => { calls++; await new Promise((_, rej) => setTimeout(() => rej(new DOMException("", "AbortError")), 50)); },
        { retry: 3, signal: controller.signal, delay: 0 }
      )
    ).rejects.toBeDefined();
    expect(calls).toBeLessThanOrEqual(2);
  });
});

// ─── Cache ────────────────────────────────────────────────────────────────────

describe("cache", () => {
  it("caches result and avoids second call", async () => {
    let calls = 0;
    const fn = async () => { calls++; return "data"; };
    await asyncx(fn, { cache: { key: "test:1" } });
    await asyncx(fn, { cache: { key: "test:1" } });
    expect(calls).toBe(1);
  });

  it("respects TTL expiration", async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    await asyncx(fn, { cache: { key: "test:ttl", ttl: 50 } });
    await new Promise((r) => setTimeout(r, 80));
    await asyncx(fn, { cache: { key: "test:ttl", ttl: 50 } });
    expect(calls).toBe(2);
  });

  it("deduplicates concurrent calls (only 1 execution)", async () => {
    let calls = 0;
    const fn = async (_s: AbortSignal) => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return "result";
    };
    const [r1, r2, r3] = await Promise.all([
      asyncx(fn, { cache: { key: "test:dedup" } }),
      asyncx(fn, { cache: { key: "test:dedup" } }),
      asyncx(fn, { cache: { key: "test:dedup" } }),
    ]);
    expect(calls).toBe(1);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it("supports cache.clear()", async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    await asyncx(fn, { cache: { key: "test:clear" } });
    asyncx.cache.clear("test:clear");
    await asyncx(fn, { cache: { key: "test:clear" } });
    expect(calls).toBe(2);
  });

  it("supports cache.clearAll()", async () => {
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    await asyncx(fn, { cache: { key: "ca" } });
    await asyncx(fn, { cache: { key: "cb" } });
    asyncx.cache.clearAll();
    await asyncx(fn, { cache: { key: "ca" } });
    await asyncx(fn, { cache: { key: "cb" } });
    expect(calls).toBe(4);
  });

  it("supports custom store via cache.use()", async () => {
    const { MemoryStore } = await import("../src/index.js");
    const custom = new MemoryStore();
    asyncx.cache.use(custom);
    let calls = 0;
    await asyncx(async () => { calls++; return "custom"; }, { cache: { key: "custom:1" } });
    await asyncx(async () => { calls++; return "custom"; }, { cache: { key: "custom:1" } });
    expect(calls).toBe(1);
  });
});

// ─── Stale-While-Revalidate ───────────────────────────────────────────────────

describe("stale-while-revalidate", () => {
  it("returns stale data immediately and refreshes in background", async () => {
    let calls = 0;
    const fn = async () => { calls++; return `v${calls}`; };
    // Prime the cache
    await asyncx(fn, { cache: { key: "swr:test", ttl: 50, stale: true } });
    expect(calls).toBe(1);
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 70));
    // Should return stale "v1" immediately, trigger background refresh
    const result = await asyncx(fn, { cache: { key: "swr:test", ttl: 50, stale: true } });
    expect(result).toBe("v1"); // stale value returned immediately
    // Wait for background revalidation
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2); // background refresh happened
  });
});

// ─── Fallback / safe ─────────────────────────────────────────────────────────

describe("fallback and safe", () => {
  it("calls fallback on error", async () => {
    const result = await asyncx(
      async () => { throw new Error("fail"); },
      { fallback: () => "default" }
    );
    expect(result).toBe("default");
  });

  it("asyncx.safe returns [value, null] on success", async () => {
    const [val, err] = await asyncx.safe(async () => "ok");
    expect(val).toBe("ok");
    expect(err).toBeNull();
  });

  it("asyncx.safe returns [null, error] on failure", async () => {
    const [val, err] = await asyncx.safe(async () => { throw new Error("boom"); });
    expect(val).toBeNull();
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("limits parallel executions", async () => {
    let active = 0;
    let maxActive = 0;
    const task = async (_s: AbortSignal) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return 1;
    };
    await asyncx.map(Array.from({ length: 10 }, () => task), { concurrency: 3 });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("processes all items", async () => {
    const results = await asyncx.map(
      [1, 2, 3, 4, 5].map((n) => async () => n * 2),
      { concurrency: 2 }
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});

// ─── Race ────────────────────────────────────────────────────────────────────

describe("race", () => {
  it("resolves with the fastest task", async () => {
    const result = await asyncx.race([
      async () => { await new Promise((r) => setTimeout(r, 100)); return "slow"; },
      async () => { await new Promise((r) => setTimeout(r, 10)); return "fast"; },
    ]);
    expect(result).toBe("fast");
  });
});

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

describe("circuit breaker", () => {
  it("opens circuit after threshold failures", async () => {
    const circuitOpts = { threshold: 3, cooldown: 10000 };
    const fn = async () => { throw new Error("fail"); };
    // Fill up failures via fallback
    for (let i = 0; i < 3; i++) {
      await asyncx(fn, { circuit: circuitOpts, fallback: () => "fb" });
    }
    // 4th call: circuit is open, should throw CircuitOpenError before even calling fn
    await expect(asyncx(fn, { circuit: circuitOpts })).rejects.toThrow(CircuitOpenError);
  });

  it("resets circuit after cooldown", async () => {
    const circuitOpts = { threshold: 2, cooldown: 50 };
    const fn = async () => { throw new Error("fail"); };
    for (let i = 0; i < 2; i++) {
      await asyncx(fn, { circuit: circuitOpts, fallback: () => null });
    }
    await new Promise((r) => setTimeout(r, 60));
    // After cooldown, circuit allows through again
    await expect(asyncx(fn, { circuit: circuitOpts, fallback: () => "recovered" })).resolves.toBe("recovered");
  });
});

// ─── Hooks ───────────────────────────────────────────────────────────────────

describe("hooks", () => {
  it("fires onStart, onSuccess", async () => {
    const hooks = { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() };
    await asyncx(async () => "ok", { hooks });
    expect(hooks.onStart).toHaveBeenCalledOnce();
    expect(hooks.onSuccess).toHaveBeenCalledOnce();
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it("fires onRetry and onError", async () => {
    const hooks = { onRetry: vi.fn(), onError: vi.fn(), onSuccess: vi.fn() };
    await expect(
      asyncx(async () => { throw new Error("fail"); }, { retry: 2, delay: 0, hooks })
    ).rejects.toBeDefined();
    expect(hooks.onRetry).toHaveBeenCalledTimes(2);
    expect(hooks.onError).toHaveBeenCalledOnce();
  });

  it("fires onCacheHit and onCacheMiss", async () => {
    const hooks = { onCacheHit: vi.fn(), onCacheMiss: vi.fn() };
    const fn = async () => "data";
    // First call: miss
    await asyncx(fn, { cache: { key: "hk:1" }, hooks });
    expect(hooks.onCacheMiss).toHaveBeenCalledOnce();
    expect(hooks.onCacheHit).not.toHaveBeenCalled();
    // Second call: hit
    await asyncx(fn, { cache: { key: "hk:1" }, hooks });
    expect(hooks.onCacheHit).toHaveBeenCalledOnce();
  });
});

// ─── Retry + Timeout interaction ─────────────────────────────────────────────

describe("retry + timeout interaction", () => {
  it("timeout applies per attempt, not total", async () => {
    let calls = 0;
    const result = await asyncx(
      async (_signal) => {
        calls++;
        if (calls < 3) await new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 200));
        return "done";
      },
      { retry: 3, timeout: 100, delay: 0 }
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });
});
