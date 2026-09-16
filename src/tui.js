let readFileSyncFn, computeHashFn

try {
  readFileSyncFn = (await import("node:fs")).readFileSync
  computeHashFn = (await import("node:crypto")).createHash
} catch {
  // node builtins unavailable in this runtime (OpenCode binary)
}

import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"

const GOAL_TOOL_NAMES = new Set([
  "goal_status", "goal_set", "goal_pause", "goal_resume",
  "goal_block", "goal_complete", "get_goal", "get_goal_history",
  "set_goal", "update_goal", "clear_goal",
])

const goalCache = new Map()

function el(tag, props, children = []) {
  const node = createElement(tag)
  for (const [k, v] of Object.entries(props)) if (v !== undefined) setProp(node, k, v)
  for (const c of children) if (c !== null && c !== undefined && c !== false) insert(node, c)
  return node
}

function box(props, children = []) { return el("box", props, children) }
function text(props, children) { return el("text", props, children) }

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
  return `${minutes}:${String(secs).padStart(2, "0")}`
}

function numberFrom(value) {
  if (typeof value !== "string") return null
  const parsed = Number(value.replaceAll(",", "").trim())
  return Number.isFinite(parsed) ? parsed : null
}

function lineValue(text, label) {
  const match = text.match(new RegExp(`^${label}:\\s*(.*)$`, "mi"))
  return match?.[1]?.trim() || ""
}

// ---- state file reader (reads server's persisted goal directly) ----

function projectDir(api) {
  return api.state.path.directory || process.cwd()
}

function sessionShardPath(dir, sessionID) {
  if (!computeHashFn) return undefined
  const key = computeHashFn("sha256").update(sessionID).digest("hex")
  return `${dir}/.opencode/goals/state.json.sessions/${key}/state.json`
}

function convertServerGoal(raw, now) {
  if (!raw || typeof raw.condition !== "string" || !raw.condition.trim()) return undefined
  const options = raw.options || {}
  const status = raw.blockedReason ? "blocked" : raw.stopped === true ? "paused" : "active"
  const startedAt = Number.isFinite(raw.startedAt) ? raw.startedAt : now
  const pausedAt = Number(raw.pausedAt) || 0
  const end = status === "active" ? now : pausedAt || now
  const elapsedSeconds = Math.max(0, Math.floor((end - startedAt) / 1000))
  const maxTokens = Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : null
  const totalTokens = Number.isSafeInteger(raw.totalTokens) ? raw.totalTokens : 0
  return {
    sessionID: raw.sessionID,
    objective: raw.condition.trim(),
    status,
    turnCount: Number.isSafeInteger(raw.turnCount) ? raw.turnCount : 0,
    maxTurns: Number.isSafeInteger(options.maxTurns) && options.maxTurns > 0 ? options.maxTurns : null,
    totalTokens,
    maxTokens,
    remainingTokens: maxTokens ? Math.max(0, maxTokens - totalTokens) : null,
    startedAt,
    elapsedSeconds,
    sampledAt: now,
    lastStatus: typeof raw.lastStatus === "string" ? raw.lastStatus : "",
    stopReason: typeof raw.stopReason === "string" ? raw.stopReason : "",
    blockedReason: typeof raw.blockedReason === "string" ? raw.blockedReason : "",
    lastCheckpoint: raw.lastCheckpoint && typeof raw.lastCheckpoint.summary === "string"
      ? { summary: raw.lastCheckpoint.summary, timestamp: Number(raw.lastCheckpoint.timestamp) || now } : null,
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.map(c => (
      c && typeof c.summary === "string" ? { summary: c.summary, timestamp: c.timestamp } : null
    )).filter(Boolean) : [],
  }
}

