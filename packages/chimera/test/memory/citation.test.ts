import { describe, expect, test } from "bun:test"
import { MemoryCitation } from "@/memory/citation"

describe("memory citation", () => {
  test("strips a v1 block and returns normalized metadata", () => {
    const input = [
      "Memory-backed answer.",
      "",
      '<chimera-memory-citation version="1">',
      "<citation_entries>",
      "global\\MEMORY.md:2-4|note=[global preference]",
      "project/rollout_summaries/example.md:10-10|note=[project result]",
      "</citation_entries>",
      "<rollout_ids>",
      "rollout-1",
      "rollout-1",
      "rollout-2",
      "</rollout_ids>",
      "<session_ids>",
      "session-1",
      "session-1",
      "</session_ids>",
      "<note_ids>",
      "note-1",
      "note-2",
      "note-1",
      "</note_ids>",
      "</chimera-memory-citation>",
    ].join("\r\n")

    expect(MemoryCitation.parse(input)).toEqual({
      text: "Memory-backed answer.",
      version: 1,
      entries: [
        { path: "global/MEMORY.md", lineStart: 2, lineEnd: 4, note: "global preference" },
        { path: "project/rollout_summaries/example.md", lineStart: 10, lineEnd: 10, note: "project result" },
      ],
      rolloutIDs: ["rollout-1", "rollout-2"],
      sessionIDs: ["session-1"],
      noteIDs: ["note-1", "note-2"],
    })
  })

  test("rejects unsafe paths and invalid line ranges without rejecting the block", () => {
    const input = `answer
<chimera-memory-citation version=1>
<entries>
../MEMORY.md:1-2|note=[traversal]
/global/MEMORY.md:1-2|note=[absolute]
C:\\memory\\MEMORY.md:1-2|note=[drive absolute]
global/C:\\memory\\MEMORY.md:1-2|note=[aliased drive absolute]
global/../MEMORY.md:1-2|note=[alias traversal]
project/MEMORY.md:0-2|note=[zero]
project/MEMORY.md:5-4|note=[reversed]
project/MEMORY.md:1-9007199254740992|note=[unsafe integer]
project/MEMORY.md:3-7|note=[valid]
</entries>
</chimera-memory-citation>`

    expect(MemoryCitation.strip(input)).toEqual({
      text: "answer",
      version: 1,
      entries: [{ path: "project/MEMORY.md", lineStart: 3, lineEnd: 7, note: "valid" }],
      rolloutIDs: [],
      sessionIDs: [],
      noteIDs: [],
    })
  })

  test("strips unsupported or malformed citation metadata and preserves ordinary final text", () => {
    expect(MemoryCitation.parse("ordinary final text\r\n")).toEqual({
      text: "ordinary final text\r\n",
      version: undefined,
      entries: [],
      rolloutIDs: [],
      sessionIDs: [],
      noteIDs: [],
    })

    expect(
      MemoryCitation.parse(`visible
<chimera-memory-citation version="2">
<entries>project/MEMORY.md:1-2|note=[ignored]</entries>
<session_ids>session-1</session_ids>
</chimera-memory-citation>`),
    ).toEqual({
      text: "visible",
      version: undefined,
      entries: [],
      rolloutIDs: [],
      sessionIDs: [],
      noteIDs: [],
    })
  })

  test("auto-closes a trailing citation block without exposing machine markup", () => {
    expect(
      MemoryCitation.parse(`visible
<chimera-memory-citation version="1">
<entries>project/MEMORY.md:4-5|note=[trailing]</entries>
<session_ids>session-1</session_ids>`),
    ).toEqual({
      text: "visible",
      version: 1,
      entries: [{ path: "project/MEMORY.md", lineStart: 4, lineEnd: 5, note: "trailing" }],
      rolloutIDs: [],
      sessionIDs: ["session-1"],
      noteIDs: [],
    })
  })

  test("withholds split citation markup from streamed visible text", () => {
    const chunks = [
      "visible answer\n<chimera-mem",
      "ory-citation version=\"1\"><entries>",
      "project/MEMORY.md:1-1|note=[used]</entries>",
      "</chimera-memory-citation>",
    ]
    const visible = chunks.reduce(
      (state, chunk) => {
        const raw = state.raw + chunk
        const text = MemoryCitation.visibleText(raw)
        expect(text.startsWith(state.text)).toBe(true)
        expect(text).not.toContain("<chimera-memory-citation")
        return { raw, text }
      },
      { raw: "", text: "" },
    )
    expect(visible.text).toBe("visible answer\n")
  })

  test("accepts an explicit v1 section and accumulates multiple blocks", () => {
    const input = `answer
<chimera-memory-citation>
<version>1</version>
<entries>global/MEMORY.md:1-1|note=[first]</entries>
<rollout-ids>rollout-1</rollout-ids>
</chimera-memory-citation>
<chimera-memory-citation version='1'>
<entries>project/MEMORY.md:2-3|note=[second]</entries>
<rollout_ids>rollout-1\nrollout-2</rollout_ids>
<session-ids>session-1</session-ids>
<note-ids>note-1</note-ids>
</chimera-memory-citation>`

    expect(MemoryCitation.parse(input)).toEqual({
      text: "answer",
      version: 1,
      entries: [
        { path: "global/MEMORY.md", lineStart: 1, lineEnd: 1, note: "first" },
        { path: "project/MEMORY.md", lineStart: 2, lineEnd: 3, note: "second" },
      ],
      rolloutIDs: ["rollout-1", "rollout-2"],
      sessionIDs: ["session-1"],
      noteIDs: ["note-1"],
    })
  })

  test("validates citation ranges and source IDs against committed artifacts", () => {
    const parsed = MemoryCitation.parse(`answer
<chimera-memory-citation version="1">
<entries>project/MEMORY.md:1-2|note=[used]\nproject/MEMORY.md:3-4|note=[out of range]\nproject/escape.md:1-1|note=[bad]</entries>
<session_ids>ses_1\nses_missing</session_ids>
<rollout_ids>ses_1\nses_missing</rollout_ids>
<note_ids>note_1\nnote_missing</note_ids>
</chimera-memory-citation>`)
    expect(
      MemoryCitation.validate(
        parsed,
        new Map([
          ["project/MEMORY.md", 2],
          ["project/rollout_summaries/ses_1-summary.md", 4],
          ["project/extensions/ad_hoc/notes/note_1.md", 2],
        ]),
      ),
    ).toEqual({
      version: 1,
      entries: [{ path: "project/MEMORY.md", lineStart: 1, lineEnd: 2, note: "used" }],
      rolloutIDs: ["ses_1"],
      sessionIDs: ["ses_1"],
      noteIDs: ["note_1"],
    })
  })
})
