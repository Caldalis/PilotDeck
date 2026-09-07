// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { listProcesses, stopProcessTree, runManagedCommand } from './processTree.js';

describe('managed process termination', () => {
  it('rejects failed Windows taskkill even if its root exits', async () => {
    const taskkill = vi.fn(async () => { throw Object.assign(new Error('taskkill failed'), { code: 1 }); });
    await expect(stopProcessTree({ pid: 123, exitCode: null }, { platform: 'win32',
      inspect: async () => [{ pid: 123, parent: 1 }, { pid: 124, parent: 123 }], taskkill,
    })).rejects.toMatchObject({ reason: 'processStopFailed' });
    expect(taskkill).toHaveBeenCalledWith([123]);
  });
  it('rejects a surviving Windows descendant after taskkill reports success', async () => {
    const inspect = vi.fn().mockResolvedValueOnce([{ pid: 123, parent: 1 }, { pid: 124, parent: 123 }])
      .mockResolvedValue([{ pid: 124, parent: 1 }]);
    await expect(stopProcessTree({ pid: 123 }, { platform: 'win32', inspect, taskkill: async () => {}, forceMs: 10 }))
      .rejects.toMatchObject({ reason: 'processStopFailed' });
  });
  it('does not signal a tree when process inspection fails', async () => {
    const signal = vi.fn();
    await expect(stopProcessTree({ pid: 123 }, { inspect: async () => { throw new Error('ps failed'); }, signal }))
      .rejects.toMatchObject({ reason: 'processStopFailed' });
    expect(signal).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('kills a real stubborn grandchild after its parent exits', async () => {
    const grandchildScript = 'process.on("SIGTERM",()=>{}); process.stdout.write("ready\\n"); setInterval(()=>{},1000)';
    const child = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:['ignore','inherit','inherit']}); setInterval(()=>{},1000)`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout, 'data');
      const group = (await listProcesses()).filter(row => row.group === child.pid);
      expect(group.length).toBeGreaterThanOrEqual(2);
      await stopProcessTree(child, { graceMs: 100, forceMs: 1000 });
      expect((await listProcesses()).filter(row => row.group === child.pid && !row.zombie)).toEqual([]);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} child.stdout.destroy(); child.stderr.destroy(); }
  });
  it.skipIf(process.platform === 'win32')('times out without waiting forever for inherited stdout to close', async () => {
    let group;
    const script = `console.log(process.pid); require('node:child_process').spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
    await expect(runManagedCommand(process.execPath, ['-e', script], { timeoutMs: 500,
      progress: value => { group = Number(value.trim()); }, stop: child => stopProcessTree(child, { graceMs: 100, forceMs: 1000 }),
    })).rejects.toMatchObject({ reason: 'buildTimedOut' });
    expect(group).toBeGreaterThan(0);
    expect((await listProcesses()).filter(row => row.group === group && !row.zombie)).toEqual([]);
  });
  it('surfaces a failed stop instead of suggesting safe cleanup', async () => {
    await expect(runManagedCommand(process.execPath, ['-e', ''], { stop: async () => { throw Object.assign(new Error('denied'), { reason: 'processStopFailed' }); } }))
      .rejects.toMatchObject({ reason: 'processStopFailed' });
  });
});