function readStateGoal(api, sessionID) {
  if (!readFileSyncFn) return undefined
  const dir = projectDir(api)
  const shard = sessionShardPath(dir, sessionID)
  if (!shard) return undefined
  try {
    const parsed = JSON.parse(readFileSyncFn(shard, "utf8"))
    if (parsed?.version !== 1 || !Array.isArray(parsed.goals)) return undefined
    const now = Date.now()

    // Active goal
    const goals = parsed.goals.filter(g => g?.sessionID === sessionID)
    const focused = goals.find(g => g.focused === true) || goals.at(-1)
    if (focused) return convertServerGoal(focused, now)

    // Completed/cleared goal
    const results = (parsed.results || [])
      .filter(r => r?.sessionID === sessionID)
      .sort((a, b) => (Number(b.finishedAt) || 0) - (Number(a.finishedAt) || 0))
    const latest = results[0]
    if (latest) {
      const status = latest.state === "achieved" ? "complete" : latest.blockedReason ? "blocked" : "complete"
      return {
        sessionID,
        objective: (latest.condition || "").trim(),
        status,
        turnCount: Number.isSafeInteger(latest.turnCount) ? latest.turnCount : 0,
        maxTurns: null,
        totalTokens: Number.isSafeInteger(latest.totalTokens) ? latest.totalTokens : 0,
        maxTokens: null,
        remainingTokens: null,
        startedAt: Number(latest.startedAt) || 0,
        elapsedSeconds: Math.max(0, Math.floor(((Number(latest.finishedAt) || now) - (Number(latest.startedAt) || 0)) / 1000)),
        sampledAt: now,
        lastStatus: typeof latest.lastStatus === "string" ? latest.lastStatus : "",
        stopReason: typeof latest.reason === "string" ? latest.reason : "",
        blockedReason: typeof latest.blockedReason === "string" ? latest.blockedReason : "",
        lastCheckpoint: latest.lastCheckpoint && typeof latest.lastCheckpoint.summary === "string"
          ? { summary: latest.lastCheckpoint.summary, timestamp: Number(latest.lastCheckpoint.timestamp) || now } : null,
        checkpoints: Array.isArray(latest.checkpoints) ? latest.checkpoints : [],
      }
    }
  } catch { /* file not yet written or corrupt */ }
  return undefined
}

// ---- goal output parsing from session messages ----

function parseGoalStatusText(output, sessionID, now) {
  if (typeof output !== "string") return undefined
  const objective = lineValue(output, "(?:Active goal|Last goal)")
  const rawStatus = lineValue(output, "State").toLowerCase()
  if (!objective || !rawStatus) return undefined
  const status = rawStatus === "achieved" ? "complete" : rawStatus === "unmet" ? "unmet" : rawStatus
  if (!["active", "paused", "blocked", "complete", "unmet"].includes(status)) return undefined
  const turns = lineValue(output, "Auto-continues sent").split("/")
  const tokens = lineValue(output, "Context tokens").split("/")
  const elapsed = lineValue(output, "Elapsed").split("/")
  const checkpoint = lineValue(output, "Recent checkpoint").replace(/\s+\([^)]*\)$/, "")
  const totalTokens = numberFrom(tokens[0]) || 0
  const maxTokens = numberFrom(tokens[1])
  const elapsedSeconds = numberFrom(elapsed[0]?.replace(/s$/, "")) || 0
  const maxTurns = numberFrom(turns[1])
  return {
    sessionID, objective, status,
    turnCount: numberFrom(turns[0]) || 0,
    maxTurns: maxTurns && maxTurns > 0 ? maxTurns : null,
    totalTokens, maxTokens: maxTokens && maxTokens > 0 ? maxTokens : null,
    remainingTokens: maxTokens && maxTokens > 0 ? Math.max(0, maxTokens - totalTokens) : null,
    startedAt: now - elapsedSeconds * 1000,
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
    sampledAt: now,
    lastStatus: lineValue(output, "Last status"),
    stopReason: lineValue(output, "Stopped"),
    blockedReason: lineValue(output, "Blocked reason"),
    lastCheckpoint: checkpoint && checkpoint !== "none yet" ? { summary: checkpoint, timestamp: now } : null,
    checkpoints: [],
  }
}

