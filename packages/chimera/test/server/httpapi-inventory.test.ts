import { describe, expect, test } from "bun:test"
import { FIXTURE_PATH, generateInventory, renderInventory } from "../../script/httpapi-inventory"

// The inventory derives from `Server.openapi()`; generate once and reuse so the
// drift assertion and the structural assertions cannot disagree.
const inventoryPromise = generateInventory()

describe("httpapi operation inventory", () => {
  test("fixture matches the live Server.openapi() inventory", async () => {
    const inventory = await inventoryPromise
    expect(renderInventory(inventory)).toBe(await Bun.file(FIXTURE_PATH).text())
  })

  test("every operation carries the H0 migration fields", async () => {
    const inventory = await inventoryPromise
    expect(inventory.operationCount).toBe(inventory.operations.length)
    expect(inventory.operationCount).toBeGreaterThan(0)
    expect(inventory.pathCount).toBeGreaterThan(0)
    expect(new Set(inventory.operations.map((operation) => operation.operationId)).size).toBe(inventory.operationCount)

    for (const operation of inventory.operations) {
      expect(operation.operationId.length).toBeGreaterThan(0)
      expect(operation.path.startsWith("/")).toBe(true)
      expect(operation.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/)
      expect(operation.group.length).toBeGreaterThan(0)
      expect(operation.ownerModule.startsWith("src/server/routes/instance/httpapi/")).toBe(true)
      expect(["PublicApi", "PublicApi+raw-route"]).toContain(operation.source)
      expect(["basic", "basic-or-pty-ticket"]).toContain(operation.auth)
      expect(["none", "sse", "websocket"]).toContain(operation.streaming)
      expect(["host-first", "proxy-first", "special"]).toContain(operation.migrationClass)
      expect(["exercise", "none"]).toContain(operation.parityCoverage)
      expect(operation.currentOwner).toBe("bun")
      expect(typeof operation.directoryRewrite).toBe("boolean")
      expect(typeof operation.workspaceRouting).toBe("boolean")
      expect(typeof operation.stateWrites).toBe("boolean")
    }
  })

  test("instance routing flags follow the generated directory/workspace query parameters", async () => {
    const inventory = await inventoryPromise
    const instanceRoutes = inventory.operations.filter(
      (operation) => operation.directoryRewrite || operation.workspaceRouting,
    )
    expect(instanceRoutes.length).toBeGreaterThan(0)
    for (const operation of instanceRoutes) {
      expect(operation.directoryRewrite).toBe(true)
      expect(operation.workspaceRouting).toBe(true)
    }
    expect(
      inventory.operations
        .filter((operation) => !operation.directoryRewrite)
        .every((operation) => operation.path.startsWith("/global/") || operation.path.startsWith("/auth/")),
    ).toBe(true)
  })

  test("streaming and raw routes are classified explicitly", async () => {
    const inventory = await inventoryPromise
    expect(
      inventory.operations
        .filter((operation) => operation.streaming !== "none")
        .map((operation) => operation.operationId)
        .sort(),
    ).toEqual(["event.subscribe", "global.event", "pty.connect"])
    expect(inventory.operations.find((operation) => operation.operationId === "pty.connect")).toMatchObject({
      streaming: "websocket",
      auth: "basic-or-pty-ticket",
      source: "PublicApi+raw-route",
      directoryRewrite: true,
      workspaceRouting: true,
    })
  })

  test("summary counts agree with the per-operation fields", async () => {
    const inventory = await inventoryPromise
    const count = <T extends string>(values: T[]) =>
      Object.fromEntries(
        [...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]),
      ) as Record<T, number>
    expect(inventory.groupCounts).toEqual(count(inventory.operations.map((operation) => operation.group)))
    expect(inventory.migrationClassCounts).toEqual(
      count(inventory.operations.map((operation) => operation.migrationClass)),
    )
    expect(inventory.parityCoverageCounts).toEqual(
      count(inventory.operations.map((operation) => operation.parityCoverage)),
    )
  })
})