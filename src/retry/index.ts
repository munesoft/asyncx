export type BackoffStrategy = "fixed" | "exponential" | "jitter";
export type RetryCondition = number | ((error: unknown) => boolean);

export interface RetryOptions {
  retry: RetryCondition;
  delay?: number;
  backoff?: BackoffStrategy;
  maxDelay?: number;
}

export function shouldRetry(condition: RetryCondition, error: unknown, attempt: number): boolean {
  if (typeof condition === "number") return attempt < condition;
  return condition(error);
}

export function getDelay(
  attempt: number,
  delay = 100,
  backoff: BackoffStrategy = "fixed",
  maxDelay = 30000
): number {
  let ms: number;
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}