function parseGoalSnapshot(snapshot, sessionID, now) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined
  const objective = typeof snapshot.objective === "string" ? snapshot.objective.trim() : ""
  if (!objective || typeof snapshot.status !== "string") return undefined
  const status = ["active", "paused", "blocked", "complete", "unmet"].includes(snapshot.status) ? snapshot.status : undefined
  if (!status) return undefined
  const totalTokens = numberFrom(String(snapshot.tokensUsed ?? snapshot.totalTokens ?? 0)) || 0
  const maxTokens = numberFrom(String(snapshot.tokenBudget ?? snapshot.maxTokens ?? ""))
  const elapsedSeconds = numberFrom(String(snapshot.timeUsedSeconds ?? snapshot.elapsedSeconds ?? 0)) || 0
  const turnCount = numberFrom(String(snapshot.autoTurns ?? snapshot.turnCount ?? 0)) || 0
  const maxTurns = numberFrom(String(snapshot.maxAutoTurns ?? snapshot.maxTurns ?? ""))
  return {
    sessionID, objective, status, turnCount,
    maxTurns: maxTurns && maxTurns > 0 ? maxTurns : null,
    totalTokens, maxTokens: maxTokens && maxTokens > 0 ? maxTokens : null,
    remainingTokens: maxTokens && maxTokens > 0 ? Math.max(0, maxTokens - totalTokens) : null,
    startedAt: now - elapsedSeconds * 1000,
    elapsedSeconds: Math.max(0, Math.floor(elapsedSeconds)),
    sampledAt: now,
    lastStatus: typeof snapshot.lastStatus === "string" ? snapshot.lastStatus : "",
    stopReason: typeof snapshot.stopReason === "string" ? snapshot.stopReason : "",
    blockedReason: typeof snapshot.blocker === "string" ? snapshot.blocker : "",
    lastCheckpoint: snapshot.lastCheckpoint && typeof snapshot.lastCheckpoint.summary === "string"
      ? { summary: snapshot.lastCheckpoint.summary, timestamp: Number(snapshot.lastCheckpoint.timestamp) || now } : null,
    checkpoints: Array.isArray(snapshot.checkpoints) ? snapshot.checkpoints : [],
  }
}

function toolOutput(part) {
  if (!part || part.type !== "tool" || !GOAL_TOOL_NAMES.has(part.tool)) return undefined
  if (part.state?.status !== "completed") return undefined
  if (typeof part.state.output === "string") return part.state.output
  if (Array.isArray(part.state.content)) return part.state.content.find((e) => e?.type === "text")?.text
  return undefined
}

function parseGoalToolOutput(part, sessionID, now = Date.now()) {
  if (!part || part.tool === "clear_goal") return part?.tool === "clear_goal" ? null : undefined
  const output = toolOutput(part)
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output)
    if (parsed?.data && typeof parsed.data === "object")
      return parseGoalSnapshot(parsed.data, sessionID, now) || parseGoalStatusText(parsed.data.message, sessionID, now)
    if (typeof parsed?.data === "string") return parseGoalStatusText(parsed.data, sessionID, now)
    if (parsed?.goal === null) return null
    return parseGoalSnapshot(parsed?.goal, sessionID, now) || parseGoalStatusText(parsed?.message, sessionID, now)
  } catch { return parseGoalStatusText(output, sessionID, now) }
}

// ---- unified state reader (state file → messages → KV cache) ----

function goalStateFromSession(api, sessionID) {
  // 1. Try state file (primary source — matches server's live data)
  const fromFile = readStateGoal(api, sessionID)
  if (fromFile !== undefined) {
    goalCache.set(sessionID, fromFile)
    api.kv?.set(`goal.tui.${sessionID}`, fromFile)
    return fromFile
  }

  // 2. Try session messages (tool outputs like goal_status)
  const messages = [...api.state.session.messages(sessionID)]
  for (let mi = messages.length - 1; mi >= 0; mi -= 1) {
    const message = messages[mi]
    if (!message?.id) continue
    const parts = [...api.state.part(message.id)].reverse()
    for (const part of parts) {
      const result = parseGoalToolOutput(part, sessionID)
      if (result !== undefined) {
        goalCache.set(sessionID, result)
        api.kv?.set(`goal.tui.${sessionID}`, result)
        return result
      }
    }
  }

  // 3. Fall back to memory/KV cache
  const mem = goalCache.get(sessionID)
  if (mem !== undefined) return mem
  const persisted = api.kv?.get(`goal.tui.${sessionID}`, null)
  if (persisted !== null && persisted !== undefined) { goalCache.set(sessionID, persisted); return persisted }
  return undefined
}

