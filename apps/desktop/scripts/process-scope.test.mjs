import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnManaged, stopProcessTree, listProcesses } from '../../../ui/server/utils/processTree.js';
const options = { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
test('supervised runtime forwards IPC and stops its registered tasks', { timeout: 40000 }, async () => {
  const child = spawnManaged(process.execPath, ['-e', `const {spawn}=require('node:child_process');const task=spawn(process.execPath,['-e','process.send(process.pid);setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','pipe','ipc']});task.on('message',pid=>process.send(pid));setInterval(()=>{},1000)`], options);
  child.stderr.on('data', data => process.stderr.write(data));
  try {
    const [pid] = await once(child, 'message');
    assert.ok(Number.isInteger(pid));
    await stopProcessTree(child, { forceMs: 10000 });
    assert.equal((await listProcesses()).some(row => row.pid === pid && !row.zombie), false);
  } finally { await stopProcessTree(child, { forceMs: 10000 }).catch(() => {}); child.stdout.destroy(); child.stderr.destroy(); }
});
test('parent crash cannot strand a registered detached task', { timeout: 40000 }, async () => {
  const child = spawnManaged(process.execPath, ['-e', `const {spawn}=require('node:child_process');const task=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','inherit']});task.stdout.on('data',data=>{process.stdout.write(data);setTimeout(()=>process.exit(2),100)});task.unref()`], options);
  child.stderr.on('data', data => process.stderr.write(data));
  try {
    const exited = once(child, 'exit');
    const [data] = await once(child.stdout, 'data');
    const pid = Number(data.toString().trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    await exited;
    await stopProcessTree(child, { forceMs: 10000 });
    assert.equal((await listProcesses()).some(row => row.pid === pid && !row.zombie), false);
  } finally { await stopProcessTree(child, { forceMs: 10000 }).catch(() => {}); child.stdout.destroy(); child.stderr.destroy(); }
});
