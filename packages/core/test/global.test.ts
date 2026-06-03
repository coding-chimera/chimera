import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("default xdg paths use the Chimera app slug", () => {
    expect(path.basename(Global.Path.config)).toBe("chimera")
    expect(path.basename(Global.Path.data)).toBe("chimera")
    expect(path.basename(Global.Path.cache)).toBe("chimera")
    expect(path.basename(Global.Path.state)).toBe("chimera")
  })

  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "chimera"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
