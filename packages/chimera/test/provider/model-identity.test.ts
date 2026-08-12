import { describe, expect, test } from "bun:test"
import { ModelIdentity } from "../../src/provider/model-identity"

describe("normalize", () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    ["gpt-4o", "gpt-4o"],
    ["  GPT-4o  ", "gpt-4o"],
    ["Acme-Fast-2025-01-01", "acme-fast-2025-01-01"],
    ["Mixtral-8x7B-Instruct-v0.1", "mixtral-8x7b-instruct-v0.1"],
    ["", undefined],
    ["   ", undefined],
    [undefined, undefined],
  ]
  for (const [value, expected] of cases) {
    test(`normalize(${JSON.stringify(value)}) => ${JSON.stringify(expected)}`, () => {
      expect(ModelIdentity.normalize(value)).toBe(expected)
    })
  }
})

describe("resolve", () => {
  test("explicit capability model wins over apiID", () => {
    const resolved = ModelIdentity.resolve({
      providerID: "acme",
      modelID: "acme-1",
      apiID: "acme/other",
      explicitCapabilityModelID: "Acme-Flagship",
    })
    expect(resolved).toEqual({
      key: JSON.stringify(["identity", "acme-flagship"]),
      identity: "acme-flagship",
      identityConfidence: "explicit",
    })
  })

  test("blank explicit capability model falls through to apiID", () => {
    const resolved = ModelIdentity.resolve({
      providerID: "acme",
      modelID: "acme-1",
      apiID: "Acme-1",
      explicitCapabilityModelID: "   ",
    })
    expect(resolved).toEqual({
      key: JSON.stringify(["identity", "acme-1"]),
      identity: "acme-1",
      identityConfidence: "api-exact",
    })
  })

  test("apiID is used verbatim as the full normalized string", () => {
    const resolved = ModelIdentity.resolve({
      providerID: "acme",
      modelID: "acme-1",
      apiID: "Acme/Flagship-Fast-2025-01-01-Pro",
    })
    expect(resolved).toEqual({
      key: JSON.stringify(["identity", "acme/flagship-fast-2025-01-01-pro"]),
      identity: "acme/flagship-fast-2025-01-01-pro",
      identityConfidence: "api-exact",
    })
  })

  test("provider-scoped identity is a stable encoded provider/model tuple", () => {
    const first = ModelIdentity.resolve({ providerID: "Acme", modelID: "acme-1" })
    const second = ModelIdentity.resolve({ providerID: "acme", modelID: "acme-1" })
    const expectedKey = JSON.stringify(["provider-scoped", "acme", "acme-1"])
    expect(first).toEqual({
      key: expectedKey,
      identity: "route:acme/acme-1",
      identityConfidence: "provider-scoped",
    })
    expect(second).toEqual(first)
  })
})

