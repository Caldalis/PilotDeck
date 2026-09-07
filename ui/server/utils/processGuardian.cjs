// This process anchors one command's process group. Its lifetime and registration
// are independent of the Gateway that requested the command.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { listProcesses } = require('./processIdentity.cjs');
const { writeRecord, withoutTracking, isClosing } = require('./processScope.cjs');
const file = process.argv[2];
let record = JSON.parse(fs.readFileSync(file, 'utf8'));
const directory = path.dirname(file);
const closing = () => isClosing(directory, process.env.PILOTDECK_PROCESS_ENTRY);
if (closing()) { writeRecord(file, { state: 'done', parent: record.parent }); process.exit(0); }
const identity = listProcesses().find(row => row.pid === process.pid);
if (!identity?.birth) throw new Error('Cannot establish guardian identity');
record = { ...record, state: 'active', identity, members: [identity] };
writeRecord(file, record);
let worker;
let exited = false;
let code = 1;
process.on('SIGTERM', () => {}); // Keep the POSIX group anchor until forced stop.
process.on('SIGINT', () => {});
async function launch() {
  if (process.platform === 'win32') {
    const ready = `${file}.ready`, stopped = `${file}.stopped`, stop = `${file}.stop`;
    const holder = withoutTracking(() => cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'processJob.ps1'), String(process.pid), ready, stopped, stop, identity.birth], { stdio: 'ignore', windowsHide: true }));
    let failed = false;
    holder.on('error', () => { failed = true; });
    holder.on('exit', () => { if (!fs.existsSync(ready)) failed = true; });
    record.job = { ready, stopped, stop, holder: holder.pid, holderIdentity: listProcesses().find(row => row.pid === holder.pid) };
    if (!record.job.holderIdentity) throw new Error('Windows Job supervisor identity unavailable');
    writeRecord(file, record);
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(ready)) {
      if (failed || Date.now() >= deadline) throw new Error('Windows process containment could not be established');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (closing()) return;
  const stdio = Array.from({ length: record.descriptors || 3 }, (_, index) => index);
  if (record.ipc) stdio[record.ipcIndex >= 0 ? record.ipcIndex : 3] = 'ipc';
  worker = withoutTracking(() => cp.spawn(record.command, record.args, {
    stdio, env: process.env, detached: false, windowsHide: true, argv0: record.argv0,
    serialization: record.serialization, shell: record.shell, windowsVerbatimArguments: record.windowsVerbatimArguments,
  }));
  if (record.ipc) {
    process.on('message', message => { if (worker.connected) worker.send(message, () => {}); });
    worker.on('message', message => { if (process.connected) process.send(message, () => {}); });
    process.on('disconnect', () => { if (worker.connected) worker.disconnect(); });
  }
  worker.on('error', error => { process.stderr.write(`PilotDeck command failed: ${error.message}\n`); exited = true; });
  worker.on('exit', value => { exited = true; code = value ?? 1; });
}
launch().catch(error => { record.uncertain = true; writeRecord(file, record); process.stderr.write(`${error.message}\n`); });
const timer = setInterval(() => {
  try {
    if (!exited || closing()) return;
    if (process.platform !== 'win32') {
      const rows = listProcesses();
      const remaining = rows.filter(row => row.pid !== process.pid && !(row.parent === process.pid && row.pid !== worker.pid)
        && !row.zombie && row.group === process.pid);
      if (remaining.length) return;
    }
    // On Windows the external Job holder certifies descendant termination after
    // this guardian exits; a plain PID disappearing is never that certificate.
    writeRecord(file, process.platform === 'win32' ? { ...record, state: 'exiting' } : { state: 'done', parent: record.parent });
    clearInterval(timer);
    process.exit(code);
  } catch { record.uncertain = true; writeRecord(file, record); }
}, 200);
