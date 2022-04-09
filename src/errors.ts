export function liftError<T>(arr: Array<T | Error>): T[] | Error {
  for (const t of arr) {
    if (t instanceof Error) return t;
  }
  return arr as T[];
}
