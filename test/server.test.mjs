import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import ExcelJS from 'exceljs';
import { createApplication } from '../server/index.mjs';
import { database } from '../server/database.mjs';

const secret = 'a-private-preview-secret-that-is-long-enough';
const env = { WORKSPACE_PREVIEW: 'true', WORKSPACE_PREVIEW_AUTH_SECRET: secret };
const token = createHmac('sha256', secret).update('course-scheduler-preview').digest('base64url');

function fakeDatabase() {
  const tables = { Course: [], CourseMeeting: [], AcademicTerm: [] };
  return {
    tables,
    from(table) {
      return { limit() { return this; }, async list() { return [...tables[table]]; } };
    },
    async save(table, row) {
      if (Array.isArray(row)) return Promise.all(row.map(item => this.save(table, item)));
      const key = table === 'Course' ? 'courseId' : table === 'CourseMeeting' ? 'meetingId' : 'termId';
      const index = tables[table].findIndex(item => item[key] === row[key]);
      const saved = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
      if (index >= 0) tables[table][index] = saved; else tables[table].push(saved);
      return saved;
    },
    async delete(table, id) {
      const key = table === 'Course' ? 'courseId' : table === 'CourseMeeting' ? 'meetingId' : 'termId';
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
const course = { name: 'Biology', code: 'BIO 101', section: '02', department: 'Science', instructor: 'Dr. Rivera', room: '204', color: 'sage', weekday: 1, slotIndex: 0,
  termName: 'Fall 2026', deliveryMode: 'In person', creditHours: 4, enrollment: 18, capacity: 24, notes: 'Bring lab materials.',
  specificRoomPreference: 'Science 210', seatCountIfNotThirty: 24, generalEducationTags: 'E1, A', crosslistedCourses: 'BIO 201', falseLimitsDuringRegistration: true,
  classroomNeeds: 'Movable tables and a demonstration bench. The room must contain a projector and sink.' };

test('serves the scheduler, assets and readiness', async () => withServer(async ({ origin }) => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const markup = await page.text();
  assert.match(markup, /Weekly schedule/);
  assert.ok(markup.indexOf('Monday–Wednesday–Friday') < markup.indexOf('Tuesday–Thursday'));
  assert.ok(markup.indexOf('Tuesday–Thursday') < markup.indexOf('<optgroup label="Single day">'));
  assert.doesNotMatch(markup, /Also repeat on/);
  assert.match(markup, /Course records/);
  assert.match(markup, /Instructor load/);
  assert.match(markup, /Export XLSX/);
  assert.match(markup, /Specific room preference/);
  assert.match(markup, /Classroom needs/);
  assert.match(markup, /Term starts/);
  assert.match(markup, /Term ends/);
  assert.match(markup, /id="records-term"/);
  assert.match(markup, /id="report-start-date"/);
  assert.match(markup, /id="report-end-date"/);
  assert.match(markup, /\/app\.js\?v=10/);
  const script = await fetch(`${origin}/app.js?v=10`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('cache-control'), 'no-store');
  const source = await script.text();
  assert.doesNotMatch(source, /\bconfirm\(/);
  assert.match(source, /Confirm delete everywhere/);
  assert.match(source, /add-to-slot/);
  assert.match(source, /Centre Term/);
  assert.match(source, /08-15/);
  assert.match(source, /01-28/);
  assert.match(source, /05-15/);
  assert.equal((await fetch(`${origin}/styles.css?v=10`)).status, 200);
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
  assert.equal(db.tables.Course[0].section, '02');
  assert.equal(db.tables.Course[0].creditHours, 4);
  assert.equal(db.tables.AcademicTerm.length, 1);
  assert.equal(db.tables.AcademicTerm[0].name, 'Fall 2026');
  assert.equal(db.tables.AcademicTerm[0].startDate, '2026-08-15T00:00:00.000Z');
  assert.equal(db.tables.AcademicTerm[0].endDate, '2026-12-15T00:00:00.000Z');
  assert.equal(db.tables.Course[0].termId, db.tables.AcademicTerm[0].termId);
  assert.equal(db.tables.Course[0].specificRoomPreference, 'Science 210');
  assert.equal(db.tables.Course[0].falseLimitsDuringRegistration, true);
  assert.match(db.tables.Course[0].classroomNeeds, /demonstration bench/);
  assert.deepEqual(db.tables.CourseMeeting.map(item => item.weekday), [1, 3, 5]);
  assert.ok(db.tables.CourseMeeting.every(item => item.courseId === db.tables.Course[0].courseId));
  assert.ok(db.tables.CourseMeeting.every(item => item.startMinutes === 480 && item.endMinutes === 540));

  const list = await (await fetch(`${origin}/api/schedule`, { headers: headers(origin) })).json();
  assert.equal(list.schedule[0].course.name, 'Biology');
  assert.equal(list.schedule[0].course.academicTerm.name, 'Fall 2026');
  assert.equal(list.terms[0].name, 'Fall 2026');
  assert.equal(list.schedule.length, 3);
  assert.equal(list.slots.length, 7);

  const overlapping = await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Chemistry', weekday: 2, weekdays: [2, 3] }) });
  assert.equal(overlapping.status, 201);
  const { meetingIds: overlappingMeetingIds } = await overlapping.json();
  assert.equal(overlappingMeetingIds.length, 2);
  assert.equal(db.tables.Course.length, 2);
  assert.equal(db.tables.CourseMeeting.filter(item => item.weekday === 3 && item.slotIndex === 0).length, 2);

  const updated = await fetch(`${origin}/api/schedule/${meetingIds[0]}`, { method: 'PATCH', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Advanced Biology', weekday: 2, weekdays: [2, 4], slotIndex: 6 }) });
  assert.equal(updated.status, 200);
  assert.equal(db.tables.Course[0].name, 'Advanced Biology');
  const biologyMeetings = db.tables.CourseMeeting.filter(item => item.courseId === db.tables.Course[0].courseId);
  assert.deepEqual(biologyMeetings.map(item => item.weekday).sort(), [2, 4]);
  assert.ok(biologyMeetings.every(item => item.startMinutes === 900));

  const deleted = await fetch(`${origin}/api/schedule/${biologyMeetings[0].meetingId}`, { method: 'DELETE', headers: headers(origin) });
  assert.equal(deleted.status, 200);
  assert.equal(db.tables.Course.length, 1);
  assert.equal(db.tables.CourseMeeting.length, 2);
  assert.equal(db.tables.Course[0].name, 'Chemistry');
}));

test('defaults Fall, Centre and Spring dates while preserving editable overrides', async () => withServer(async ({ origin, db }) => {
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, termName: 'Centre Term 2027', weekdays: [1] }) });
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, termName: 'Spring 2027', weekdays: [2] }) });
  let centre = db.tables.AcademicTerm.find(term => term.name === 'Centre Term 2027');
  const spring = db.tables.AcademicTerm.find(term => term.name === 'Spring 2027');
  assert.equal(centre.startDate, '2027-01-01T00:00:00.000Z');
  assert.equal(centre.endDate, '2027-01-28T00:00:00.000Z');
  assert.equal(spring.startDate, '2027-02-01T00:00:00.000Z');
  assert.equal(spring.endDate, '2027-05-15T00:00:00.000Z');

  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Centre Seminar', termName: 'Centre Term 2027', termStartDate: '2027-01-02', termEndDate: '2027-01-27', weekdays: [3] }) });
  centre = db.tables.AcademicTerm.find(term => term.name === 'Centre Term 2027');
  assert.equal(centre.startDate, '2027-01-02T00:00:00.000Z');
  assert.equal(centre.endDate, '2027-01-27T00:00:00.000Z');
}));

