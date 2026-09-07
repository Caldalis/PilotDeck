#!/usr/bin/env node
import { createWebUpdateService } from '../ui/server/services/webUpdateService.js';

try {
  if (process.argv.length > 2) throw new Error('Use scripts/update.sh without arguments, then restart the service manually.');
  const service = createWebUpdateService();
  const status = await service.check();
  if (status.reason === 'upToDate') {
    console.log('Already at the latest release.');
    process.exitCode = 2;
  } else {
    if (!status.canUpdate) throw new Error(`Self-update unavailable: ${status.reason}. Update manually.`);
    await service.apply(status.latest, (line) => console.log(line));
    console.log('Update prepared. Restart PilotDeck to apply it.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
