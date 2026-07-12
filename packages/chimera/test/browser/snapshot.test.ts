import { describe, expect, test } from "bun:test"
import { BrowserSnapshot } from "../../src/browser/snapshot"

function node(
  input: Partial<BrowserSnapshot.Node> & Pick<BrowserSnapshot.Node, "id" | "role">,
): BrowserSnapshot.Node {
  return {
    interactive: false,
    children: [],
    ...input,
  }
}

function nested(depth: number, leaf: BrowserSnapshot.Node): BrowserSnapshot.Node {
  if (depth === 0) return leaf
  return node({
    id: `group-${depth}`,
    role: "group",
    children: [nested(depth - 1, leaf)],
  })
}

describe("browser.snapshot", () => {
  test("resolves default, efficient, and explicit override options", () => {
    expect(BrowserSnapshot.resolveOptions()).toEqual({
      interactive: false,
      compact: false,
      depth: Number.POSITIVE_INFINITY,
      maxChars: 40_000,
    })
    expect(BrowserSnapshot.resolveOptions({ preset: "efficient" })).toEqual({
      interactive: true,
      compact: true,
      depth: 6,
      maxChars: 8_000,
    })
    expect(
      BrowserSnapshot.resolveOptions({
        preset: "efficient",
        interactive: false,
        depth: 9,
        maxChars: 12_000,
      }),
    ).toEqual({
      interactive: false,
      compact: true,
      depth: 9,
      maxChars: 12_000,
    })
  })

  test("renders named content, promotes structural children, and assigns actionable refs", () => {
    const result = BrowserSnapshot.render({
      url: "https://example.com/sign-in",
      roots: [
        node({
          id: "root",
          role: "document",
          children: [
            node({ id: "heading", role: "heading", name: "Sign in" }),
            node({
              id: "wrapper",
              role: "group",
              children: [
                node({
                  id: "email",
                  role: "textbox",
                  name: "Email",
                  interactive: true,
                  description: "Work address",
                  disabled: false,
                }),
              ],
            }),
          ],
        }),
      ],
    })

    expect(result.text).toBe(
      [
        BrowserSnapshot.UNTRUSTED_MARKER,
        'heading "Sign in"',
        'textbox "Email" description="Work address" [disabled=false] [ref=e1]',
      ].join("\n"),
    )
    expect(result.refs.get("e1")).toEqual({ id: "email", role: "textbox", name: "Email" })
    expect(result.trust).toEqual({
      source: "browser",
      untrusted: true,
      url: "https://example.com/sign-in",
      origin: "https://example.com",
    })
  })

  test("efficient mode keeps interactive content compact and limits source depth", () => {
    const result = BrowserSnapshot.render(
      {
        url: "https://example.com",
        roots: [
          node({ id: "heading", role: "heading", name: "Ignored heading" }),
          node({
            id: "visible",
            role: "button",
            name: "Continue",
            interactive: true,
            description: "Verbose help",
            disabled: false,
          }),
          nested(
            7,
            node({ id: "deep", role: "button", name: "Too deep", interactive: true }),
          ),
        ],
      },
      { preset: "efficient" },
    )

    expect(result.text).toContain('button "Continue" [ref=e1]')
    expect(result.text).not.toContain("Ignored heading")
    expect(result.text).not.toContain("Verbose help")
    expect(result.text).not.toContain("disabled=false")
    expect(result.text).not.toContain("Too deep")
    expect(result.refs.has("e1")).toBe(true)
    expect(result.refs.size).toBe(1)
  })

  test("depth filtering removes targets and refs beyond the selected depth", () => {
    const result = BrowserSnapshot.render(
      {
        url: "https://example.com",
        roots: [
          node({
            id: "root",
            role: "region",
            name: "Actions",
            children: [
              node({ id: "child", role: "button", name: "Child", interactive: true }),
            ],
          }),
        ],
      },
      { depth: 0 },
    )

    expect(result.text).toContain('region "Actions"')
    expect(result.text).not.toContain("Child")
    expect(result.refs.size).toBe(0)
  })

  test("disambiguates duplicate role and name pairs using source-order nth", () => {
    const hiddenFirst = nested(
      2,
      node({ id: "hidden", role: "button", name: "Delete", interactive: true }),
    )
    const result = BrowserSnapshot.render(
      {
        url: "https://example.com",
        roots: [
          hiddenFirst,
          node({ id: "visible", role: "button", name: "Delete", interactive: true }),
          node({ id: "link", role: "link", name: "Delete", interactive: true }),
        ],
      },
      { depth: 0 },
    )

    expect(result.text).toContain('button "Delete" [ref=e1] [nth=2]')
    expect(result.text).toContain('link "Delete" [ref=e2]')
    expect(result.refs.get("e1")).toEqual({
      id: "visible",
      role: "button",
      name: "Delete",
      nth: 2,
    })
  })

  test("truncates only on complete lines and rebuilds refs from visible lines", () => {
    const input: BrowserSnapshot.Input = {
      url: "https://example.com",
      roots: [
        node({ id: "one", role: "button", name: "First action", interactive: true }),
        node({ id: "two", role: "button", name: "Second action", interactive: true }),
        node({ id: "three", role: "button", name: "Third action", interactive: true }),
      ],
    }
    const full = BrowserSnapshot.render(input)
    const fullLines = full.text.split("\n")
    const maxChars = [fullLines[0], fullLines[1], BrowserSnapshot.TRUNCATION_MARKER].join("\n").length
    const result = BrowserSnapshot.render(input, { maxChars })

    expect(result.text.split("\n")).toEqual([
      BrowserSnapshot.UNTRUSTED_MARKER,
      'button "First action" [ref=e1]',
      BrowserSnapshot.TRUNCATION_MARKER,
    ])
    expect(result.text.length).toBe(maxChars)
    expect(result.truncated).toBe(true)
    expect(result.omittedLines).toBe(2)
    expect(Array.from(result.refs.keys())).toEqual(["e1"])
  })

  test("does not truncate when output exactly matches the budget", () => {
    const input: BrowserSnapshot.Input = {
      url: "https://example.com",
      roots: [node({ id: "save", role: "button", name: "Save", interactive: true })],
    }
    const full = BrowserSnapshot.render(input)
    const result = BrowserSnapshot.render(input, { maxChars: full.text.length })

    expect(result.text).toBe(full.text)
    expect(result.truncated).toBe(false)
    expect(result.omittedLines).toBe(0)
  })

  test("redacts sensitive node fields and URL credentials", () => {
    const result = BrowserSnapshot.render({
      url: "https://user:pass@example.com/login?token=top-secret&safe=visible#private",
      roots: [
        node({
          id: "password",
          role: "textbox",
          name: "Password",
          value: "hunter2",
          description: "account secret",
          interactive: true,
        }),
        node({
          id: "normal",
          role: "textbox",
          name: "Display name",
          value: "Ada",
          interactive: true,
        }),
      ],
    })

    expect(result.text).toContain(
      `textbox "Password" value="${BrowserSnapshot.REDACTED}" description="${BrowserSnapshot.REDACTED}" [ref=e1]`,
    )
    expect(result.text).toContain('textbox "Display name" value="Ada" [ref=e2]')
    expect(result.text).not.toContain("hunter2")
    expect(result.text).not.toContain("account secret")
    expect(result.trust.url).toBe("https://example.com/login?token=%5BREDACTED%5D&safe=visible")
    expect(result.trust.url).not.toContain("user")
    expect(result.trust.url).not.toContain("top-secret")
    expect(result.trust.url).not.toContain("private")
  })

  test("escapes node text so each node remains on one physical line", () => {
    const result = BrowserSnapshot.render({
      url: "not a url?access_token=secret#fragment",
      roots: [
        node({
          id: "quoted",
          role: "button",
          name: 'Say "hello"\nnext\t\\path',
          interactive: true,
        }),
      ],
    })

    expect(result.text.split("\n")).toHaveLength(2)
    expect(result.text).toContain('button "Say \\"hello\\"\\nnext\\t\\\\path" [ref=e1]')
    expect(result.trust.url).toBe(`not a url?access_token=${BrowserSnapshot.REDACTED}`)
    expect(result.trust.origin).toBe("")
  })

  test("keeps unnamed interactive nodes while filtering unnamed structure", () => {
    const result = BrowserSnapshot.render({
      url: "about:blank",
      roots: [
        node({
          id: "group",
          role: "group",
          children: [node({ id: "icon", role: "button", interactive: true })],
        }),
      ],
    })

    expect(result.text).toBe([BrowserSnapshot.UNTRUSTED_MARKER, "button [ref=e1]"].join("\n"))
    expect(result.refs.get("e1")).toEqual({ id: "icon", role: "button" })
  })

  test("returns a stable empty snapshot", () => {
    const result = BrowserSnapshot.render({ url: "about:blank", roots: [] })

    expect(result.text).toBe(BrowserSnapshot.UNTRUSTED_MARKER)
    expect(result.refs.size).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.omittedLines).toBe(0)
  })

  test("rejects invalid depth and maxChars values", () => {
    expect(() => BrowserSnapshot.resolveOptions({ depth: -1 })).toThrow("non-negative integer")
    expect(() => BrowserSnapshot.resolveOptions({ depth: 1.5 })).toThrow("non-negative integer")
    expect(() =>
      BrowserSnapshot.resolveOptions({ maxChars: BrowserSnapshot.MIN_MAX_CHARS - 1 }),
    ).toThrow("maxChars")
  })

  test("does not mutate the input tree", () => {
    const child = Object.freeze(
      node({ id: "child", role: "button", name: "Run", interactive: true }),
    )
    const root = Object.freeze(
      node({ id: "root", role: "group", children: Object.freeze([child]) }),
    )
    const input = Object.freeze({
      url: "https://example.com",
      roots: Object.freeze([root]),
    })

    expect(() => BrowserSnapshot.render(input)).not.toThrow()
    expect(root.children).toEqual([child])
  })
})
