/**
 * Execute items in parallel with a bounded worker pool.
 * No external dependencies — pure async/await queue.
 */
export async function parallelExecute<T, R>(
  items: T[],
  maxParallel: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ item: T; result?: R; error?: Error }>> {
  const results: Array<{ item: T; result?: R; error?: Error }> = [];
  // Shared mutable queue — each worker pops from the front
  const queue = [...items];

  const runWorker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift();
      // Guard: another worker may have drained the queue between length-check and shift
      if (item === undefined) break;
      try {
        const result = await worker(item);
        results.push({ item, result });
      } catch (error) {
        results.push({
          item,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  };

  // Spawn exactly min(maxParallel, items.length) concurrent workers
  const concurrency = Math.min(maxParallel, items.length);
  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return results;
}
