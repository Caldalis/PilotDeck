const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
    { timeout: 3000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
    const rows = JSON.parse(stdout || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, birth: row.Birth }));
  }
  const stdout = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    { timeout: 2000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return stdout.trim().split('\n').filter(Boolean).flatMap(line => {
    const [pid, parent, group, state, ...started] = line.trim().split(/\s+/);
    let birth = started.join(' ');
    if (platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      } catch { return []; } // Exited during enumeration; never invent an identity.
    }
    return [{ pid: Number(pid), parent: Number(parent), group: Number(group), birth, zombie: state.startsWith('Z') }];
  });
}
const sameProcess = (left, right) => Boolean(left && right && left.birth && left.pid === right.pid && left.birth === right.birth && left.group === right.group);
module.exports = { listProcesses, sameProcess };
