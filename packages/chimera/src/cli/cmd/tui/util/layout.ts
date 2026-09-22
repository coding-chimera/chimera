import type { BaseRenderable, BoxRenderable } from "@opentui/core"

/**
 * Pre-layout sibling margin (upstream packages/tui/src/util/layout.ts, absorbed
 * with the fix(tui) tool-spacing family — 5fb85a6aa3 / cf2d1dd3e9 / d99f86b28d /
 * c814f84c87): margins are applied in the lifecycle pass BEFORE Yoga layout, so
 * scroll geometry matches the rendered frame instead of lagging one frame behind
 * (the old renderBefore + setState approach resized after layout).
 */
const previousByParent = new WeakMap<
  BaseRenderable,
  { frameID: number; previous: WeakMap<BaseRenderable, BaseRenderable | undefined> }
>()

export function setPreLayoutSiblingMargin(el: BoxRenderable, margin: (previous?: BaseRenderable) => number) {
  // Run before Yoga layout so scroll geometry matches the rendered frame.
  el.onLifecyclePass = () => {
    const parent = el.parent
    if (!parent) return
    const cached = previousByParent.get(parent)
    const previous = cached?.frameID === el.ctx.frameId ? cached.previous : previousSiblings(parent, el.ctx.frameId)
    const value = margin(previous.get(el))
    if (el.marginTop !== value) el.marginTop = value
  }
}

function previousSiblings(parent: BaseRenderable, frameID: number) {
  const previous = new WeakMap<BaseRenderable, BaseRenderable | undefined>()
  parent.getChildren().forEach((child, index, children) => previous.set(child, children[index - 1]))
  previousByParent.set(parent, { frameID, previous })
  return previous
}

/** Renderables that always separate the following inline row (block tools, subagent rows, message chrome). */
export const alwaysSeparate = new WeakSet<BoxRenderable>()
