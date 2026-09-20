import { createApp } from './app.js';
import { assertCommsSchema } from './commsDb.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';

const config = loadConfig();

// Before serving anything. The `comms` schema is migrated by a DIFFERENT repository
// (novamerx-comms-worker), and a cross-compose-project `depends_on` cannot express that
// ordering — so TPS asserts rather than assumes. A schema that is absent and one that is
// behind then fail the same way, here, with a message naming the repository and the
// command, instead of surfacing later as a query error on the ITT Dispatch page.
const bootDb = new Database(config);
try {
  await assertCommsSchema(bootDb);
} finally {
  await bootDb.close();
}

const app = await createApp(config);
await app.listen({ host: config.HOST, port: config.PORT });
