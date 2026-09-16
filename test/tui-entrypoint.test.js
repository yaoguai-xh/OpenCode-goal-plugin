import assert from "node:assert/strict"
import test from "node:test"
import tuiPlugin from "../src/tui.js"

function mockApi(overrides = {}) {
  return {
    theme: { current: { text: "#fff", textMuted: "#888", primary: "#0f0" } },
    state: {
      session: { messages() { return [] } },
      part() { return [] },
    },
    kv: { get() { return null }, set() {} },
    event: {
      on() { return () => {} },
    },
    lifecycle: {
      onDispose() { return () => {} },
    },
    slots: {
      register(plugin) { this.lastSlot = plugin; return "slot" },
    },
    command: {
      register(cb) { this.lastCommands = cb(); return () => {} },
    },
    ...overrides,
  }
}

test("registers sidebar_content slot with events", async () => {
  const api = mockApi()

  await tuiPlugin.tui(api)

  assert.equal(api.slots.lastSlot.order, 125)
  assert.equal(typeof api.slots.lastSlot.slots.sidebar_content, "function")
})

test("registers Goal command in palette", async () => {
  const api = mockApi()

  await tuiPlugin.tui(api)

  assert.equal(api.command.lastCommands.length, 1)
  assert.equal(api.command.lastCommands[0].value, "goal.show")
})

test("subscribes to session message and status events", async () => {
  const events = []
  const api = mockApi({
    event: {
      on(type) {
        events.push(type)
        return () => {}
      },
    },
  })

  await tuiPlugin.tui(api)

  assert.deepEqual(events, ["message.part.updated", "message.updated", "session.status", "session.idle"])
})