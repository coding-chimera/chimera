export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private droppedItems = 0

  constructor(
    private readonly options: {
      capacity?: number
      overflow?: "drop-oldest" | "drop-newest"
    } = {},
  ) {}

  push(item: T, options: { force?: boolean } = {}) {
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve(item)
      return true
    }

    const capacity = this.options.capacity
    if (capacity !== undefined && capacity > 0 && this.queue.length >= capacity) {
      if (!options.force && this.options.overflow === "drop-newest") {
        this.droppedItems++
        return false
      }
      this.queue.shift()
      this.droppedItems++
    }
    this.queue.push(item)
    return true
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  get dropped() {
    return this.droppedItems
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = pending.pop()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}