// ---- helpers ----

function liveElapsed(goal, now) {
  if (goal.status !== "active") return goal.elapsedSeconds
  return goal.elapsedSeconds + Math.max(0, Math.floor((now - (goal.sampledAt || now)) / 1000))
}

function statusLabel(s) {
  if (s === "complete") return "complete"
  if (s === "blocked") return "blocked"
  if (s === "paused") return "paused"
  return "active"
}

// ---- reactive sidebar component ----

function createGoalSidebar(api, sessionID, revision, revMap) {
  const [goal, setGoal] = createSignal(goalStateFromSession(api, sessionID))
  const [nowSeconds, setNowSeconds] = createSignal(Date.now())

  createEffect(() => {
    revision()
    void revMap.get(sessionID)
    const next = goalStateFromSession(api, sessionID)
    if (next !== undefined) setGoal(next)
    setNowSeconds(Date.now())
  })

  createEffect(() => {
    if (goal()?.status !== "active") return
    const timer = setInterval(() => setNowSeconds(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return box({}, [() => {
    const g = goal()
    if (!g) return null
    const theme = api.theme.current
    if (g.status === "complete" || g.status === "unmet") {
      const elapsed = liveElapsed(g, nowSeconds())
      return text(
        { fg: g.status === "complete" ? theme.primary : theme.textMuted },
        [`${g.status === "complete" ? "Goal complete" : "Goal unmet"} (${formatDuration(elapsed)})`],
      )
    }
    return box({}, [
      text({ fg: theme.text }, ["Goal"]),
      text({ fg: theme.textMuted }, [`Status: ${statusLabel(g.status)}`]),
      text({ fg: theme.textMuted }, [() => `Time: ${formatDuration(liveElapsed(goal(), nowSeconds()))}`]),
      text({ fg: theme.textMuted }, [`Tokens: ${g.totalTokens}${g.maxTokens == null ? "" : `/${g.maxTokens}`}`]),
      text({ fg: theme.textMuted }, [`Auto-continues: ${g.turnCount}${g.maxTurns == null ? "" : `/${g.maxTurns}`}`]),
      text({ fg: theme.textMuted }, [g.objective.length > 50 ? g.objective.slice(0, 50) + "…" : g.objective]),
    ])
  }])
}

// ---- plugin entry ----

const tui = async (api) => {
  const [revision, setRevision] = createSignal(0)
  const revMap = new Map()

  const bump = (sid) => {
    revMap.set(sid, (revMap.get(sid) || 0) + 1)
    setRevision((v) => v + 1)
  }

  const unsubs = [
    api.event.on("message.part.updated", (ev) => { const sid = ev?.properties?.sessionID; if (sid) bump(sid) }),
    api.event.on("message.updated", (ev) => { const sid = ev?.properties?.sessionID; if (sid) bump(sid) }),
    api.event.on("session.status", (ev) => { const sid = ev?.properties?.sessionID; if (sid) bump(sid) }),
    api.event.on("session.idle", (ev) => { const sid = ev?.properties?.sessionID; if (sid) bump(sid) }),
  ]

  api.lifecycle?.onDispose(() => unsubs.forEach((u) => u()))

  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return createGoalSidebar(api, props.session_id, revision, revMap)
      },
    },
  })

  api.command?.register(() => [{
    title: "Goal",
    value: "goal.show",
    category: "Goal",
    description: "View the current long-running session goal",
    onSelect: () => {
      const route = api.route.current
      if (route.name !== "session" || !route.params?.sessionID) return
      const g = goalStateFromSession(api, route.params.sessionID)
      api.ui.toast({
        title: "Goal",
        message: g ? `${statusLabel(g.status)} | ${g.objective}` : "No goal",
        variant: "info",
        duration: 2500,
      })
    },
  }])
}

export default {
  id: "opencode-goal-plugin.tui",
  tui,
}
