import path from "path"
import type { Node } from "web-tree-sitter"

import { containsPath, type InstanceContext } from "@/project/instance-context"
import { AstraToolPolicyViolation } from "@/session/policy"
import { ModelPolicy } from "@/provider/model-policy"
/**
 * Astra shell guard.
 *
 * Astra is prompted to use the dedicated read/edit tools, but the shell tool
 * still lets it bypass them with `cat`, `sed -i`, inline interpreters, and
 * friends. This module classifies the parsed shell AST and returns a typed
 * violation before permission prompts or process spawn.
 *
 * The classifier is intentionally conservative: dynamic interpreter scripts
 * and dynamic mutation paths fail closed, because they cannot be resolved to a
 * workspace path ahead of execution. Read-only commands are only blocked when
 * they actually address the workspace, so `cat /tmp/x` and stdin pipelines keep
 * working.
 */

export type Category = "read" | "mutate" | "eval"
export type Input = {
  root: Node
  cwd: string
  instance: InstanceContext
}

const READERS = new Set([
  "cat",
  "tac",
  "head",
  "tail",
  "less",
  "more",
  "most",
  "bat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "awk",
  "gawk",
  "mawk",
  "sed",
  "nl",
  "cut",
  "sort",
  "uniq",
  "diff",
  "xxd",
  "od",
  "strings",
  "column",
  "jq",
])

const MUTATORS = new Set([
  "cp",
  "mv",
  "rm",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "mkdir",
  "rmdir",
  "ln",
  "install",
  "shred",
  "unlink",
  "truncate",
  "tee",
  "dd",
  "patch",
])

const WRAPPERS = new Set(["env", "command", "builtin", "sudo", "doas", "nohup", "exec", "time", "nice", "stdbuf"])

const EVAL = new Set([
  "python",
  "python3",
  "python2",
  "py",
  "node",
  "nodejs",
  "bun",
  "deno",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "perl",
  "ruby",
  "php",
  "lua",
  "eval",
  "source",
  ".",
  "xargs",
])

const GIT_MUTATIONS = new Set(["apply", "am", "checkout", "restore", "reset", "clean", "rm", "mv", "stash"])

const MUTATION_FLAGS = new Set(["-i", "--in-place", "-pi", "--replace"])

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return process.env.HOME ?? text
  if (text.startsWith("~/")) return path.join(process.env.HOME ?? "~", text.slice(2))
  return text
}

function dynamic(text: string) {
  return (
    text.includes("$") ||
    text.includes("`") ||
    /[*?[]/.test(text) ||
    text.startsWith("<(") ||
    text.startsWith(">(")
  )
}

function resolve(text: string, cwd: string) {
  return path.resolve(cwd, home(unquote(text)))
}

function inWorkspace(text: string, cwd: string, instance: InstanceContext) {
  return containsPath(resolve(text, cwd), instance)
}

function tokens(command: Node) {
  const out: string[] = []
  const push = (node: Node) => {
    if (node.type === "command_name") return
    out.push(node.text)
  }
  for (let i = 0; i < command.childCount; i++) {
    const child = command.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        push(item)
      }
      continue
    }
    push(child)
  }
  return out
}

function name(command: Node) {
  return command.childForFieldName("name")?.text?.toLowerCase() ?? tokens(command)[0]?.toLowerCase() ?? ""
}

function flags(list: string[]) {
  return list.filter((item) => item.startsWith("-") && item !== "-")
}

function operands(list: string[]) {
  return list.filter((item) => !item.startsWith("-") || item === "-")
}

function unwrap(list: string[]) {
  let index = 0
  let command = list[index]?.toLowerCase() ?? ""
  while (WRAPPERS.has(command)) {
    index++
    while (index < list.length && (list[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[index]))) index++
    command = list[index]?.toLowerCase() ?? ""
  }
  return { command, args: list.slice(index + 1) }
}

function redirects(command: Node) {
  const parent = command.parent
  if (!parent || parent.type !== "redirected_statement") return []
  const out: Node[] = []
  for (const child of parent.namedChildren) {
    if (!child) continue
    if (child.type === "file_redirect" || child.type === "heredoc_redirect") out.push(child)
  }
  return out
}

