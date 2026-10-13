import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import test from "node:test"
import { GoalPlugin } from "../src/goal-plugin.js"
import { acquirePersistenceLease } from "../src/persistence-lease.js"
import {
  projectLocalStateFilePath,
  resolveStateFilePath,
  sessionStateFilePath,
} from "../src/state-paths.js"
import tuiPlugin from "../src/tui.js"

const client = {
  app: { log: async () => {} },
  session: { messages: async () => ({ data: [] }), promptAsync: async () => ({}) },
}

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "goal-user-state-"))
  const directory = join(root, "project")
  await fs.mkdir(directory)
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state") }
  const plugins = []
  t.after(async () => {
    for (const plugin of plugins.reverse()) await plugin.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    root, directory, env,
    async plugin(options = {}, cwd = directory) {
      const plugin = await GoalPlugin({ client, directory: cwd }, { env, minDelayMs: 1, ...options })
      plugins.push(plugin)
      return plugin
    },
    shard(sessionID, cwd = directory) {
      return sessionStateFilePath(resolveStateFilePath({ env, cwd }), sessionID)
    },
  }
}

async function command(plugin, sessionID, arguments_) {
  const output = { parts: [] }
  await plugin["command.execute.before"]({ command: "goal", sessionID, arguments: arguments_ }, output)
  return output.parts.map((part) => part.text || "").join("\n")
}

async function seedLegacy(f, sessionID = "session-old") {
  const stateFilePath = projectLocalStateFilePath(f.directory)
  const seed = await f.plugin({ stateFilePath })
  await command(seed, sessionID, "original objective")
  await command(seed, sessionID, "add background objective")
  await command(seed, sessionID, "focus 1")
  await seed.dispose()
  const path = sessionStateFilePath(stateFilePath, sessionID)
  return { path, raw: await fs.readFile(path, "utf8") }
}

test("default storage isolates projects and sessions without creating .opencode, and recovers after restart", async (t) => {
  const f = await fixture(t)
  const secondDirectory = join(f.root, "other-project")
  await fs.mkdir(secondDirectory)
  const first = await f.plugin()
  const second = await f.plugin({}, secondDirectory)
  await Promise.all([
    command(first, "shared-session", "first project objective"),
    command(second, "shared-session", "second project objective"),
    command(first, "another-session", "another session objective"),
  ])
  const firstShard = f.shard("shared-session")
  assert.notEqual(firstShard, f.shard("shared-session", secondDirectory))
  assert.notEqual(firstShard, f.shard("another-session"))
  assert.match(await command(first, "shared-session", "status"), /first project objective/)
  assert.match(await command(second, "shared-session", "status"), /second project objective/)
  for (const directory of [f.directory, secondDirectory]) {
    await assert.rejects(fs.stat(join(directory, ".opencode")), { code: "ENOENT" })
  }
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(firstShard)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(dirname(firstShard))).mode & 0o777, 0o700)
  }
  await first.dispose()
  const recovered = await f.plugin()
  assert.match(await command(recovered, "shared-session", "status"), /first project objective/)
  const state = JSON.parse(await fs.readFile(firstShard, "utf8"))
  assert.equal(state.goals[0].stopped, true)
  assert.equal(state.goals[0].stopReason, "recovered after restart")
})

test("project identity normalizes path segments and symlink aliases", async (t) => {
  const f = await fixture(t)
  const root = resolveStateFilePath({ env: f.env, cwd: f.directory })
  assert.equal(resolveStateFilePath({ env: f.env, cwd: join(f.directory, "..", "project") }), root)
  assert.equal(resolveStateFilePath({ env: f.env, cwd: relative(process.cwd(), f.directory) }), root)
  if (process.platform !== "win32") {
    const alias = join(f.root, "project-alias")
    await fs.symlink(f.directory, alias, "dir")
    assert.equal(resolveStateFilePath({ env: f.env, cwd: alias }), root)
  }
  assert.match(resolveStateFilePath({ env: { HOME: f.root }, cwd: f.directory }), /\.local[/\\]state[/\\]opencode-goal-plugin[/\\]projects[/\\][a-f0-9]{64}[/\\]state\.json$/)
})

test("migrates accessed project-local shards, background goals and rotated ledgers, preserving originals", async (t) => {
  const f = await fixture(t)
  const old = await seedLegacy(f)
  const ledger = await fs.readFile(`${old.path}.ledger.jsonl`, "utf8")
  await fs.writeFile(`${old.path}.ledger.jsonl.1`, ledger)
  await fs.writeFile(`${old.path}.ledger.jsonl.5`, ledger)
  const other = await seedLegacy(f, "unopened-session")
  const plugin = await f.plugin()
  assert.match(await command(plugin, "session-old", "status"), /original objective/)
  const migrated = JSON.parse(await fs.readFile(f.shard("session-old"), "utf8"))
  assert.deepEqual(migrated.goals.map((goal) => goal.condition), ["original objective", "background objective"])
  assert.equal(migrated.goals.every((goal) => goal.stopped), true)
  assert.equal((await fs.readFile(`${f.shard("session-old")}.ledger.jsonl`, "utf8")).startsWith(ledger), true)
  for (const suffix of [".1", ".5"]) {
    assert.equal(await fs.readFile(`${f.shard("session-old")}.ledger.jsonl${suffix}`, "utf8"), ledger)
  }
  assert.equal(await fs.readFile(old.path, "utf8"), old.raw)
  assert.equal(await fs.readFile(other.path, "utf8"), other.raw)
  await assert.rejects(fs.stat(f.shard("unopened-session")), { code: "ENOENT" })
  assert.match(await command(plugin, "unopened-session", "status"), /original objective/)
  await fs.stat(f.shard("unopened-session"))
})

