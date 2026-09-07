// Scoped Node preload. Records are created BEFORE spawn; a guardian records its
// own identity BEFORE executing user code. Pending/uncertain records block stop.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const cp = require('node:child_process');
const KEY = Symbol.for('pilotdeck.processScope');
const rawSpawn = cp.ChildProcess.prototype.spawn;
let bypass = false;
function writeRecord(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function isClosing(directory, entry) {
  if (fs.existsSync(path.join(directory, 'closing'))) return true;
  const visited = new Set();
  while (entry && !visited.has(entry)) {
    visited.add(entry);
    if (fs.existsSync(path.join(directory, `${entry}.closing`))) return true;
    const record = JSON.parse(fs.readFileSync(path.join(directory, `${entry}.json`), 'utf8'));
    entry = record.parent;
  }
  return false;
}
function attach(child, scope) {
  child[KEY] = scope;
  const stop = () => import('./processTree.js').then(module => module.stopProcessTree(child));
  child[Symbol.for('pilotdeck.stopProcess')] = stop;
  const originalKill = child.kill;
  child.kill = function(signal = 'SIGTERM') {
    if (!['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal)) return originalKill.call(this, signal);
    this.killed = true;
    void stop().catch(error => { console.error('[process-scope] Cleanup unconfirmed:', error.message); });
    return true;
  };
}
function prepare(scope, spec) {
  if (isClosing(scope.directory, scope.entry)) throw new Error('PilotDeck runtime is stopping');
  const entry = randomUUID();
  const file = path.join(scope.directory, `${entry}.json`);
  writeRecord(file, { state: 'pending', parent: scope.entry || null, ...spec });
  // A stop racing registration sees either this pending record or the closing
  // marker. It cannot miss a command that has already started executing.
  if (isClosing(scope.directory, scope.entry)) {
    writeRecord(file, { state: 'done', parent: scope.entry || null });
    throw new Error('PilotDeck runtime is stopping');
  }
  return { directory: scope.directory, entry, file };
}
function withoutTracking(fn) { bypass = true; try { return fn(); } finally { bypass = false; } }
function install() {
  if (cp.ChildProcess.prototype.spawn[KEY]) return;
  const tracked = function(options) {
    const directory = process.env.PILOTDECK_PROCESS_SCOPE;
    if (bypass || !directory) return rawSpawn.call(this, options);
    // Every asynchronous Node launch is registered, including detached children
    // of commands and plugins. No polling interval can lose a fast launch/crash.
    const scope = prepare({ directory, entry: process.env.PILOTDECK_PROCESS_ENTRY }, {
      command: options.file, args: options.args.slice(1), argv0: options.args[0],
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      ipc: Array.isArray(options.stdio) && options.stdio.some(item => item === 'ipc' || item?.type === 'ipc'),
      ipcIndex: Array.isArray(options.stdio) ? options.stdio.findIndex(item => item === 'ipc' || item?.type === 'ipc') : -1,
      serialization: options.serialization,
      descriptors: Array.isArray(options.stdio) ? options.stdio.length : 3,
    });
    attach(this, scope);
    const pairs = (options.envPairs || []).filter(pair => !/^PILOTDECK_PROCESS_(SCOPE|ENTRY)=/.test(pair));
    pairs.push(`PILOTDECK_PROCESS_SCOPE=${directory}`, `PILOTDECK_PROCESS_ENTRY=${scope.entry}`);
    // Register scope inheritance even if the caller supplied a replacement env.
    const preload = `--require ${JSON.stringify(__filename)}`;
    const nodeOptions = pairs.findIndex(pair => pair.startsWith('NODE_OPTIONS='));
    if (nodeOptions < 0) pairs.push(`NODE_OPTIONS=${preload}`);
    else if (!pairs[nodeOptions].includes(__filename)) pairs[nodeOptions] += ` ${preload}`;
    const node = process.env.PILOTDECK_PROCESS_NODE || process.execPath;
    try {
      const result = rawSpawn.call(this, { ...options, file: node,
        args: [node, path.join(__dirname, 'processGuardian.cjs'), scope.file], envPairs: pairs,
        detached: process.platform !== 'win32', windowsVerbatimArguments: false });
      this.once('error', () => { if (!this.pid) writeRecord(scope.file, { state: 'done', parent: process.env.PILOTDECK_PROCESS_ENTRY || null }); });
      return result;
    } catch (error) { writeRecord(scope.file, { state: 'done', parent: process.env.PILOTDECK_PROCESS_ENTRY || null }); throw error; }
  };
  tracked[KEY] = true;
  cp.ChildProcess.prototype.spawn = tracked;
}
function spawnManaged(command, args, options, node = process.execPath) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-process-scope-'));
  fs.chmodSync(directory, 0o700);
  const scope = prepare({ directory }, { command, args, ipc: Array.isArray(options.stdio) && options.stdio.includes('ipc'), ipcIndex: Array.isArray(options.stdio) ? options.stdio.indexOf('ipc') : -1, serialization: options.serialization, descriptors: Array.isArray(options.stdio) ? options.stdio.length : 3 });
  const env = { ...(options.env || process.env), PILOTDECK_PROCESS_SCOPE: directory, PILOTDECK_PROCESS_ENTRY: scope.entry,
    PILOTDECK_PROCESS_NODE: node, NODE_OPTIONS: `${(options.env || process.env).NODE_OPTIONS || ''} --require ${JSON.stringify(__filename)}`.trim() };
  // shell belongs to the real command, not the Node guardian executable.
  const record = JSON.parse(fs.readFileSync(scope.file, 'utf8'));
  writeRecord(scope.file, { ...record, shell: options.shell });
  const child = withoutTracking(() => cp.spawn(node, [path.join(__dirname, 'processGuardian.cjs'), scope.file], {
    ...options, shell: false, detached: process.platform !== 'win32', env,
  }));
  attach(child, scope);
  child.once('error', () => { if (!child.pid) writeRecord(scope.file, { state: 'done', parent: null }); });
  return child;
}
module.exports = { KEY, install, writeRecord, withoutTracking, spawnManaged, isClosing };
if (process.env.PILOTDECK_PROCESS_SCOPE) install();
