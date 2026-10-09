import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { database } from './database.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const slots = [480, 550, 620, 690, 760, 830, 900].map((startMinutes, slotIndex) => ({
  slotIndex, startMinutes, endMinutes: startMinutes + 60,
}));
const colors = new Set(['sage', 'blue', 'violet', 'amber', 'rose', 'teal']);
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const contentTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const exportColumns = [
  ['Course Number', 'courseNumber'], ['Section', 'section'], ['Days', 'days'], ['Time', 'time'],
  ['Instructor(s)', 'instructors'], ['Specific Room Preference', 'specificRoomPreference'],
  ['Change if total seats ≠ 30', 'seatCountIfNotThirty'],
  ['Course Title (32 Characters or less - including spaces) Abbreviate if necessary', 'courseTitle'],
  ['General Education Tags (E1, E2, E3, A, R, C, D, S)', 'generalEducationTags'],
  ['Crosslisted? If so, please provide', 'crosslistedCourses'],
  ['False limits during registration?', 'falseLimitsDuringRegistration'],
  ['Please provide precisely what you NEED your classroom to contain', 'classroomNeeds'],
];

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

const wholeNumber = (value, maximum) => {
  if (value === '' || value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > maximum) throw Object.assign(new Error('Please check enrollment and capacity.'), { status: 400 });
  return result;
};

const decimalNumber = (value, maximum) => {
  if (value === '' || value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > maximum) throw Object.assign(new Error('Please check the credit hours.'), { status: 400 });
  return Math.round(result * 100) / 100;
};

const dateValue = value => {
  const result = clean(value, 10, false);
  if (result && !/^\d{4}-\d{2}-\d{2}$/.test(result)) throw Object.assign(new Error('Please check the course dates.'), { status: 400 });
  return result;
};

