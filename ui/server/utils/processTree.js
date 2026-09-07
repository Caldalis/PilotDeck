import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const stopError = (message) => Object.assign(new Error(message), { reason: 'processStopFailed' });

export async function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { timeout: 2000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const rows = JSON.parse(stdout || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId }));
  }
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, parent, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), zombie: state.startsWith('Z') };
  });
}

// All POSIX callers spawn their child detached, giving the task its own process
// group. A parent exit does NOT end ownership of the surviving group members.
export async function stopProcessTree(child, {
  platform = process.platform, graceMs = 1500, forceMs = 3000,
  inspect = () => listProcesses(platform), signal = (pid, name) => process.kill(pid, name),
  taskkill = (pids) => exec('taskkill', pids.flatMap(pid => ['/PID', String(pid)]).concat(['/T', '/F']), { timeout: 3000, windowsHide: true }),
} = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    if (child.exitCode !== null) return;
    throw stopError('Cannot identify the managed process.');
  }
  const root = child.pid;
  const known = new Set([root]);
  const remaining = async () => {
    const rows = await inspect();
    // Keep discovering descendants, including Windows children whose parent has
    // exited. POSIX group membership also survives reparenting to init/launchd.
    let changed;
    do {
      changed = false;
      for (const row of rows) if (known.has(row.parent) || (platform !== 'win32' && row.group === root)) {
        if (!known.has(row.pid)) { known.add(row.pid); changed = true; }
      }
    } while (changed);
    return rows.filter(row => known.has(row.pid) && !row.zombie);
  };
  const waitForExit = async (duration) => {
    const deadline = Date.now() + duration;
    do {
      if (!(await remaining()).length) return true;
      if (Date.now() >= deadline) return false;
      await pause(50);
    } while (true);
  };
  try {
    let living = await remaining();
    if (!living.length) return;
    if (platform === 'win32') {
      // Nonzero taskkill exits and launch failures are errors, never evidence
      // that the tree stopped. Do not discard caller-owned process records.
      await taskkill(living.some(row => row.pid === root) ? [root] : living.map(row => row.pid));
    } else {
      const send = async (name) => {
        living = await remaining();
        if (!living.length) return;
        try { signal(-root, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        // Also cover descendants observed before they changed process groups.
        for (const row of living.filter(row => row.group !== root)) {
          try { signal(row.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      };
      await send('SIGTERM');
      if (await waitForExit(graceMs)) return;
      await send('SIGKILL');
    }
    if (!(await waitForExit(forceMs))) throw new Error(`Managed process tree ${root} is still running.`);
  } catch (error) {
    throw stopError(`Could not confirm termination of process tree ${root}: ${error.message}`);
  }
}

export function runManagedCommand(command, args, {
  cwd, env = process.env, progress = () => {}, timeoutMs = 15 * 60 * 1000,
  stop = stopProcessTree,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      shell: process.platform === 'win32', windowsHide: true,
    });
    let finishing = false;
    const finish = async (failure) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      try {
        if (child.pid) await stop(child);
        if (failure) reject(failure); else resolve();
      } catch (error) { reject(error); }
      finally {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
    };
    // Independent from 'close': a grandchild holding stdout open must not keep
    // the update promise (and its lock) pending after the timeout.
    const timer = setTimeout(() => void finish(Object.assign(new Error(`${command} timed out.`), { reason: 'buildTimedOut' })), timeoutMs);
    child.stdout.on('data', data => progress(data.toString()));
    child.stderr.on('data', data => progress(data.toString()));
    child.once('error', error => void finish(error));
    child.once('close', code => void finish(code === 0 ? null : Object.assign(new Error(`${command} failed (${code}).`), { reason: 'buildFailed' })));
  });
}
