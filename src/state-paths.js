import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

function homeBase(env) {
  return typeof env?.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir()
}

export function userStateDirectory(env = process.env) {
  const base = typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim()
    ? env.XDG_STATE_HOME.trim()
    : join(homeBase(env), ".local", "state")
  return resolve(base, "opencode-goal-plugin")
}

export function projectDirectory(cwd) {
  const absolute = resolve(typeof cwd === "string" && cwd.trim() ? cwd : process.cwd())
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export function sessionKey(sessionID) {
  return createHash("sha256").update(sessionID).digest("hex")
}

export function sessionStateFilePath(stateFilePath, sessionID) {
  return join(`${stateFilePath}.sessions`, sessionKey(sessionID), "state.json")
}

export function projectLocalStateFilePath(cwd) {
  return join(projectDirectory(cwd), ".opencode", "goals", "state.json")
}

// Aggregate locations used before project-local session shards were introduced.
export function xdgStateFilePath(env = process.env) {
  return join(userStateDirectory(env), "state.json")
}

export function legacyStateFilePaths(env = process.env) {
  return [join(homeBase(env), ".opencode-goal-plugin", "state.json"), xdgStateFilePath(env)]
}

// Shared by the server and TUI so custom paths and project identities agree.
export function resolveStateFilePath({ stateFilePath, env = process.env, cwd } = {}) {
  const base = typeof cwd === "string" && cwd.trim() ? cwd : process.cwd()
  const configured = typeof stateFilePath === "string" && stateFilePath.trim()
    ? stateFilePath.trim()
    : typeof env?.OPENCODE_GOAL_STATE_PATH === "string" ? env.OPENCODE_GOAL_STATE_PATH.trim() : ""
  if (configured) return isAbsolute(configured) ? configured : resolve(base, configured)
  return join(userStateDirectory(env), "projects", sessionKey(projectDirectory(base)), "state.json")
}