test("new state takes precedence over old shards and survives another restart", async (t) => {
  const f = await fixture(t)
  const old = await seedLegacy(f)
  const plugin = await f.plugin()
  await command(plugin, "session-old", "status")
  await command(plugin, "session-old", "new objective")
  await plugin.dispose()
  const recovered = await f.plugin()
  const output = await command(recovered, "session-old", "status")
  assert.match(output, /new objective/)
  assert.doesNotMatch(output, /original objective/)
  assert.equal(await fs.readFile(old.path, "utf8"), old.raw)
})

test("preexisting destination state wins even before the migration marker exists", async (t) => {
  const f = await fixture(t)
  const old = await seedLegacy(f)
  const target = f.shard("session-old")
  const snapshot = JSON.parse(old.raw)
  snapshot.goals = [{ ...snapshot.goals[0], condition: "authoritative destination", focused: true }]
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(snapshot))
  const plugin = await f.plugin()
  assert.match(await command(plugin, "session-old", "status"), /authoritative destination/)
  await assert.rejects(fs.stat(`${target}.ledger.jsonl.1`), { code: "ENOENT" })
  assert.equal(await fs.readFile(old.path, "utf8"), old.raw)
})

test("migration preserves completed results and archives", async (t) => {
  const f = await fixture(t)
  const sid = "completed-session"
  const source = sessionStateFilePath(projectLocalStateFilePath(f.directory), sid)
  const result = {
    sessionID: sid, condition: "completed objective", state: "achieved", evidence: "all checks passed",
    startedAt: Date.now() - 1000, finishedAt: Date.now(), turnCount: 3, totalTokens: 42,
  }
  const snapshot = { version: 1, goals: [], results: [result], archives: [{ sessionID: sid, results: [result] }] }
  await fs.mkdir(dirname(source), { recursive: true })
  await fs.writeFile(source, JSON.stringify(snapshot))
  const plugin = await f.plugin()
  assert.match(await command(plugin, sid, "status"), /completed objective/)
  const migrated = JSON.parse(await fs.readFile(f.shard(sid), "utf8"))
  assert.equal(migrated.results[0].evidence, "all checks passed")
  assert.equal(migrated.archives[0].results[0].condition, "completed objective")
  assert.equal(migrated.results[0].turnCount, 3)
  assert.equal(await fs.readFile(source, "utf8"), JSON.stringify(snapshot))
})

test("old project shards do not leak to another project's identical session ID", async (t) => {
  const f = await fixture(t)
  await seedLegacy(f)
  const otherDirectory = join(f.root, "other-project")
  await fs.mkdir(otherDirectory)
  const other = await f.plugin({}, otherDirectory)
  assert.doesNotMatch(await command(other, "session-old", "status"), /original objective/)
  const snapshot = JSON.parse(await fs.readFile(f.shard("session-old", otherDirectory), "utf8"))
  assert.deepEqual(snapshot.goals, [])
})

test("missing or corrupt old snapshots recover from the migrated ledger", async (t) => {
  const f = await fixture(t)
  for (const kind of ["missing", "corrupt"]) {
    const sid = `ledger-${kind}`
    const old = await seedLegacy(f, sid)
    if (kind === "missing") await fs.rm(old.path)
    else await fs.writeFile(old.path, "{broken")
    const plugin = await f.plugin()
    assert.match(await command(plugin, sid, "status"), /original objective/)
    const migrated = JSON.parse(await fs.readFile(f.shard(sid), "utf8"))
    assert.equal(migrated.goals.length, 2)
    assert.equal(migrated.goals.every((goal) => goal.stopped), true)
    if (kind === "corrupt") assert.equal(await fs.readFile(old.path, "utf8"), "{broken")
  }
})

test("invalid legacy state without a ledger is preserved and not replaced by empty state", async (t) => {
  const f = await fixture(t)
  const source = sessionStateFilePath(projectLocalStateFilePath(f.directory), "invalid-session")
  await fs.mkdir(dirname(source), { recursive: true })
  await fs.writeFile(source, "{broken")
  const plugin = await f.plugin()
  await assert.rejects(command(plugin, "invalid-session", "status"), /Cannot migrate invalid goal state/)
  assert.equal(await fs.readFile(source, "utf8"), "{broken")
  await assert.rejects(fs.stat(f.shard("invalid-session")), { code: "ENOENT" })
})

