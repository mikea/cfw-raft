export async function timeout(durationMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), durationMs);
  });
}

export interface Barrier<T> {
  promise: Promise<T>;
  resolve(t: T): void;
}

export function barrier<T>(): Barrier<T> {
  let resolveCallback: (t: T) => void;
  const promise = new Promise<T>((resolve) => (resolveCallback = resolve));
  return {
    promise,
    resolve: (t) => resolveCallback(t),
  };
}
