/**
 * Recognizing subagent sessions, so they never send conversation context.
 *
 * pi-subagents runs children in-process: a foreground child lives in the parent's Pi process, a
 * background child in a runner process with PI_SUBAGENT_CHILD=1. A foreground child sees
 * PI_SUBAGENT_EXTENSION_BINDINGS only while it starts, and only when the launch carries extension
 * bindings, so recognition is best-effort: it runs at `session_start` and is remembered per
 * session. PI_SUBAGENT_RUN_ID is kept for older hosts.
 */

export function isSubagentEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.PI_SUBAGENT_EXTENSION_BINDINGS !== undefined
    || env.PI_SUBAGENT_CHILD === "1"
    || (env.PI_SUBAGENT_RUN_ID !== undefined && env.PI_SUBAGENT_RUN_ID !== "");
}

const subagentSessions = new WeakSet<object>();

/** Remember the session as a subagent session when the environment marks it as one. */
export function recognizeSubagentSession(session: object, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (subagentSessions.has(session)) return true;
  if (!isSubagentEnv(env)) return false;
  subagentSessions.add(session);
  return true;
}

export function isSubagentSession(session: object | undefined): boolean {
  return session !== undefined && subagentSessions.has(session);
}
