export interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
  createdAt: number;
}

export interface CacheStore {
  get<T>(key: string): CacheEntry<T> | undefined;
  set<T>(key: string, entry: CacheEntry<T>): void;
  delete(key: string): void;
  clear(): void;
  keys(): string[];
}

export class MemoryStore implements CacheStore {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): CacheEntry<T> | undefined {
    return this.store.get(key) as CacheEntry<T> | undefined;
  }

  set<T>(key: string, entry: CacheEntry<T>): void {
    this.store.set(key, entry as CacheEntry<unknown>);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}

export class CacheManager {
  private store: CacheStore = new MemoryStore();
  // in-flight promises for deduplication
  private inflight = new Map<string, Promise<unknown>>();
  // stale background refresh tracking
  private revalidating = new Set<string>();

  use(store: CacheStore): void {
    this.store = store;
  }

  isValid<T>(entry: CacheEntry<T>): boolean {
    if (entry.expiresAt === null) return true;
    return Date.now() < entry.expiresAt;
  }

  get<T>(key: string): { hit: boolean; value?: T; stale?: boolean } {
    const entry = this.store.get<T>(key);
    if (!entry) return { hit: false };
    const valid = this.isValid(entry);
    return { hit: true, value: entry.value, stale: !valid };
  }

  set<T>(key: string, value: T, ttl?: number): void {
    const entry: CacheEntry<T> = {
      value,
      expiresAt: ttl ? Date.now() + ttl : null,
      createdAt: Date.now(),
    };
    this.store.set(key, entry);
  }

  clear(key: string): void {
    this.store.delete(key);
    this.inflight.delete(key);
  }

  clearAll(): void {
    this.store.clear();
    this.inflight.clear();
    this.revalidating.clear();
  }

  getInflight<T>(key: string): Promise<T> | undefined {
    return this.inflight.get(key) as Promise<T> | undefined;
  }

  setInflight<T>(key: string, promise: Promise<T>): void {
    this.inflight.set(key, promise as Promise<unknown>);
  }

  deleteInflight(key: string): void {
    this.inflight.delete(key);
  }

  isRevalidating(key: string): boolean {
    return this.revalidating.has(key);
  }

  setRevalidating(key: string, value: boolean): void {
    if (value) this.revalidating.add(key);
    else this.revalidating.delete(key);
  }
}

export const globalCache = new CacheManager();
