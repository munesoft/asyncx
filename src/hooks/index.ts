export interface HookContext {
  attempt?: number;
  error?: unknown;
  key?: string;
  duration?: number;
  result?: unknown;
}

export interface Hooks {
  onStart?: (ctx: HookContext) => void;
  onRetry?: (ctx: HookContext) => void;
  onSuccess?: (ctx: HookContext) => void;
  onError?: (ctx: HookContext) => void;
  onCacheHit?: (ctx: HookContext) => void;
  onCacheMiss?: (ctx: HookContext) => void;
}

export function fireHook(hooks: Hooks | undefined, name: keyof Hooks, ctx: HookContext): void {
  if (!hooks) return;
  try {
    hooks[name]?.(ctx);
  } catch {
    // hooks must never throw
  }
}
