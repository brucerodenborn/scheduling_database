import { onyx } from '@onyx.dev/onyx-database';

// Call only after authenticating and authorizing the application request.
// Initialization is lazy so the canvas also works without a database.
export function database(env = process.env) {
  if (env.ONYX_DEBUG === 'true') throw new Error('Disable ONYX_DEBUG before connecting.');
  const databaseId = env.ONYX_DATABASE_ID;
  const apiKey = env.ONYX_API_KEY || env.ONYX_DATABASE_API_KEY;
  const apiSecret = env.ONYX_API_SECRET || env.ONYX_DATABASE_API_SECRET;
  if (![databaseId, apiKey, apiSecret].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('Connect a database in Workspaces → Environments before using data features.');
  }
  return onyx.init({
    baseUrl: env.ONYX_BASE_URL || env.ONYX_DATABASE_BASE_URL || 'https://api.onyx.dev',
    databaseId, apiKey, apiSecret, requestLoggingEnabled: false, responseLoggingEnabled: false,
  });
}
