import type { Context, Layer } from "effect"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"

// Ported from upstream app-node-builder. Upstream hard-wires ../location-services
// and ../location-service-map; those pull in the full v2 service registry, so the
// location map behavior is injected here instead.
export interface LocationServiceMapHook {
  readonly node: LayerNode.Node<unknown, unknown, any>
  readonly service: Context.Service.Any
  readonly build: (replacements: LayerNode.Replacements) => Layer.Any
}

export function build<A, E>(
  root: LayerNode.Node<A, E, any>,
  replacements: LayerNode.Replacements = [],
  locationServiceMap?: LocationServiceMapHook,
) {
  let allReplacements = replacements

  // Only build the location service map if it's actually needed
  if (
    locationServiceMap !== undefined &&
    LayerNode.hasUnbound(root, locationServiceMap.node) &&
    !hasReplacement(replacements, locationServiceMap.node)
  ) {
    const locationMapNode = makeGlobalNode({
      service: locationServiceMap.service,
      layer: locationServiceMap.build(replacements),
      deps: [],
    })
    allReplacements = replacements.concat([[locationServiceMap.node, locationMapNode]])
  }

  return LayerNode.compile(root, allReplacements)
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder"
