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
const xlsxHeaders = [
  'Course\nNumber', 'Section', 'Days', 'Time', 'Instructor(s)',
  'Specific Room\nPreference\n(this is not guaranteed)', 'Change if\ntotal seats ≠ 30',
  'Course Title (32 Characters or less - including spaces)\nAbbreviate if necessary',
  'General Education Tags\n(E1, E2, E3, A, R, C, D, S)',
  'Crosslisted?\nIf so, please provide\ncourse code(s)',
  'False limits\nduring registration?\n(see below)**',
  'Please provide precisely what you NEED\nyour classroom to contain',
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

const optionalBoolean = value => {
  if (value === '' || value === null || value === undefined) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw Object.assign(new Error('Please check the registration limits selection.'), { status: 400 });
};

const calendarDate = (value, label) => {
  const result = clean(value, 10, false);
  if (!result) return null;
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw Object.assign(new Error(`Choose a valid ${label}.`), { status: 400 });
  }
  return parsed.toISOString();
};

const defaultTermDates = name => {
  const normalized = name.toLocaleLowerCase('en-US');
  const statedYear = name.match(/\b(20\d{2})\b/)?.[1];
  const now = new Date();
  const academicStartYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const year = Number(statedYear || (normalized.includes('fall') ? academicStartYear : academicStartYear + 1));
  if (normalized.includes('fall')) return { startDate: `${year}-08-15`, endDate: `${year}-12-15` };
  if (normalized.includes('centre term') || normalized.includes('center term')) return { startDate: `${year}-01-01`, endDate: `${year}-01-28` };
  if (normalized.includes('spring')) return { startDate: `${year}-02-01`, endDate: `${year}-05-15` };
  return null;
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
  const termName = clean(input.termName ?? input.term, 60, false);
  const termStartDate = calendarDate(input.termStartDate, 'term start date');
  const termEndDate = calendarDate(input.termEndDate, 'term end date');
  if (termName && Boolean(termStartDate) !== Boolean(termEndDate)) throw Object.assign(new Error('Enter both dates for the selected term.'), { status: 400 });
  if (!termName && (termStartDate || termEndDate)) throw Object.assign(new Error('Enter a term name for the selected dates.'), { status: 400 });
  if (termStartDate && termEndDate && termStartDate > termEndDate) throw Object.assign(new Error('The term end date must be on or after its start date.'), { status: 400 });
  return {
    name: clean(input.name, 80), code: clean(input.code, 20, false),
    instructor: clean(input.instructor, 80, false), room: clean(input.room, 40, false),
    section: clean(input.section, 30, false), department: clean(input.department, 60, false),
    termName, termStartDate, termEndDate,
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
  const [courses, meetings, terms] = await Promise.all([
    allRecords(db.from('Course')),
    allRecords(db.from('CourseMeeting')),
    allRecords(db.from('AcademicTerm')),
  ]);
  const termsById = new Map(terms.map(term => [term.termId, term]));
  const byId = new Map(courses.map(course => [course.courseId, { ...course, academicTerm: termsById.get(course.termId) || null }]));
  return meetings.map(meeting => ({ ...meeting, course: byId.get(meeting.courseId) }))
    .filter(item => item.course)
    .sort((a, b) => a.weekday - b.weekday || a.slotIndex - b.slotIndex);
}

async function ensureTerm(db, name, startDate, endDate) {
  if (!name) return null;
  const normalizedName = name.toLocaleLowerCase('en-US');
  const terms = await allRecords(db.from('AcademicTerm'));
  const existing = terms.find(term => term.normalizedName === normalizedName);
  if (existing) {
    const defaults = defaultTermDates(name);
    const effectiveStartDate = startDate || existing.startDate || (defaults ? calendarDate(defaults.startDate, 'term start date') : null);
    const effectiveEndDate = endDate || existing.endDate || (defaults ? calendarDate(defaults.endDate, 'term end date') : null);
    if (!effectiveStartDate || !effectiveEndDate) throw Object.assign(new Error('Enter both dates for the selected term.'), { status: 400 });
    if (existing.name !== name || existing.startDate !== effectiveStartDate || existing.endDate !== effectiveEndDate) {
      await db.save('AcademicTerm', { ...existing, name, startDate: effectiveStartDate, endDate: effectiveEndDate });
    }
    return existing.termId;
  }
  const defaults = defaultTermDates(name);
  const effectiveStartDate = startDate || (defaults ? calendarDate(defaults.startDate, 'term start date') : null);
  const effectiveEndDate = endDate || (defaults ? calendarDate(defaults.endDate, 'term end date') : null);
  if (!effectiveStartDate || !effectiveEndDate) throw Object.assign(new Error('Enter both dates for the selected term.'), { status: 400 });
  const termId = randomUUID();
  await db.save('AcademicTerm', { termId, name, normalizedName, startDate: effectiveStartDate, endDate: effectiveEndDate, createdAt: new Date().toISOString() });
  return termId;
}

const courseFields = (value, termId) => ({
  name: value.name, code: value.code, instructor: value.instructor, color: value.color,
  section: value.section, department: value.department, termId, deliveryMode: value.deliveryMode,
  creditHours: value.creditHours, enrollment: value.enrollment, capacity: value.capacity, notes: value.notes,
  specificRoomPreference: value.specificRoomPreference, seatCountIfNotThirty: value.seatCountIfNotThirty,
  generalEducationTags: value.generalEducationTags, crosslistedCourses: value.crosslistedCourses,
  falseLimitsDuringRegistration: value.falseLimitsDuringRegistration, classroomNeeds: value.classroomNeeds,
});

async function saveNew(db, input) {
  const value = validateCourse(input);
  const now = new Date().toISOString();
  const courseId = randomUUID();
  const termId = await ensureTerm(db, value.termName, value.termStartDate, value.termEndDate);
  const records = value.weekdays.map(weekday => ({ meetingId: randomUUID(), courseId, weekday,
    slotIndex: value.slot.slotIndex, startMinutes: value.slot.startMinutes, endMinutes: value.slot.endMinutes,
    room: value.room, createdAt: now }));
  await db.save('Course', { courseId, ...courseFields(value, termId), createdAt: now });
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
  const termId = await ensureTerm(db, value.termName, value.termStartDate, value.termEndDate);
  const byWeekday = new Map(courseMeetings.map(item => [item.weekday, item]));
  const now = new Date().toISOString();
  const records = value.weekdays.map(weekday => {
    const previous = byWeekday.get(weekday);
    return { meetingId: previous?.meetingId || randomUUID(), courseId: existing.courseId, weekday,
      slotIndex: value.slot.slotIndex, startMinutes: value.slot.startMinutes, endMinutes: value.slot.endMinutes,
      room: value.room, createdAt: previous?.createdAt || now };
  });
  await db.save('CourseMeeting', records);
  await db.save('Course', { courseId: existing.courseId, ...courseFields(value, termId), createdAt: existing.course.createdAt });
  const retained = new Set(records.map(record => record.meetingId));
  for (const meeting of courseMeetings) if (!retained.has(meeting.meetingId)) await db.delete('CourseMeeting', meeting.meetingId);
}

const datePart = value => typeof value === 'string' ? value.slice(0, 10) : '';

async function instructorLoadReport(db, requestedStartDate, requestedEndDate) {
  const [courses, terms] = await Promise.all([
    allRecords(db.from('Course')),
    allRecords(db.from('AcademicTerm')),
  ]);
  const datedTerms = terms.filter(term => datePart(term.startDate) && datePart(term.endDate));
  let startDate = requestedStartDate ? datePart(calendarDate(requestedStartDate, 'report start date')) : '';
  let endDate = requestedEndDate ? datePart(calendarDate(requestedEndDate, 'report end date')) : '';
  if ((startDate && !endDate) || (!startDate && endDate)) throw Object.assign(new Error('Choose both report dates.'), { status: 400 });
  if (startDate && startDate > endDate) throw Object.assign(new Error('The report end date must be on or after its start date.'), { status: 400 });
  if (!startDate) {
    const today = new Date().toISOString().slice(0, 10);
    const current = datedTerms.find(term => datePart(term.startDate) <= today && datePart(term.endDate) >= today)
      || [...datedTerms].sort((a, b) => datePart(b.startDate).localeCompare(datePart(a.startDate)))[0];
    startDate = current ? datePart(current.startDate) : '';
    endDate = current ? datePart(current.endDate) : '';
  }
  const selectedTerms = datedTerms.filter(term => datePart(term.startDate) <= endDate && datePart(term.endDate) >= startDate);
  const selectedTermIds = new Set(selectedTerms.map(term => term.termId));
  const instructors = new Map();
  for (const course of courses) {
    if (!course.termId || !course.instructor?.trim() || !selectedTermIds.has(course.termId)) continue;
    const term = selectedTerms.find(item => item.termId === course.termId);
    const instructorName = course.instructor.trim();
    const instructor = instructors.get(instructorName) || { name: instructorName, totalCreditHours: 0, courses: [] };
    const creditHours = Number.isFinite(course.creditHours) ? course.creditHours : 0;
    instructor.totalCreditHours = Math.round((instructor.totalCreditHours + creditHours) * 100) / 100;
    instructor.courses.push({ courseId: course.courseId, code: course.code, section: course.section, name: course.name, creditHours, termName: term.name });
    instructors.set(instructorName, instructor);
  }
  const requiredCreditHours = 18 * selectedTerms.length;
  return {
    requiredCreditHours,
    range: { startDate, endDate },
    includedTerms: selectedTerms.map(term => ({ termId: term.termId, name: term.name, startDate: term.startDate, endDate: term.endDate }))
      .sort((a, b) => datePart(a.startDate).localeCompare(datePart(b.startDate))),
    instructors: [...instructors.values()].map(instructor => ({
      ...instructor,
      remainingCreditHours: Math.max(0, Math.round((requiredCreditHours - instructor.totalCreditHours) * 100) / 100),
      requirementMet: instructor.totalCreditHours >= requiredCreditHours,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  };
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
    classroomNeeds: item.course.classroomNeeds || '', department: item.course.department || '',
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

const shortTermName = name => name.replace(/\b(20)(\d{2})\b/, '$2');

async function xlsxBuffer(rows, term) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Course Schedule';
  workbook.subject = `${term.name} course offerings`;
  workbook.created = new Date();
  workbook.modified = new Date();
  const sheet = workbook.addWorksheet('Course Schedule', {
    views: [{ state: 'frozen', ySplit: 7, activeCell: 'A8', showGridLines: false, zoomScale: 70 }],
    pageSetup: {
      orientation: 'landscape', paperSize: 1, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, printTitlesRow: '7:7',
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.1, footer: 0.1 },
    },
  });
  sheet.properties.defaultRowHeight = 15;
  sheet.columns = [
    ['courseNumber', 15], ['section', 8], ['days', 9], ['time', 18], ['instructors', 22],
    ['specificRoomPreference', 36], ['seatCountIfNotThirty', 18], ['courseTitle', 46],
    ['generalEducationTags', 25], ['crosslistedCourses', 27], ['falseLimitsDuringRegistration', 24],
    ['classroomNeeds', 58],
  ].map(([key, width]) => ({ key, width }));

  sheet.mergeCells('A1:H1');
  sheet.mergeCells('I1:L1');
  sheet.getCell('A1').value = 'COURSE OFFERINGS FOR (FALL, CENTRETERM, SPRING)';
  sheet.getCell('I1').value = shortTermName(term.name);
  for (const cell of [sheet.getCell('A1'), sheet.getCell('I1')]) {
    cell.font = { name: 'Arial', size: 11, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  sheet.getRow(1).height = 20;

  const departments = [...new Set(rows.map(row => row.department).filter(Boolean))];
  const program = departments.length === 1 ? departments[0] : '';
  for (const [rowNumber, label, value] of [[3, 'PROGRAM:', program], [4, 'PROGRAM CHAIR:', ''], [5, 'DIVISION CHAIR:', '']]) {
    sheet.getCell(`A${rowNumber}`).value = label;
    sheet.getCell(`A${rowNumber}`).font = { name: 'Arial', size: 10, bold: true };
    sheet.mergeCells(`B${rowNumber}:D${rowNumber}`);
    const valueCell = sheet.getCell(`B${rowNumber}`);
    valueCell.value = spreadsheetText(value);
    valueCell.font = { name: 'Arial', size: 10 };
    valueCell.border = { bottom: { style: 'medium', color: { argb: 'FF000000' } } };
    valueCell.alignment = { vertical: 'bottom' };
  }

  const headerRowNumber = 7;
  const header = sheet.getRow(headerRowNumber);
  header.values = xlsxHeaders;
  header.height = 60;
  header.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FF000000' } };
  header.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

  const thinBorder = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'thin', color: { argb: 'FF000000' } },
    bottom: { style: 'thin', color: { argb: 'FF000000' } },
    right: { style: 'thin', color: { argb: 'FF000000' } },
  };
  header.eachCell({ includeEmpty: true }, cell => { cell.border = thinBorder; });
  for (const column of [2, 3, 7, 9, 11, 12]) header.getCell(column).alignment = { horizontal: 'center', vertical: 'top', wrapText: true };

  for (const exported of rows) {
    const values = exportColumns.map(([, key]) => typeof exported[key] === 'string' ? spreadsheetText(exported[key]) : exported[key]);
    const row = sheet.addRow(values);
    row.font = { name: 'Arial', size: 9 };
    row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell({ includeEmpty: true }, cell => { cell.border = thinBorder; });
    for (const column of [2, 3, 7, 9, 11]) row.getCell(column).alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
    const longestText = Math.max(String(exported.courseTitle).length / 44, String(exported.classroomNeeds).length / 56,
      String(exported.specificRoomPreference).length / 34, 1);
    row.height = Math.max(15, Math.min(60, Math.ceil(longestText) * 15));
  }

  const lastTableRow = Math.max(headerRowNumber, headerRowNumber + rows.length);
  for (let rowNumber = headerRowNumber; rowNumber <= lastTableRow; rowNumber++) {
    sheet.getCell(`A${rowNumber}`).border = { ...sheet.getCell(`A${rowNumber}`).border, left: { style: 'medium', color: { argb: 'FF000000' } } };
    sheet.getCell(`L${rowNumber}`).border = { ...sheet.getCell(`L${rowNumber}`).border, right: { style: 'medium', color: { argb: 'FF000000' } } };
  }
  for (let column = 1; column <= exportColumns.length; column++) {
    const topCell = header.getCell(column);
    topCell.border = { ...topCell.border, top: { style: 'medium', color: { argb: 'FF000000' } } };
    const bottomCell = sheet.getRow(lastTableRow).getCell(column);
    bottomCell.border = { ...bottomCell.border, bottom: { style: 'medium', color: { argb: 'FF000000' } } };
  }

  const addRowsNumber = lastTableRow + 1;
  sheet.mergeCells(`A${addRowsNumber}:C${addRowsNumber}`);
  sheet.getCell(`A${addRowsNumber}`).value = '(add rows as needed)';
  sheet.getCell(`A${addRowsNumber}`).font = { name: 'Arial', size: 9 };
  sheet.getCell(`A${addRowsNumber}`).alignment = { horizontal: 'center' };
  const noteRowNumber = addRowsNumber + 2;
  sheet.mergeCells(`A${noteRowNumber}:L${noteRowNumber}`);
  sheet.getCell(`A${noteRowNumber}`).value = '** If you indicate that you want our office to maintain false limits for your course, we will reach out to you directly to clarify how you want the seats to be distributed during registration.';
  sheet.getCell(`A${noteRowNumber}`).font = { name: 'Arial', size: 9, bold: true };
  sheet.getCell(`A${noteRowNumber}`).alignment = { vertical: 'top', wrapText: true };
  sheet.getRow(noteRowNumber).height = 30;

  sheet.headerFooter.oddFooter = '&L&8Course offerings&C&8' + shortTermName(term.name) + '&R&8Page &P of &N';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function serveExport(response, db, format, termId) {
  if (!termId) throw Object.assign(new Error('Choose a term before exporting.'), { status: 400 });
  const [schedule, terms] = await Promise.all([loadSchedule(db), allRecords(db.from('AcademicTerm'))]);
  const term = terms.find(item => item.termId === termId);
  if (!term) throw Object.assign(new Error('The selected term was not found.'), { status: 404 });
  const rows = exportRows(schedule.filter(item => item.course.termId === termId));
  const content = format === 'xlsx' ? await xlsxBuffer(rows, term) : csvBuffer(rows);
  const type = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8';
  const slug = term.name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'term';
  response.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="course-schedule-${slug}.${format}"`, 'Content-Length': content.length, 'Cache-Control': 'no-store' });
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
      if (request.method === 'GET' && url.pathname === '/api/schedule') {
        const [schedule, terms] = await Promise.all([loadSchedule(getDb()), allRecords(getDb().from('AcademicTerm'))]);
        return json(response, 200, { schedule, slots, terms: terms.sort((a, b) => b.name.localeCompare(a.name)) });
      }
      if (request.method === 'GET' && url.pathname === '/api/reports/instructor-load') return json(response, 200,
        await instructorLoadReport(getDb(), url.searchParams.get('startDate'), url.searchParams.get('endDate')));
      if (request.method === 'GET' && url.pathname === '/api/export.csv') return await serveExport(response, getDb(), 'csv', url.searchParams.get('termId'));
      if (request.method === 'GET' && url.pathname === '/api/export.xlsx') return await serveExport(response, getDb(), 'xlsx', url.searchParams.get('termId'));
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
