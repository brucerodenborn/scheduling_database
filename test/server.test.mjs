import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApplication } from '../server/index.mjs';
import { database } from '../server/database.mjs';

const secret = 'a-private-preview-secret-that-is-long-enough';
const env = { WORKSPACE_PREVIEW: 'true', WORKSPACE_PREVIEW_AUTH_SECRET: secret };
const token = createHmac('sha256', secret).update('course-scheduler-preview').digest('base64url');

function fakeDatabase() {
  const tables = { Course: [], CourseMeeting: [] };
  return {
    tables,
    from(table) {
      return { limit() { return this; }, async list() { return [...tables[table]]; } };
    },
    async save(table, row) {
      if (Array.isArray(row)) return Promise.all(row.map(item => this.save(table, item)));
      const key = table === 'Course' ? 'courseId' : 'meetingId';
      const index = tables[table].findIndex(item => item[key] === row[key]);
      const saved = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
      if (index >= 0) tables[table][index] = saved; else tables[table].push(saved);
      return saved;
    },
    async delete(table, id) {
      const key = table === 'Course' ? 'courseId' : 'meetingId';
      const index = tables[table].findIndex(item => item[key] === id);
      if (index >= 0) tables[table].splice(index, 1);
      return true;
    },
  };
}

async function withServer(action) {
  const db = fakeDatabase();
  const server = createApplication({ db, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try { await action({ origin, db }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const headers = origin => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: origin });
const course = { name: 'Biology', code: 'BIO 101', instructor: 'Dr. Rivera', room: '204', color: 'sage', weekday: 1, slotIndex: 0 };

test('serves the scheduler, assets and readiness', async () => withServer(async ({ origin }) => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Weekly schedule/);
  const styles = await fetch(`${origin}/styles.css`);
  assert.equal(styles.status, 200);
  assert.match(await styles.text(), /\.repeat-day input\{[^}]*opacity:1[^}]*pointer-events:auto/);
  assert.deepEqual(await (await fetch(`${origin}/health/ready`)).json(), { status: 'ready' });
  assert.equal((await fetch(`${origin}/missing`)).status, 404);
}));

test('requires a signed workspace session for data routes', async () => withServer(async ({ origin }) => {
  assert.equal((await fetch(`${origin}/api/schedule`)).status, 401);
  assert.equal((await fetch(`${origin}/api/schedule`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
}));

test('creates, lists, updates and deletes a recurring course', async () => withServer(async ({ origin, db }) => {
  const created = await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, weekdays: [1, 3, 5] }) });
  assert.equal(created.status, 201);
  const { meetingIds } = await created.json();
  assert.equal(meetingIds.length, 3);
  assert.match(meetingIds[0], /^[0-9a-f-]{36}$/);
  assert.equal(db.tables.Course.length, 1);
  assert.deepEqual(db.tables.CourseMeeting.map(item => item.weekday), [1, 3, 5]);
  assert.ok(db.tables.CourseMeeting.every(item => item.courseId === db.tables.Course[0].courseId));
  assert.ok(db.tables.CourseMeeting.every(item => item.startMinutes === 480 && item.endMinutes === 540));

  const list = await (await fetch(`${origin}/api/schedule`, { headers: headers(origin) })).json();
  assert.equal(list.schedule[0].course.name, 'Biology');
  assert.equal(list.schedule.length, 3);
  assert.equal(list.slots.length, 7);

  const conflict = await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Chemistry', weekday: 2, weekdays: [2, 3] }) });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /Wednesday/);

  const updated = await fetch(`${origin}/api/schedule/${meetingIds[0]}`, { method: 'PATCH', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Advanced Biology', weekday: 2, weekdays: [2, 4], slotIndex: 6 }) });
  assert.equal(updated.status, 200);
  assert.equal(db.tables.Course[0].name, 'Advanced Biology');
  assert.deepEqual(db.tables.CourseMeeting.map(item => item.weekday).sort(), [2, 4]);
  assert.ok(db.tables.CourseMeeting.every(item => item.startMinutes === 900));

  const deleted = await fetch(`${origin}/api/schedule/${db.tables.CourseMeeting[0].meetingId}`, { method: 'DELETE', headers: headers(origin) });
  assert.equal(deleted.status, 200);
  assert.equal(db.tables.Course.length, 0);
  assert.equal(db.tables.CourseMeeting.length, 0);
}));

test('rejects invalid schedules and cross-origin mutations', async () => withServer(async ({ origin }) => {
  const invalid = await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, slotIndex: 7 }) });
  assert.equal(invalid.status, 400);
  const crossOrigin = await fetch(`${origin}/api/schedule`, { method: 'POST', headers: { ...headers(origin), Origin: 'https://example.com' }, body: JSON.stringify(course) });
  assert.equal(crossOrigin.status, 403);
}));

test('database setup errors are explicit', () => {
  assert.throws(() => database({}), /Connect a database/);
  assert.throws(() => database({ ONYX_DEBUG: 'true' }), /must be disabled/);
});
