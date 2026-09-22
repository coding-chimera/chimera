import { PartID } from "@/session/schema"
import { displaySlice } from "@/cli/cmd/prompt-display"
import type { PromptInfo } from "./history"

type Item = PromptInfo["parts"][number]

export function strip(part: Item & { id: string; messageID: string; sessionID: string }): Item {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function assign(part: Item): Item & { id: PartID } {
  return {
    ...part,
    id: PartID.ascending(),
  }
}

/**
 * Expands tracked pasted-text placeholder ranges back into their full content.
 * Offsets are display columns (wide characters count as two), so slicing must
 * go through displaySlice — plain string.slice corrupts the surrounding text
 * when a placeholder sits next to CJK/emoji content (upstream bba76009a8).
 */
export function expandTrackedPastedText(text: string, ranges: { start: number; end: number; text: string }[]) {
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, part) => displaySlice(result, 0, part.start) + part.text + displaySlice(result, part.end), text)
}