const optionalBoolean = value => {
  if (value === '' || value === null || value === undefined) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw Object.assign(new Error('Please check the registration limits selection.'), { status: 400 });
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
  const startDate = dateValue(input.startDate);
  const endDate = dateValue(input.endDate);
  if (startDate && endDate && startDate > endDate) throw Object.assign(new Error('The end date must be on or after the start date.'), { status: 400 });
  return {
    name: clean(input.name, 80), code: clean(input.code, 20, false),
    instructor: clean(input.instructor, 80, false), room: clean(input.room, 40, false),
    section: clean(input.section, 30, false), department: clean(input.department, 60, false),
    term: clean(input.term, 40, false), startDate, endDate,
    deliveryMode: clean(input.deliveryMode, 40, false),
    creditHours: decimalNumber(input.creditHours, 50), enrollment: wholeNumber(input.enrollment, 100000),
    capacity: wholeNumber(input.capacity, 100000), notes: clean(input.notes, 2000, false),
    specificRoomPreference: clean(input.specificRoomPreference, 120, false),
    seatCountIfNotThirty: wholeNumber(input.seatCountIfNotThirty, 100000),
    generalEducationTags: clean(input.generalEducationTags, 120, false),
    crosslistedCourses: clean(input.crosslistedCourses, 200, false),
    falseLimitsDuringRegistration: optionalBoolean(input.falseLimitsDuringRegistration),
    classroomNeeds: clean(input.classroomNeeds, 1500, false),
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

const courseFields = value => ({
  name: value.name, code: value.code, instructor: value.instructor, color: value.color,
  section: value.section, department: value.department, term: value.term,
  startDate: value.startDate, endDate: value.endDate, deliveryMode: value.deliveryMode,
  creditHours: value.creditHours, enrollment: value.enrollment, capacity: value.capacity, notes: value.notes,
  specificRoomPreference: value.specificRoomPreference, seatCountIfNotThirty: value.seatCountIfNotThirty,
  generalEducationTags: value.generalEducationTags, crosslistedCourses: value.crosslistedCourses,
  falseLimitsDuringRegistration: value.falseLimitsDuringRegistration, classroomNeeds: value.classroomNeeds,
});

async function saveNew(db, input) {
  const value = validateCourse(input);
  const now = new Date().toISOString();
  const courseId = randomUUID();
  const records = value.weekdays.map(weekday => ({ meetingId: randomUUID(), courseId, weekday,
    slotIndex: value.slot.slotIndex, startMinutes: value.slot.startMinutes, endMinutes: value.slot.endMinutes,
    room: value.room, createdAt: now }));
  await db.save('Course', { courseId, ...courseFields(value), createdAt: now });
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
  await db.save('Course', { ...existing.course, ...courseFields(value) });
  const retained = new Set(records.map(record => record.meetingId));
  for (const meeting of courseMeetings) if (!retained.has(meeting.meetingId)) await db.delete('CourseMeeting', meeting.meetingId);
}

const formatClock = minutes => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};

function exportRows(schedule) {
  const dayCodes = ['', 'M', 'T', 'W', 'R', 'F'];
  const grouped = new Map();
  for (const item of schedule) {
    const group = grouped.get(item.courseId) || { item, meetings: [] };
    group.meetings.push(item); grouped.set(item.courseId, group);
  }
  return [...grouped.values()].map(({ item, meetings }) => ({
    courseNumber: item.course.code || '', section: item.course.section || '',
    days: meetings.sort((a, b) => a.weekday - b.weekday).map(meeting => dayCodes[meeting.weekday]).join(''),
    time: `${formatClock(item.startMinutes)} - ${formatClock(item.endMinutes)}`,
    instructors: item.course.instructor || '', specificRoomPreference: item.course.specificRoomPreference || '',
    seatCountIfNotThirty: item.course.seatCountIfNotThirty ?? '', courseTitle: item.course.name || '',
    generalEducationTags: item.course.generalEducationTags || '', crosslistedCourses: item.course.crosslistedCourses || '',
    falseLimitsDuringRegistration: item.course.falseLimitsDuringRegistration == null ? '' : item.course.falseLimitsDuringRegistration ? 'Yes' : 'No',
    classroomNeeds: item.course.classroomNeeds || '',
  })).sort((a, b) => a.courseNumber.localeCompare(b.courseNumber) || a.section.localeCompare(b.section));
}

const spreadsheetText = value => {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};

function csvBuffer(rows) {
  const quote = value => `"${spreadsheetText(value).replaceAll('"', '""')}"`;
  const lines = [exportColumns.map(([label]) => quote(label)).join(',')];
  for (const row of rows) lines.push(exportColumns.map(([, key]) => quote(row[key])).join(','));
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function xlsxBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Course Schedule';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Course Schedule', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = exportColumns.map(([header, key]) => ({ header, key, width: Math.max(12, Math.min(38, header.length + 5)) }));
  rows.forEach(row => sheet.addRow(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? spreadsheetText(value) : value]))));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FF000000' } };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.height = 48;
  sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(exportColumns.length).letter}1` };
  sheet.getColumn('courseNumber').width = 16;
  sheet.getColumn('courseTitle').width = 42;
  sheet.getColumn('generalEducationTags').width = 26;
  sheet.getColumn('crosslistedCourses').width = 28;
  sheet.getColumn('classroomNeeds').width = 62;
  sheet.eachRow((row, number) => {
    if (number > 1) row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell(cell => { cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function serveExport(response, db, format) {
  const rows = exportRows(await loadSchedule(db));
  const content = format === 'xlsx' ? await xlsxBuffer(rows) : csvBuffer(rows);
  const type = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8';
  response.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="course-schedule.${format}"`, 'Content-Length': content.length, 'Cache-Control': 'no-store' });
  response.end(content);
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
      if (request.method === 'GET' && url.pathname === '/api/export.csv') return await serveExport(response, getDb(), 'csv');
      if (request.method === 'GET' && url.pathname === '/api/export.xlsx') return await serveExport(response, getDb(), 'xlsx');
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