function block(category: Category, command: string, detail: string) {
  return new AstraToolPolicyViolation({
    tool: "bash",
    message: `Blocked by the Astra shell guard (${category}): ${detail} (command: ${command}). Use the dedicated Read/Edit/Write/Grep/Glob tools instead of the shell for workspace files.`,
  })
}

function fileOperands(command: string, args: string[]) {
  const out: string[] = []
  const scripted = ["sed", "awk", "gawk", "mawk", "grep", "egrep", "fgrep", "rg", "ag", "perl", "jq"]
  const valueFlags = new Map<string, Set<string>>([
    ["head", new Set(["-n", "-c"])],
    ["tail", new Set(["-n", "-c"])],
    ["cut", new Set(["-f", "-d", "-c", "--fields", "--delimiter"])],
    ["sort", new Set(["-k", "-t"])],
    ["uniq", new Set(["-f", "-s", "-w"])],
  ]).get(command)
  let skip = false
  let script = !scripted.includes(command)
  for (const arg of args) {
    if (skip) {
      skip = false
      continue
    }
    if (valueFlags?.has(arg)) {
      skip = true
      continue
    }
    if (scripted.includes(command) && ["-e", "--expression", "-f", "--file", "--regexp"].includes(arg)) {
      skip = true
      script = true
      continue
    }
    if (arg.startsWith("-") && arg !== "-") continue
    if (arg === "-") {
      out.push(arg)
      continue
    }
    if (!script) {
      script = true
      continue
    }
    out.push(arg)
  }
  return out
}

function readerViolation(command: string, args: string[], cwd: string, instance: InstanceContext) {
  const files = fileOperands(command, args).filter((item) => item !== "-")
  if (command === "rg" || command === "ag") {
    if (files.length === 0) return block("read", command, "recursive workspace content search")
  }
  const recursive = flags(args).some((flag) => /^-[A-Za-z]*[rR]/.test(flag) || flag === "--recursive")
  if (files.length === 0) {
    if (recursive) return block("read", command, "recursive workspace content search")
    return
  }
  for (const file of files) {
    if (dynamic(file)) return block("read", command, "dynamic workspace content read")
    if (inWorkspace(file, cwd, instance)) return block("read", command, "workspace file content read")
  }
}

function mutationViolation(command: string, args: string[], cwd: string, instance: InstanceContext) {
  if (command === "dd") return block("mutate", command, "workspace file mutation")
  if (command === "patch") return block("mutate", command, "workspace file mutation")

  const inPlace = flags(args).some((flag) => MUTATION_FLAGS.has(flag) || /^-[A-Za-z]*i/.test(flag))
  if (command === "sed" || command === "perl") {
    if (!inPlace) {
      if (command === "perl" && args.some((arg) => arg === "-e" || arg === "-E")) {
        return block("eval", command, "inline script evaluation")
      }
      return readerViolation(command, args, cwd, instance)
    }
  }

  const files = fileOperands(command, args).filter((item) => {
    if (command === "chmod" || command === "chown" || command === "chgrp") {
      return !/^[ugoa]*[+-=][rwxXst]*$/.test(item) && !/^[0-7]{3,4}$/.test(item)
    }
    if (command === "sed" || command === "perl") return item !== "-"
    return true
  })
  if (files.length === 0) {
    if (command === "tee" || command === "truncate") return block("mutate", command, "workspace file mutation")
    return
  }
  for (const file of files) {
    if (dynamic(file)) return block("mutate", command, "dynamic workspace file mutation")
    if (inWorkspace(file, cwd, instance)) return block("mutate", command, "workspace file mutation")
  }
}

function evalViolation(command: string, args: string[], heredoc: boolean) {
  if (command === "eval" || command === "source" || command === "." || command === "xargs") {
    return block("eval", command, "inline or dynamic command evaluation")
  }
  if (command === "python" || command === "python2" || command === "python3" || command === "py") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.includes("-c") || args.includes("-")) return block("eval", command, "inline script evaluation")
    return
  }
  if (command === "node" || command === "nodejs" || command === "deno") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print")) {
      return block("eval", command, "inline script evaluation")
    }
    return
  }
  if (command === "bun") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print")) {
      return block("eval", command, "inline script evaluation")
    }
    return
  }
  if (command === "bash" || command === "sh" || command === "zsh" || command === "dash" || command === "ksh" || command === "fish") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => /^-[A-Za-z]*c$/.test(arg) || arg === "--command")) {
      return block("eval", command, "inline command evaluation")
    }
    return
  }
  if (command === "perl") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => arg === "-e" || arg === "-E")) return block("eval", command, "inline script evaluation")
    return
  }
  if (command === "ruby") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => arg === "-e" || arg === "--eval")) return block("eval", command, "inline script evaluation")
    return
  }
  if (command === "php") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => arg === "-r" || arg === "--run")) return block("eval", command, "inline script evaluation")
    return
  }
  if (command === "lua") {
    if (heredoc) return block("eval", command, "heredoc script evaluation")
    if (args.some((arg) => arg === "-e")) return block("eval", command, "inline script evaluation")
  }
}