test("a live old shard owner prevents migration until an explicit retry", async (t) => {
  const f = await fixture(t)
  const old = await seedLegacy(f)
  const lease = await acquirePersistenceLease(old.path)
  t.after(() => lease.release())
  const plugin = await f.plugin()
  const denied = JSON.parse(await plugin.tool.goal_status.execute({}, { sessionID: "session-old", agent: "build" }))
  assert.equal(denied.ok, false)
  assert.equal(denied.error, "session_owned_elsewhere")
  await assert.rejects(fs.stat(f.shard("session-old")), { code: "ENOENT" })
  assert.equal(await fs.readFile(old.path, "utf8"), old.raw)
  await lease.release()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.match(await command(plugin, "session-old", "status"), /original objective/)
})

test("interrupted shard migration resumes missing copies before publishing state", async (t) => {
  const f = await fixture(t)
  const old = await seedLegacy(f)
  const target = f.shard("session-old")
  await fs.mkdir(dirname(target), { recursive: true })
  const marker = join(dirname(target), ".project-local-migration-v1-complete")
  await fs.writeFile(`${marker}.pending`, JSON.stringify({ version: 1 }))
  await fs.copyFile(`${old.path}.ledger.jsonl`, `${target}.ledger.jsonl`)
  const plugin = await f.plugin()
  assert.match(await command(plugin, "session-old", "status"), /original objective/)
  assert.equal(JSON.parse(await fs.readFile(target, "utf8")).goals.length, 2)
  await fs.stat(marker)
  await assert.rejects(fs.stat(`${marker}.pending`), { code: "ENOENT" })
})

test("explicit paths disable project-local migration and persistence can be disabled", async (t) => {
  const f = await fixture(t)
  await seedLegacy(f)
  const custom = await f.plugin({ stateFilePath: "custom/state.json" })
  assert.doesNotMatch(await command(custom, "session-old", "status"), /original objective/)
  await command(custom, "custom-session", "custom objective")
  await fs.stat(sessionStateFilePath(join(f.directory, "custom", "state.json"), "custom-session"))
  const memory = await f.plugin({ persistState: false })
  await command(memory, "memory-session", "memory objective")
  await assert.rejects(fs.stat(f.shard("memory-session")), { code: "ENOENT" })
})

function paletteApi(directory, sessionID, toasts) {
  return {
    state: { path: { directory }, session: { messages: () => [] }, part: () => [] },
    route: { current: { name: "session", params: { sessionID } } },
    kv: { get: () => null, set() {} },
    event: { on: () => () => {} },
    lifecycle: { onDispose() {} },
    slots: { register() {} },
    command: { register(callback) { this.items = callback() } },
    ui: { toast(value) { toasts.push(value.message) } },
  }
}

test("TUI reads server state from default, explicit relative and environment paths and refreshes it", async (t) => {
  const f = await fixture(t)
  const cases = [
    { env: f.env },
    { env: f.env, stateFilePath: "custom/state.json" },
    { env: { ...f.env, OPENCODE_GOAL_STATE_PATH: join(f.root, "env", "state.json") } },
    { env: { ...f.env, OPENCODE_GOAL_STATE_PATH: join(f.root, "unused.json") }, stateFilePath: join(f.root, "explicit", "state.json") },
  ]
  for (const [i, options] of cases.entries()) {
    const sid = `tui-session-${i}`
    const plugin = await f.plugin(options)
    await command(plugin, sid, `live objective ${i}`)
    const toasts = []
    const api = paletteApi(f.directory, sid, toasts)
    await tuiPlugin.tui(api, options)
    api.command.items[0].onSelect()
    assert.equal(toasts.at(-1), `active | live objective ${i}`)
    await command(plugin, sid, "pause")
    api.command.items[0].onSelect()
    assert.equal(toasts.at(-1), `paused | live objective ${i}`)
  }
})

test("TUI memory and KV caches remain isolated by project when no state file is available", async (t) => {
  const f = await fixture(t)
  const plugin = await f.plugin()
  const sid = "cache-isolation-session"
  await command(plugin, sid, "private project objective")
  const values = new Map()
  const kv = { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) }
  const firstToasts = []
  const first = paletteApi(f.directory, sid, firstToasts)
  first.kv = kv
  await tuiPlugin.tui(first, { env: f.env })
  first.command.items[0].onSelect()
  assert.equal(firstToasts.at(-1), "active | private project objective")
  await plugin.dispose()
  await fs.rm(f.shard(sid))
  first.command.items[0].onSelect()
  assert.equal(firstToasts.at(-1), "active | private project objective")

  const otherDirectory = join(f.root, "other-project")
  await fs.mkdir(otherDirectory)
  const otherToasts = []
  const other = paletteApi(otherDirectory, sid, otherToasts)
  other.kv = kv
  await tuiPlugin.tui(other, { env: f.env })
  other.command.items[0].onSelect()
  assert.equal(otherToasts.at(-1), "No goal")
})
