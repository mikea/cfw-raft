export async function timeout(durationMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), durationMs);
  });
}