test('reports current-term and multi-term instructor credit-hour totals', async () => withServer(async ({ origin }) => {
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, weekdays: [1, 3], creditHours: 4 }) });
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Research Seminar', code: 'BIO 490', weekdays: [2], creditHours: 14 }) });
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Spring Biology', code: 'BIO 102', termName: 'Spring 2027', weekdays: [4], creditHours: 3 }) });

  const response = await fetch(`${origin}/api/reports/instructor-load`, { headers: headers(origin) });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.requiredCreditHours, 18);
  assert.deepEqual(report.includedTerms.map(term => term.name), ['Fall 2026']);
  assert.equal(report.instructors[0].name, 'Dr. Rivera');
  assert.equal(report.instructors[0].courses.length, 2);
  assert.equal(report.instructors[0].totalCreditHours, 18);
  assert.equal(report.instructors[0].remainingCreditHours, 0);
  assert.equal(report.instructors[0].requirementMet, true);

  const rangeResponse = await fetch(`${origin}/api/reports/instructor-load?startDate=2026-08-01&endDate=2027-05-31`, { headers: headers(origin) });
  assert.equal(rangeResponse.status, 200);
  const range = await rangeResponse.json();
  assert.equal(range.requiredCreditHours, 36);
  assert.deepEqual(range.includedTerms.map(term => term.name), ['Fall 2026', 'Spring 2027']);
  assert.equal(range.instructors[0].totalCreditHours, 21);
  assert.equal(range.instructors[0].remainingCreditHours, 15);
  assert.equal(range.instructors[0].requirementMet, false);
  assert.deepEqual([...new Set(range.instructors[0].courses.map(item => item.termName))], ['Fall 2026', 'Spring 2027']);
}));

