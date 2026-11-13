export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Cancel a wait even when the underlying API does not accept AbortSignal. */
export async function abortable<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return operation();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new DOMException('Aborted', 'AbortError'));
      onAbort?.();
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      throwIfAborted(signal);
      return operation();
    })]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