function gitViolation(args: string[], cwd: string, instance: InstanceContext) {
  const sub = args[0]?.toLowerCase()
  if (!sub || !GIT_MUTATIONS.has(sub)) return
  if (sub === "stash") {
    const action = args[1]?.toLowerCase()
    if (action === "list" || action === "show") return
  }
  if (sub === "checkout" || sub === "restore") {
    // A branch switch has no `--`; only explicit path operands mutate files.
    const separator = args.indexOf("--")
    if (separator === -1) return
    const files = operands(args.slice(separator + 1)).filter((item) => !item.startsWith("-"))
    for (const file of files) {
      if (dynamic(file)) return block("mutate", "git", "dynamic workspace file mutation")
      if (inWorkspace(file, cwd, instance)) return block("mutate", "git", "workspace file mutation")
    }
    return
  }
  return block("mutate", "git", "workspace file mutation")
}

function findViolation(args: string[]) {
  if (args.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(arg))) {
    return block("eval", "find", "find executing or deleting workspace files")
  }
}

function redirectViolation(command: Node, cwd: string, instance: InstanceContext) {
  for (const redirect of redirects(command)) {
    if (redirect.type === "heredoc_redirect") continue
    const operator = redirect.child(0)?.type ?? ""
    if (operator === ">&" || operator === "<&" || operator === "&>" || operator === "&>>") {
      if (operator === "&>" || operator === "&>>") {
        const target = redirect.childForFieldName("destination")?.text
        if (target && (dynamic(target) || inWorkspace(target, cwd, instance))) {
          return block("mutate", "shell redirection", "workspace file mutation")
        }
      }
      continue
    }
    const target = redirect.childForFieldName("destination")?.text
    if (!target) continue
    if (dynamic(target)) {
      return block(operator === "<" ? "read" : "mutate", "shell redirection", "dynamic workspace file access")
    }
    if (!inWorkspace(target, cwd, instance)) continue
    return block(operator === "<" ? "read" : "mutate", "shell redirection", "workspace file access")
  }
}

export function classify(input: Input): AstraToolPolicyViolation | undefined {
  for (const command of input.root.descendantsOfType("command")) {
    if (!command) continue
    const list = [name(command), ...tokens(command)]
    const { command: cmd, args } = unwrap(list)
    if (!cmd) continue
    if (dynamic(cmd)) return block("eval", "dynamic", "dynamic command evaluation")
    const heredoc = redirects(command).some((node) => node.type === "heredoc_redirect")

    if (cmd === "sed" || cmd === "perl") {
      const violation = mutationViolation(cmd, args, input.cwd, input.instance)
      if (violation) return violation
    } else if (EVAL.has(cmd)) {
      const violation = evalViolation(cmd, args, heredoc)
      if (violation) return violation
    } else if (cmd === "git") {
      const violation = gitViolation(args, input.cwd, input.instance)
      if (violation) return violation
      continue
    } else if (cmd === "find") {
      const violation = findViolation(args)
      if (violation) return violation
    } else if (MUTATORS.has(cmd)) {
      const violation = mutationViolation(cmd, args, input.cwd, input.instance)
      if (violation) return violation
    } else if (READERS.has(cmd)) {
      const violation = readerViolation(cmd, args, input.cwd, input.instance)
      if (violation) return violation
    }

    const violation = redirectViolation(command, input.cwd, input.instance)
    if (violation) return violation
  }
}

export function isAstraModel(model: unknown) {
  return ModelPolicy.isGpt6Astra(model as ModelPolicy.ModelPolicyRef | undefined)
}

export * as ShellPolicy from "./policy"