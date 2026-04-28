export interface CircuitOptions {
  threshold: number;
  cooldown: number;
}

type CircuitState = "closed" | "open" | "half-open";

const registry = new Map<string, CircuitBreaker>();

export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = "closed";
  private openedAt = 0;

  constructor(private options: CircuitOptions) {}

  static getInstance(options: CircuitOptions): CircuitBreaker {
    const key = `${options.threshold}:${options.cooldown}`;
    if (!registry.has(key)) registry.set(key, new CircuitBreaker(options));
    return registry.get(key)!;
  }

  static clearAll(): void { registry.clear(); }

  get isOpen(): boolean {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.options.cooldown) {
        this.state = "half-open";
        return false;
      }
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  onFailure(): void {
    this.failures++;
    if (this.failures >= this.options.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState { return this.state; }
}

export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is open");
    this.name = "CircuitOpenError";
  }
}
