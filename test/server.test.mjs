import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/index.mjs';
import { database } from '../server/database.mjs';

test('canvas serves preview and readiness without database bindings or business routes', async () => {
  const server = createApplication();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Your application is ready/);
    assert.deepEqual(await (await fetch(`${origin}/health/ready`)).json(), { status: 'ready' });
    assert.equal((await fetch(`${origin}/api/notes`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('optional database reports missing setup without falling back to data', () => {
  assert.throws(() => database({}), /Connect a database/);
  assert.throws(() => database({ ONYX_DEBUG: 'true' }), /Disable ONYX_DEBUG/);
});
