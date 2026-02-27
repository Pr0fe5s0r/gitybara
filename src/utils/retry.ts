export async function withRetry<T>(
    fn: () => Promise<T>,
    options: { maxRetries?: number; delayMs?: number } = {}
): Promise<T> {
    const { maxRetries = 3, delayMs = 2000 } = options;
    let lastError: any;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;
            // Retry on 5xx or specific transient errors
            const isTransient = err.status >= 500 || err.status === 429;
            if (!isTransient || i === maxRetries - 1) {
                throw err;
            }
            const backoff = delayMs * Math.pow(2, i);
            await new Promise((r) => setTimeout(r, backoff));
        }
    }
    throw lastError;
}
