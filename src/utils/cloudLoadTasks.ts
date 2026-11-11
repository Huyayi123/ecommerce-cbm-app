// Publish complete modules independently while retaining typed settled results
// for the existing cross-module repair operations.
export function publishCloudTask<T>(read: Promise<T>, publish: (value: T) => void, current: () => boolean): Promise<T> {
  return read.then(value => {
    if (current()) publish(value);
    return value;
  });
}

// Auth initialization is shared even when INITIAL_SESSION, SIGNED_IN and the
// login form all report the same session. Failures remain retryable.
export function createSessionLoad() {
  let entry: { key: string; promise: Promise<void> } | undefined;
  return {
    reset() { entry = undefined; },
    run(key: string, work: () => Promise<void>): Promise<void> {
      if (entry?.key === key) return entry.promise;
      const next = { key, promise: Promise.resolve() };
      next.promise = Promise.resolve().then(work).catch(error => {
        if (entry === next) entry = undefined;
        throw error;
      });
      entry = next;
      return next.promise;
    },
  };
}