test('exports one spreadsheet-style row per course as CSV and XLSX', async () => withServer(async ({ origin }) => {
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, weekdays: [1, 3] }) });
  await fetch(`${origin}/api/schedule`, { method: 'POST', headers: headers(origin), body: JSON.stringify({ ...course, name: 'Spring Biology', code: 'BIO 102', termName: 'Spring 2027', weekdays: [4] }) });
  assert.equal((await fetch(`${origin}/api/export.csv`, { headers: headers(origin) })).status, 400);
  const listed = await (await fetch(`${origin}/api/schedule`, { headers: headers(origin) })).json();
  const fallTermId = listed.terms.find(term => term.name === 'Fall 2026').termId;
  const csvResponse = await fetch(`${origin}/api/export.csv?termId=${fallTermId}`, { headers: headers(origin) });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(csvResponse.headers.get('content-disposition'), /course-schedule-fall-2026\.csv/);
  const csv = await csvResponse.text();
  assert.match(csv, /"Course Number","Section","Days","Time","Instructor\(s\)","Specific Room Preference"/);
  assert.match(csv, /"BIO 101","02","MW","8:00 AM - 9:00 AM","Dr. Rivera","Science 210","24","Biology","E1, A","BIO 201","Yes"/);
  assert.doesNotMatch(csv, /BIO 102/);

  const xlsxResponse = await fetch(`${origin}/api/export.xlsx?termId=${fallTermId}`, { headers: headers(origin) });
  assert.equal(xlsxResponse.status, 200);
  assert.match(xlsxResponse.headers.get('content-type'), /spreadsheetml/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await xlsxResponse.arrayBuffer()));
  const sheet = workbook.getWorksheet('Course Schedule');
  assert.equal(sheet.getCell('A1').value, 'COURSE OFFERINGS FOR (FALL, CENTRETERM, SPRING)');
  assert.equal(sheet.getCell('I1').value, 'Fall 26');
  assert.equal(sheet.getCell('A3').value, 'PROGRAM:');
  assert.equal(sheet.getCell('B3').value, 'Science');
  assert.equal(sheet.getCell('A7').value, 'Course\nNumber');
  assert.match(sheet.getCell('F7').value, /not guaranteed/);
  assert.equal(sheet.getCell('A8').value, 'BIO 101');
  assert.equal(sheet.getCell('C8').value, 'MW');
  assert.equal(sheet.getCell('F8').value, 'Science 210');
  assert.equal(sheet.getCell('G8').value, 24);
  assert.equal(sheet.getCell('K8').value, 'Yes');
  assert.match(sheet.getCell('L8').value, /projector and sink/);
  assert.equal(sheet.views[0].ySplit, 7);
  assert.equal(sheet.pageSetup.orientation, 'landscape');
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.getColumn('F').width, 36);
  assert.equal(sheet.getRow(7).height, 60);
  assert.equal(sheet.getCell('A7').border.top.style, 'medium');
  assert.match(sheet.getCell('A11').value, /false limits/);
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
