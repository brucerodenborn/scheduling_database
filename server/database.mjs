import { onyx } from '@onyx.dev/onyx-database';
import { onyxConfiguration } from './config.mjs';

// Call only after authenticating and authorizing the application request.
// Initialization is lazy so the canvas also works without a database.
export function database(env = process.env) {
  try {
    return onyx.init(onyxConfiguration(env));
  } catch (error) {
    if (error.message.startsWith('Missing configuration:')) {
      throw new Error('Connect a database in Workspaces → Environments before using data features.');
    }
    throw error;
  }
}
