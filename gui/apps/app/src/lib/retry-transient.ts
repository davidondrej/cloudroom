export async function retryTransient<T>(
  run: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransientError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

function isTransientError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status >= 502 : error instanceof TypeError;
}
