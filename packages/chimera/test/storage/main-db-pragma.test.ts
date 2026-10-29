import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@/storage/db"
import { init } from "#db"

function withEnv(key: string, value: string | undefined, run: () => void) {
  const saved = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    run()
  } finally {
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

function pragmaValue(db: ReturnType<typeof init>, name: string) {
  return db.$client.prepare(`PRAGMA ${name}`).get() as Record<string, number> | null
}

describe("main-db PRAGMA tuning", () => {
  test("the live connection applies the resolved cache_size", () => {
    const row = pragmaValue(Database.Client(), "cache_size")
    expect(row?.cache_size).toBe(-Database.mainCacheSizeKiB())
  })

  test("the pragma sequence applies cache_size and mmap_size on a file-backed connection", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chimera-main-pragma-"))
    const db = init(path.join(dir, "pragma.db"))
    try {
      Database.applyConnectionPragmas(db)
      expect(pragmaValue(db, "cache_size")?.cache_size).toBe(-Database.mainCacheSizeKiB())
      expect(pragmaValue(db, "mmap_size")?.mmap_size).toBe(Database.mainMmapSizeBytes())
    } finally {
      db.$client.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("cache_size keeps the historical -16000 KiB default and honors CHIMERA_SQLITE_CACHE_MB", () => {
    withEnv("CHIMERA_SQLITE_CACHE_MB", undefined, () => expect(Database.mainCacheSizeKiB()).toBe(16000))
    withEnv("CHIMERA_SQLITE_CACHE_MB", "64", () => expect(Database.mainCacheSizeKiB()).toBe(64 * 1024))
    withEnv("CHIMERA_SQLITE_CACHE_MB", "0", () => expect(Database.mainCacheSizeKiB()).toBe(16000))
    withEnv("CHIMERA_SQLITE_CACHE_MB", "abc", () => expect(Database.mainCacheSizeKiB()).toBe(16000))
  })

  test("mmap_size defaults to 256 MB, honors CHIMERA_SQLITE_MMAP_MB, and 0 disables it", () => {
    withEnv("CHIMERA_SQLITE_MMAP_MB", undefined, () => expect(Database.mainMmapSizeBytes()).toBe(256 * 1024 * 1024))
    withEnv("CHIMERA_SQLITE_MMAP_MB", "512", () => expect(Database.mainMmapSizeBytes()).toBe(512 * 1024 * 1024))
    withEnv("CHIMERA_SQLITE_MMAP_MB", "0", () => expect(Database.mainMmapSizeBytes()).toBe(0))
    withEnv("CHIMERA_SQLITE_MMAP_MB", "-5", () => expect(Database.mainMmapSizeBytes()).toBe(256 * 1024 * 1024))
  })
})