import type { ChildProcess } from "node:child_process";

// Installed by the desktop/build supervisor at launch. Standalone CLI processes
// keep their existing lifecycle; a supervised child never uses a delayed raw PID.
export function stopSupervisedProcess(child: ChildProcess): Promise<void> | null {
  const stop = (child as unknown as Record<symbol, unknown>)[Symbol.for("pilotdeck.stopProcess")];
  return typeof stop === "function" ? stop() : null;
}
