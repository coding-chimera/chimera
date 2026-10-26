import matter from "gray-matter"
import { z } from "zod"
import type { Info } from "./index"
import ORCHESTRATE_AUTHORING from "./builtin/orchestrate-authoring/SKILL.md" with { type: "text" }

export const BUILTIN_LOCATION_PREFIX = "builtin:"

const Parsed = z.object({ name: z.string(), description: z.string() })

function parse(name: string, content: string): Info {
  const md = matter(content)
  const parsed = Parsed.safeParse(md.data)
  if (!parsed.success) throw new Error(`Invalid frontmatter for built-in skill ${name}`)

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    location: `${BUILTIN_LOCATION_PREFIX}${parsed.data.name}`,
    content: md.content,
  }
}

export const BUILTIN_SKILLS: Info[] = [parse("orchestrate-authoring", ORCHESTRATE_AUTHORING)]

export function isBuiltinLocation(location: string) {
  return location.startsWith(BUILTIN_LOCATION_PREFIX)
}

export * as SkillBuiltin from "./builtin"