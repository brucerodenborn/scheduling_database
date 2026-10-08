import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { database } from './database.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const slots = [480, 550, 620, 690, 760, 830, 900].map((startMinutes, slotIndex) => ({
  slotIndex, startMinutes, endMinutes: startMinutes + 60,
}));
const colors = new Set(['sage', 'blue', 'violet', 'amber', 'rose', 'teal']);
const contentTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};

function tokenFor(env) {
  if (env.WORKSPACE_PREVIEW !== 'true' || (env.WORKSPACE_PREVIEW_AUTH_SECRET?.length || 0) < 32) return null;
  return createHmac('sha256', env.WORKSPACE_PREVIEW_AUTH_SECRET).update('course-scheduler-preview').digest('base64url');
}

function authorized(request, env) {
  const expected = tokenFor(env);
  const actual = request.headers.authorization?.replace(/^Bearer /, '') || '';
  if (!expected || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function sameOrigin(request) {
  if (!['POST', 'PATCH', 'DELETE'].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 16_384) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(value || '{}'); } catch { throw Object.assign(new Error('Invalid request.'), { status: 400 }); }
}

const clean = (value, maximum, required = true) => {
  const result = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if ((required && !result) || result.length > maximum) throw Object.assign(new Error('Please check the course details.'), { status: 400 });
  return result;
};

function validateCourse(input) {
  const weekday = Number(input.weekday);
  const slotIndex = Number(input.slotIndex);
  const slot = slots[slotIndex];
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5 || !slot) {
    throw Object.assign(new Error('Choose a valid weekday and time.'), { status: 400 });
  }
  const requestedWeekdays = Array.isArray(input.weekdays) ? input.weekdays : [weekday];
  const weekdays = [...new Set([weekday, ...requestedWeekdays.map(Number)])].sort((a, b) => a - b);
  if (weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 5)) {
    throw Object.assign(new Error('Choose valid repeat days.'), { status: 400 });
  }
  return {
    name: clean(input.name, 80), code: clean(input.code, 20, false),
    instructor: clean(input.instructor, 80, false), room: clean(input.room, 40, false),
    color: colors.has(input.color) ? input.color : 'sage', weekday, weekdays, slot,
  };
}

async function allRecords(query) {
  const result = await query.limit(500).list();
  return Array.from(result);
}

async function loadSchedule(db) {
  const [courses, meetings] = await Promise.all([
    allRecords(db.from('Course')),
    allRecords(db.from('CourseMeeting')),
  ]);
  const byId = new Map(courses.map(course => [course.courseId, course]));
  return meetings.map(meeting => ({ ...meeting, course: byId.get(meeting.courseId) }))
    .filter(item => item.course)
    .sort((a, b) => a.weekday - b.weekday || a.slotIndex - b.slotIndex);
}

async function saveNew(db, input) {
  const value = validateCourse(input);
  const now = new Date().toISOString();
  const courseId = randomUUID();
  const records = value.weekdays.map(weekday => ({ meetingId: randomUUID(), courseId, weekday,
    slotIndex: value.slot.slotIndex, startMinutes: value.slot.startMinutes, endMinutes: value.slot.endMinutes,
    room: value.room, createdAt: now }));
  await db.save('Course', { courseId, name: value.name, code: value.code, instructor: value.instructor, color: value.color, createdAt: now });
  try {
    await db.save('CourseMeeting', records);
  } catch (error) {
    for (const record of records) await db.delete('CourseMeeting', record.meetingId).catch(() => {});
    await db.delete('Course', courseId).catch(() => {});
    throw error;
  }
  return records.map(record => record.meetingId);
}

async function updateExisting(db, meetingId, input) {
  const value = validateCourse(input);
  const schedule = await loadSchedule(db);
  const existing = schedule.find(item => item.meetingId === meetingId);
  if (!existing) throw Object.assign(new Error('Course not found.'), { status: 404 });
  const courseMeetings = schedule.filter(item => item.courseId === existing.courseId);
  const byWeekday = new Map(courseMeetings.map(item => [item.weekday, item]));
  const now = new Date().toISOString();
  const records = value.weekdays.map(weekday => {
    const previous = byWeekday.get(weekday);
    return { meetingId: previous?.meetingId || randomUUID(), courseId: existing.courseId, weekday,
      slotIndex: value.slot.slotIndex, startMinutes: value.slot.startMinutes, endMinutes: value.slot.endMinutes,
      room: value.room, createdAt: previous?.createdAt || now };
  });
  await db.save('CourseMeeting', records);
  await db.save('Course', { ...existing.course, name: value.name, code: value.code, instructor: value.instructor, color: value.color });
  const retained = new Set(records.map(record => record.meetingId));
  for (const meeting of courseMeetings) if (!retained.has(meeting.meetingId)) await db.delete('CourseMeeting', meeting.meetingId);
}

async function servePage(response, env) {
  const template = await readFile(join(root, 'client/index.html'), 'utf8');
  const token = tokenFor(env) || '';
  const page = template.replace('%%AUTH_TOKEN%%', token).replace('%%AUTH_READY%%', token ? 'true' : 'false');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'" });
  response.end(page);
}

export function createApplication(options = {}) {
  const env = options.env || process.env;
  let db = options.db;
  const getDb = () => db ||= database(env);
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health/ready') return json(response, 200, { status: 'ready' });
      if (request.method === 'GET' && url.pathname === '/') return await servePage(response, env);
      if (request.method === 'GET' && ['/styles.css', '/app.js'].includes(url.pathname)) {
        const file = join(root, 'client', url.pathname.slice(1));
        response.writeHead(200, { 'Content-Type': contentTypes[extname(file)], 'Cache-Control': 'no-store' });
        response.end(await readFile(file)); return;
      }
      if (!url.pathname.startsWith('/api/')) { response.writeHead(404); response.end('Not found'); return; }
      if (!authorized(request, env)) return json(response, 401, { error: 'Your workspace session is not available.' });
      if (!sameOrigin(request)) return json(response, 403, { error: 'Request origin was not accepted.' });
      if (request.method === 'GET' && url.pathname === '/api/schedule') return json(response, 200, { schedule: await loadSchedule(getDb()), slots });
      if (request.method === 'POST' && url.pathname === '/api/schedule') {
        const meetingIds = await saveNew(getDb(), await body(request));
        return json(response, 201, { meetingIds });
      }
      const match = url.pathname.match(/^\/api\/schedule\/([0-9a-f-]{36})$/i);
      if (match && request.method === 'PATCH') {
        await updateExisting(getDb(), match[1], await body(request));
        return json(response, 200, { ok: true });
      }
      if (match && request.method === 'DELETE') {
        const schedule = await loadSchedule(getDb());
        const existing = schedule.find(item => item.meetingId === match[1]);
        if (!existing) return json(response, 404, { error: 'Course not found.' });
        for (const meeting of schedule.filter(item => item.courseId === existing.courseId)) {
          await getDb().delete('CourseMeeting', meeting.meetingId);
        }
        await getDb().delete('Course', existing.courseId);
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error('Request failed:', error.message);
      return json(response, status, { error: status >= 500 ? 'The schedule could not be reached. Try again.' : error.message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApplication();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
