import { restoreState, uploadState } from './persistence.js';

await restoreState();
const [{ default: db }] = await Promise.all([
  import('./db.js'),
  import('../admin/server.js'),
  import('./index.js'),
]);

async function persist() {
  db.pragma('wal_checkpoint(TRUNCATE)');
  await uploadState();
}

setInterval(() => persist().catch((error) => console.error('Snapshot gagal:', error)), 5 * 60 * 1000).unref();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    try { await persist(); } finally { process.exit(0); }
  });
}
