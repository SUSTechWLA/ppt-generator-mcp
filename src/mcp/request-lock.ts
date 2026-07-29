const requestQueues = new WeakMap<object, Map<string, Promise<void>>>();

export function pendingGenerateDeckRequestLocks(scope: object): number {
  return requestQueues.get(scope)?.size ?? 0;
}

export async function withGenerateDeckRequestLock<T>(
  scope: object,
  requestId: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (requestId === undefined) return operation();

  let queue = requestQueues.get(scope);
  if (!queue) {
    queue = new Map<string, Promise<void>>();
    requestQueues.set(scope, queue);
  }
  const previous = queue.get(requestId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.set(requestId, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queue.get(requestId) === current) {
      queue.delete(requestId);
      if (queue.size === 0) requestQueues.delete(scope);
    }
  }
}
