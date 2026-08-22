import type { z } from "zod";

type Circuit = { failures: number; openUntil: number; lastSuccessAt: string | null; lastFailureAt: string | null };
const circuits = new Map<string, Circuit>();

function abortError(message = "Request aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function delayWithSignal(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function circuitFor(provider: string) {
  const existing = circuits.get(provider);
  if (existing) return existing;
  const created = { failures: 0, openUntil: 0, lastSuccessAt: null, lastFailureAt: null };
  circuits.set(provider, created);
  return created;
}

export async function fetchValidated<T extends z.ZodTypeAny>(provider: string, url: string, schema: T, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const circuitKey = `${provider}:${new URL(url).pathname}`;
  const circuit = circuitFor(circuitKey);
  if (circuit.openUntil > Date.now()) throw new Error(`${provider} circuit open`);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal?.aborted) throw abortError(`${provider} request deadline exceeded`);
    const startedAt = Date.now();
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 6_500);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "CheeseEgg-Workbench/1.0" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${provider} HTTP ${response.status}`);
      const data = schema.parse(await response.json()) as z.infer<T>;
      circuit.failures = 0;
      circuit.openUntil = 0;
      circuit.lastSuccessAt = new Date().toISOString();
      return { data, latencyMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        const retryDelay = error instanceof Error && error.message.includes("HTTP 429") ? 1_200 : 250;
        await delayWithSignal(retryDelay, options.signal);
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  circuit.failures += 1;
  circuit.lastFailureAt = new Date().toISOString();
  if (circuit.failures >= 3) circuit.openUntil = Date.now() + 60_000;
  throw lastError instanceof Error ? lastError : new Error(`${provider} request failed`);
}

export function circuitHealth(provider: string) {
  const matching = Array.from(circuits.entries()).filter(([key]) => key.startsWith(`${provider}:`)).map(([, circuit]) => circuit);
  const states = matching.length ? matching : [circuitFor(`${provider}:unknown`)];
  const latest = (values: Array<string | null>) => values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  return {
    consecutiveFailures: Math.max(...states.map((circuit) => circuit.failures)),
    circuitOpen: states.some((circuit) => circuit.openUntil > Date.now()),
    lastSuccessAt: latest(states.map((circuit) => circuit.lastSuccessAt)),
    lastFailureAt: latest(states.map((circuit) => circuit.lastFailureAt)),
  };
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