describe("resolve: no heuristic folding", () => {
  const distinctPairs: Array<[string, string]> = [
    ["acme-flagship-2025-01-01", "acme-flagship"],
    ["acme-flagship-fast", "acme-flagship"],
    ["acme-flagship-pro", "acme-flagship"],
    ["acme-flagship-thinking", "acme-flagship"],
    ["acme-flagship-max", "acme-flagship"],
    ["acme/vendor-prefix", "acme-vendor-prefix"],
    ["acme-1.5", "acme-1"],
    ["2026-08-11-acme", "acme"],
  ]
  for (const [first, second] of distinctPairs) {
    test(`${first} stays distinct from ${second}`, () => {
      const a = ModelIdentity.resolve({ providerID: "acme", modelID: "acme-1", apiID: first })
      const b = ModelIdentity.resolve({ providerID: "acme", modelID: "acme-1", apiID: second })
      expect(a.key).not.toBe(b.key)
      const groups = ModelIdentity.group([
        { providerID: "acme", modelID: "acme-1", apiID: first },
        { providerID: "acme", modelID: "acme-1", apiID: second },
      ])
      expect(groups).toHaveLength(2)
    })
  }

  test("date, version, and suffix variants form separate groups", () => {
    const routes = [
      { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship-2025-01-01" },
      { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship" },
      { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship-max" },
    ]
    const groups = ModelIdentity.group(routes)
    expect(groups.map((g) => g.identity).sort()).toEqual([
      "acme-flagship",
      "acme-flagship-2025-01-01",
      "acme-flagship-max",
    ])
  })
})

describe("group", () => {
  test("api-exact route aliases into an explicit group with the same normalized identity", () => {
    const explicit = {
      providerID: "zeta",
      modelID: "zeta-2",
      explicitCapabilityModelID: "ACME-Flagship",
    }
    const apiExact = { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship" }
    const groups = ModelIdentity.group([apiExact, explicit])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.identity).toBe("acme-flagship")
    expect(groups[0]!.identityConfidence).toBe("explicit")
    expect(groups[0]!.routes.map((route) => route.providerID)).toEqual(["acme", "zeta"])
    expect(groups[0]!.routes[0]).toBe(apiExact)
    expect(groups[0]!.routes[1]).toBe(explicit)
  })

  test("provider-scoped routes never join identity-keyed groups", () => {
    const groups = ModelIdentity.group([
      { providerID: "acme", modelID: "acme-1" },
      { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship" },
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((item) => item.identityConfidence).sort()).toEqual(["api-exact", "provider-scoped"])
  })

  test("group confidence is explicit if any member is explicit", () => {
    const joined = ModelIdentity.group([
      { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship" },
      { providerID: "zeta", modelID: "zeta-1", explicitCapabilityModelID: "acme-flagship" },
    ])
    expect(joined).toHaveLength(1)
    expect(joined[0]!.identityConfidence).toBe("explicit")
  })

  test("group confidence stays api-exact without an explicit member", () => {
    const joined = ModelIdentity.group([
      { providerID: "acme", modelID: "acme-1", apiID: "acme-flagship" },
      { providerID: "zeta", modelID: "zeta-1", apiID: "acme-flagship" },
    ])
    expect(joined).toHaveLength(1)
    expect(joined[0]!.identityConfidence).toBe("api-exact")
  })

  test("group confidence stays provider-scoped without identity members", () => {
    const joined = ModelIdentity.group([
      { providerID: "acme", modelID: "acme-1" },
      { providerID: "acme", modelID: "acme-1" },
    ])
    expect(joined).toHaveLength(1)
    expect(joined[0]!.identityConfidence).toBe("provider-scoped")
  })

  test("routes are ordered by providerID then modelID", () => {
    const routes = [
      { providerID: "zeta", modelID: "zeta-1", apiID: "flagship" },
      { providerID: "acme", modelID: "acme-2", apiID: "flagship" },
      { providerID: "acme", modelID: "acme-1", apiID: "flagship" },
    ]
    const groups = ModelIdentity.group(routes)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.routes.map((route) => `${route.providerID}/${route.modelID}`)).toEqual([
      "acme/acme-1",
      "acme/acme-2",
      "zeta/zeta-1",
    ])
  })

  test("groups are ordered by identity then provider/model", () => {
    const routes = [
      { providerID: "zeta", modelID: "zeta-1", explicitCapabilityModelID: "beta-model" },
      { providerID: "acme", modelID: "acme-2", apiID: "alpha-model" },
      { providerID: "acme", modelID: "acme-1", apiID: "alpha-model" },
      { providerID: "acme", modelID: "acme-1", explicitCapabilityModelID: "charlie-model" },
    ]
    const groups = ModelIdentity.group(routes)
    expect(groups.map((g) => g.identity)).toEqual(["alpha-model", "beta-model", "charlie-model"])
    expect(groups[0]!.routes.map((route) => route.modelID)).toEqual(["acme-1", "acme-2"])
  })

  test("different providers with the same model stay in separate provider-scoped groups", () => {
    const groups = ModelIdentity.group([
      { providerID: "acme", modelID: "acme-1" },
      { providerID: "zeta", modelID: "acme-1" },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.identity).toBe("route:acme/acme-1")
    expect(groups[1]!.identity).toBe("route:zeta/acme-1")
  })

  test("provider-scoped grouping is case-insensitive", () => {
    const groups = ModelIdentity.group([
      { providerID: "OpenAI", modelID: "GPT-4o" },
      { providerID: "openai", modelID: "gpt-4o" },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.identityConfidence).toBe("provider-scoped")
  })
})

describe("keys", () => {
  test("keys are JSON tuples, never delimiter concatenation", () => {
    const a = ModelIdentity.resolve({ providerID: "a/b", modelID: "c" })
    const b = ModelIdentity.resolve({ providerID: "a", modelID: "b/c" })
    expect(a.key).toBe(JSON.stringify(["provider-scoped", "a/b", "c"]))
    expect(b.key).toBe(JSON.stringify(["provider-scoped", "a", "b/c"]))
    expect(a.key).not.toBe(b.key)
    expect(JSON.parse(a.key)).toEqual(["provider-scoped", "a/b", "c"])
    expect(JSON.parse(b.key)).toEqual(["provider-scoped", "a", "b/c"])
  })

  test("an identity that looks like a tuple cannot collide with a provider-scoped key", () => {
    const explicit = ModelIdentity.resolve({ providerID: "acme", modelID: "acme-1", explicitCapabilityModelID: "a,b" })
    const scoped = ModelIdentity.resolve({ providerID: "a", modelID: "b" })
    expect(explicit.key).toBe(JSON.stringify(["identity", "a,b"]))
    expect(scoped.key).toBe(JSON.stringify(["provider-scoped", "a", "b"]))
    expect(explicit.key).not.toBe(scoped.key)
    const groups = ModelIdentity.group([
      { providerID: "acme", modelID: "acme-1", explicitCapabilityModelID: "a,b" },
      { providerID: "a", modelID: "b" },
    ])
    expect(groups).toHaveLength(2)
  })

  test("identical normalized identities share one key across confidence classes", () => {
    const explicitKey = ModelIdentity.resolve({
      providerID: "x",
      modelID: "y",
      explicitCapabilityModelID: "  ACME-Flagship ",
    }).key
    const apiExactKey = ModelIdentity.resolve({ providerID: "x", modelID: "y", apiID: "acme-flagship" }).key
    expect(explicitKey).toBe(apiExactKey)
    expect(explicitKey).toBe(JSON.stringify(["identity", "acme-flagship"]))
  })
})
