import type { FrozenSemanticObject } from "@/graph"

export class ProjectionMemo {
  private readonly nodes = new Map<string, FrozenSemanticObject>()

  get(id: string): FrozenSemanticObject | undefined {
    return this.nodes.get(id)
  }

  set(id: string, projection: FrozenSemanticObject): void {
    this.nodes.set(id, projection)
  }

  clear(): void {
    this.nodes.clear()
  }

  get size(): number {
    return this.nodes.size
  }
}
