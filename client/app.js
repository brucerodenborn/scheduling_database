const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const fallbackSlots = [480, 550, 620, 690, 760, 830, 900].map((startMinutes, slotIndex) => ({ slotIndex, startMinutes, endMinutes: startMinutes + 60 }));
const palette = ['sage', 'blue', 'violet', 'amber', 'rose', 'teal'];
const token = document.querySelector('meta[name="auth-token"]').content;
const authReady = document.querySelector('meta[name="auth-ready"]').content === 'true';
const grid = document.querySelector('#schedule-grid');
const message = document.querySelector('#message');
const dialog = document.querySelector('#course-dialog');
const form = document.querySelector('#course-form');
const formError = document.querySelector('#form-error');
const deleteButton = document.querySelector('#delete-course');
const recordsBody = document.querySelector('#records-body');
const recordsMessage = document.querySelector('#records-message');
const reportBody = document.querySelector('#report-body');
const reportMessage = document.querySelector('#report-message');
const recordsTerm = document.querySelector('#records-term');
const reportStartDate = document.querySelector('#report-start-date');
const reportEndDate = document.querySelector('#report-end-date');
let schedule = [];
let slots = fallbackSlots;
let terms = [];
let reportData = null;
let requiredCreditHours = 18;

const formatTime = minutes => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  .format(new Date(Date.UTC(2020, 0, 1, 0, minutes)));
const slotLabel = slot => `${formatTime(slot.startMinutes)}–${formatTime(slot.endMinutes)}`;

function academicYearTerms() {
  const now = new Date();
  const academicStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return [`Fall ${academicStartYear}`, `Centre Term ${academicStartYear + 1}`, `Spring ${academicStartYear + 1}`];
}

function defaultTermDates(name, allowInferredYear = true) {
  const normalized = name.trim().toLocaleLowerCase('en-US');
  const statedYear = name.match(/\b(20\d{2})\b/)?.[1];
  if (!statedYear && !allowInferredYear) return null;
  const now = new Date();
  const academicStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const year = Number(statedYear || (normalized.includes('fall') ? academicStartYear : academicStartYear + 1));
  if (normalized.includes('fall')) return { startDate: `${year}-08-15`, endDate: `${year}-12-15` };
  if (normalized.includes('centre term') || normalized.includes('center term')) return { startDate: `${year}-01-01`, endDate: `${year}-01-28` };
  if (normalized.includes('spring')) return { startDate: `${year}-02-01`, endDate: `${year}-05-15` };
  return null;
}

function populateTermDates(allowInferredYear = true) {
  const name = form.elements.termName.value.trim();
  const selected = terms.find(term => term.normalizedName === name.toLocaleLowerCase('en-US'));
  const defaults = defaultTermDates(name, allowInferredYear);
  form.elements.termStartDate.value = selected?.startDate?.slice(0, 10) || defaults?.startDate || '';
  form.elements.termEndDate.value = selected?.endDate?.slice(0, 10) || defaults?.endDate || '';
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Something went wrong.');
  return payload;
}

function showMessage(text = '') {
  message.textContent = text;
  message.classList.toggle('hidden', !text);
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function render() {
  grid.replaceChildren();
  grid.append(make('div', 'grid-head', 'Time'));
  days.forEach(day => grid.append(make('div', 'grid-head', day)));
  for (const slot of slots) {
    const time = make('div', 'time-cell');
    time.append(make('strong', '', formatTime(slot.startMinutes)), make('span', '', `to ${formatTime(slot.endMinutes)}`));
    grid.append(time);
    for (let weekday = 1; weekday <= 5; weekday++) {
      const cell = make('div', 'slot-cell');
      const items = schedule.filter(entry => entry.weekday === weekday && entry.slotIndex === slot.slotIndex);
      for (const item of items) {
        const card = make('button', `course-card ${item.course.color}`);
        card.type = 'button';
        card.setAttribute('aria-label', `Edit ${item.course.name}, ${days[weekday - 1]} ${slotLabel(slot)}`);
        if (item.course.code) card.append(make('span', 'code', item.course.code));
        card.append(make('strong', '', item.course.name));
        const detail = [item.course.instructor, item.room].filter(Boolean).join(' · ');
        if (detail) card.append(make('span', 'detail', detail));
        card.addEventListener('click', () => openDialog(item));
        cell.append(card);
      }
      const add = make('button', items.length ? 'add-to-slot' : 'empty-slot', items.length ? '+ Add another' : '+ Add');
      add.type = 'button';
      add.setAttribute('aria-label', `Add course on ${days[weekday - 1]} at ${formatTime(slot.startMinutes)}`);
      add.addEventListener('click', () => openDialog(null, weekday, slot.slotIndex));
      cell.append(add);
      grid.append(cell);
    }
  }
  document.querySelector('#class-count').textContent = new Set(schedule.map(item => item.courseId)).size;
  document.querySelector('#hour-count').textContent = schedule.length;
}

function renderRecords() {
  const selectedTermId = recordsTerm.value;
  const visibleSchedule = selectedTermId ? schedule.filter(item => item.course.termId === selectedTermId) : schedule;
  document.querySelector('#records-title').textContent = terms.find(term => term.termId === selectedTermId)?.name || 'All scheduled courses';
  const courses = [...new Map(visibleSchedule.map(item => [item.courseId, item])).values()]
    .sort((a, b) => (a.course.code || a.course.name).localeCompare(b.course.code || b.course.name));
  recordsBody.replaceChildren();
  document.querySelector('#records-count').textContent = `${courses.length} ${courses.length === 1 ? 'record' : 'records'}`;
  if (!courses.length) {
    const row = document.createElement('tr');
    const cell = make('td', 'empty-records', 'No courses have been scheduled.');
    cell.colSpan = 7; row.append(cell); recordsBody.append(row); return;
  }
  for (const item of courses) {
    const meetings = visibleSchedule.filter(entry => entry.courseId === item.courseId).sort((a, b) => a.weekday - b.weekday);
    const row = document.createElement('tr');
    const courseCell = document.createElement('td');
    courseCell.append(make('strong', '', [item.course.code, item.course.section].filter(Boolean).join(' · ') || item.course.name));
    if (item.course.code || item.course.section) courseCell.append(make('span', '', item.course.name));
    const scheduleCell = document.createElement('td');
    scheduleCell.append(make('strong', '', meetings.map(meeting => days[meeting.weekday - 1].slice(0, 3)).join(', ')));
    scheduleCell.append(make('span', '', `${formatTime(item.startMinutes)}–${formatTime(item.endMinutes)} · ${item.room || 'No room'}`));
    const instructor = make('td', '', item.course.instructor || '—');
    const term = make('td', '', item.course.academicTerm?.name || '—');
    const delivery = make('td', '', item.course.deliveryMode || '—');
    const enrolled = item.course.enrollment ?? '';
    const capacity = item.course.capacity ?? '';
    const enrollment = make('td', '', enrolled === '' && capacity === '' ? '—' : [enrolled || '0', capacity].filter(value => value !== '').join(' / '));
    const actionCell = document.createElement('td');
    const edit = make('button', 'table-action', 'View details');
    edit.type = 'button'; edit.addEventListener('click', () => openDialog(item)); actionCell.append(edit);
    row.append(courseCell, scheduleCell, instructor, term, delivery, enrollment, actionCell);
    recordsBody.append(row);
  }
}

function renderReport() {
  reportBody.replaceChildren();
  if (!reportData?.includedTerms.length) {
    const row = document.createElement('tr'); const cell = make('td', 'empty-records', 'No dated terms overlap this range. Add term dates in a course record.');
    cell.colSpan = 5; row.append(cell); reportBody.append(row);
    document.querySelector('#load-count').textContent = '0 instructors'; return;
  }
  const title = reportData.includedTerms.length === 1 ? reportData.includedTerms[0].name : `${reportData.includedTerms.length} terms`;
  document.querySelector('#load-title').textContent = title;
  document.querySelector('#load-count').textContent = `${reportData.instructors.length} ${reportData.instructors.length === 1 ? 'instructor' : 'instructors'}`;
  if (!reportData.instructors.length) {
    const row = document.createElement('tr'); const cell = make('td', 'empty-records', 'No instructor hours are assigned to this term.');
    cell.colSpan = 5; row.append(cell); reportBody.append(row); return;
  }
  for (const instructor of reportData.instructors) {
    const row = document.createElement('tr');
    row.append(make('td', 'instructor-name', instructor.name));
    const coursesCell = document.createElement('td');
    for (const course of instructor.courses) coursesCell.append(make('span', 'load-course', `${[course.code, course.section].filter(Boolean).join(' · ') || course.name} · ${course.termName} · ${course.creditHours} hr`));
    const total = make('td', 'load-total', `${instructor.totalCreditHours} / ${requiredCreditHours}`);
    const remaining = make('td', instructor.requirementMet ? 'requirement-met' : 'requirement-open', instructor.requirementMet ? 'Met' : `${instructor.remainingCreditHours} hr`);
    const progressCell = document.createElement('td');
    const track = make('div', 'progress-track'); const bar = make('span', instructor.requirementMet ? 'progress-bar met' : 'progress-bar');
    bar.style.width = `${Math.min(100, (instructor.totalCreditHours / requiredCreditHours) * 100)}%`;
    track.setAttribute('aria-label', `${instructor.totalCreditHours} of ${requiredCreditHours} credit hours`);
    track.append(bar); progressCell.append(track);
    row.append(coursesCell, total, remaining, progressCell); reportBody.append(row);
  }
}

function setTermOptions() {
  const names = [...new Set([...terms.map(term => term.name), ...academicYearTerms()])];
  document.querySelector('#term-options').replaceChildren(...names.map(name => new Option(name)));
  const previous = recordsTerm.value;
  recordsTerm.replaceChildren(new Option('All terms', ''), ...terms.map(term => new Option(term.name, term.termId)));
  if (terms.some(term => term.termId === previous)) recordsTerm.value = previous;
  document.querySelectorAll('.export-button').forEach(button => { button.disabled = !recordsTerm.value; });
}

async function load() {
  showMessage();
  recordsMessage.textContent = '';
  recordsMessage.classList.add('hidden');
  reportMessage.textContent = '';
  reportMessage.classList.add('hidden');
  if (!authReady) {
    grid.replaceChildren(make('div', 'loading', 'Open this app from your authenticated workspace preview.'));
    recordsBody.replaceChildren();
    const row = document.createElement('tr'); const cell = make('td', 'empty-records', 'Open this app from your authenticated workspace preview.');
    cell.colSpan = 7; row.append(cell); recordsBody.append(row);
    reportBody.replaceChildren();
    const reportRow = document.createElement('tr'); const reportCell = make('td', 'empty-records', 'Open this app from your authenticated workspace preview.');
    reportCell.colSpan = 5; reportRow.append(reportCell); reportBody.append(reportRow);
    showMessage('Your workspace session is not available.');
    return;
  }
  try {
    const [result, loadReport] = await Promise.all([api('/api/schedule'), api('/api/reports/instructor-load')]);
    schedule = result.schedule; slots = result.slots; terms = result.terms;
    reportData = loadReport; requiredCreditHours = loadReport.requiredCreditHours;
    reportStartDate.value = loadReport.range.startDate || '';
    reportEndDate.value = loadReport.range.endDate || '';
    setTermOptions();
    render();
    renderRecords();
    renderReport();
  } catch (error) {
    grid.replaceChildren(make('div', 'loading', 'Schedule unavailable'));
    recordsBody.replaceChildren();
    const row = document.createElement('tr'); const cell = make('td', 'empty-records', 'Course records unavailable');
    cell.colSpan = 7; row.append(cell); recordsBody.append(row);
    showMessage(error.message);
    recordsMessage.textContent = error.message; recordsMessage.classList.remove('hidden');
    reportBody.replaceChildren();
    const reportRow = document.createElement('tr'); const reportCell = make('td', 'empty-records', 'Instructor load unavailable');
    reportCell.colSpan = 5; reportRow.append(reportCell); reportBody.append(reportRow);
    reportMessage.textContent = error.message; reportMessage.classList.remove('hidden');
  }
}

function setOptions() {
  const slotIndex = form.elements.slotIndex;
  slotIndex.replaceChildren(...slots.map(slot => new Option(slotLabel(slot), String(slot.slotIndex))));
  const colors = document.querySelector('#colors');
  colors.replaceChildren();
  palette.forEach((color, index) => {
    const label = make('label', 'color-choice');
    const input = document.createElement('input');
    input.type = 'radio'; input.name = 'color'; input.value = color; input.checked = index === 0;
    const dot = make('span', color); dot.title = color;
    label.append(input, dot); colors.append(label);
  });
}

async function loadReportRange() {
  if (!reportStartDate.value || !reportEndDate.value) return;
  reportMessage.textContent = '';
  reportMessage.classList.add('hidden');
  try {
    const query = new URLSearchParams({ startDate: reportStartDate.value, endDate: reportEndDate.value });
    reportData = await api(`/api/reports/instructor-load?${query}`);
    requiredCreditHours = reportData.requiredCreditHours;
    renderReport();
  } catch (error) {
    reportMessage.textContent = error.message; reportMessage.classList.remove('hidden');
  }
}

function setDaySchedule(selectedDays) {
  const weekday = form.elements.weekday;
  const weekdays = [...new Set(selectedDays)].sort((a, b) => a - b);
  const value = weekdays.join(',');
  const currentGroup = document.querySelector('#current-schedule-options');
  currentGroup.replaceChildren();
  currentGroup.hidden = true;
  if (![...weekday.options].some(option => option.value === value)) {
    currentGroup.append(new Option(weekdays.map(day => days[day - 1]).join('–'), value));
    currentGroup.hidden = false;
  }
  weekday.value = value;
}

function openDialog(item, weekday = 1, slotIndex = 0) {
  form.reset();
  formError.classList.add('hidden');
  formError.textContent = '';
  delete deleteButton.dataset.confirming;
  deleteButton.textContent = 'Delete course';
  deleteButton.disabled = false;
  form.elements.meetingId.value = item?.meetingId || '';
  form.elements.name.value = item?.course.name || '';
  form.elements.code.value = item?.course.code || '';
  form.elements.instructor.value = item?.course.instructor || '';
  form.elements.section.value = item?.course.section || '';
  form.elements.department.value = item?.course.department || '';
  const termName = item?.course.academicTerm?.name || '';
  const termDefaults = defaultTermDates(termName);
  form.elements.termName.value = termName;
  form.elements.termStartDate.value = item?.course.academicTerm?.startDate?.slice(0, 10) || termDefaults?.startDate || '';
  form.elements.termEndDate.value = item?.course.academicTerm?.endDate?.slice(0, 10) || termDefaults?.endDate || '';
  form.elements.deliveryMode.value = item?.course.deliveryMode || '';
  form.elements.creditHours.value = item?.course.creditHours ?? '';
  form.elements.enrollment.value = item?.course.enrollment ?? '';
  form.elements.capacity.value = item?.course.capacity ?? '';
  form.elements.notes.value = item?.course.notes || '';
  form.elements.specificRoomPreference.value = item?.course.specificRoomPreference || '';
  form.elements.seatCountIfNotThirty.value = item?.course.seatCountIfNotThirty ?? '';
  form.elements.generalEducationTags.value = item?.course.generalEducationTags || '';
  form.elements.crosslistedCourses.value = item?.course.crosslistedCourses || '';
  form.elements.falseLimitsDuringRegistration.value = item?.course.falseLimitsDuringRegistration == null ? '' : String(item.course.falseLimitsDuringRegistration);
  form.elements.classroomNeeds.value = item?.course.classroomNeeds || '';
  form.elements.room.value = item?.room || '';
  form.elements.slotIndex.value = String(item?.slotIndex ?? slotIndex);
  const selectedDays = item ? schedule.filter(entry => entry.courseId === item.courseId).map(entry => entry.weekday) : [weekday];
  setDaySchedule(selectedDays);
  const color = item?.course.color || 'sage';
  const colorInput = form.querySelector(`input[name="color"][value="${color}"]`);
  if (colorInput) colorInput.checked = true;
  document.querySelector('#dialog-title').textContent = item ? 'Edit course' : 'Add course';
  deleteButton.classList.toggle('hidden', !item);
  dialog.showModal();
  form.elements.name.focus();
}

function closeDialog() { if (dialog.open) dialog.close(); }

function formPayload() {
  const values = new FormData(form);
  const payload = Object.fromEntries(values.entries());
  payload.weekdays = payload.weekday.split(',').map(Number);
  payload.weekday = payload.weekdays[0];
  return payload;
}

function selectView(view) {
  for (const name of ['schedule', 'records', 'report']) {
    document.querySelector(`#${name}-view`).classList.toggle('hidden', view !== name);
    document.querySelector(`#show-${name}`).classList.toggle('active', view === name);
  }
}

async function download(format, button) {
  const termId = recordsTerm.value;
  if (!termId) {
    recordsMessage.textContent = 'Choose a term before exporting.'; recordsMessage.classList.remove('hidden'); return;
  }
  button.disabled = true;
  recordsMessage.classList.add('hidden');
  try {
    const response = await fetch(`/api/export.${format}?${new URLSearchParams({ termId })}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'The export could not be created.');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    const term = terms.find(item => item.termId === termId);
    const slug = term?.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'term';
    link.href = URL.createObjectURL(blob); link.download = `course-schedule-${slug}.${format}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    recordsMessage.textContent = error.message; recordsMessage.classList.remove('hidden');
  } finally { button.disabled = !recordsTerm.value; }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const meetingId = form.elements.meetingId.value;
  const save = document.querySelector('#save-course');
  save.disabled = true; formError.classList.add('hidden');
  try {
    await api(meetingId ? `/api/schedule/${meetingId}` : '/api/schedule', { method: meetingId ? 'PATCH' : 'POST', body: JSON.stringify(formPayload()) });
    closeDialog(); await load();
  } catch (error) {
    formError.textContent = error.message; formError.classList.remove('hidden');
  } finally { save.disabled = false; }
});

deleteButton.addEventListener('click', async () => {
  const meetingId = form.elements.meetingId.value;
  if (!meetingId) return;
  if (deleteButton.dataset.confirming !== 'true') {
    deleteButton.dataset.confirming = 'true';
    deleteButton.textContent = 'Confirm delete everywhere';
    return;
  }
  deleteButton.disabled = true;
  try { await api(`/api/schedule/${meetingId}`, { method: 'DELETE' }); closeDialog(); await load(); }
  catch (error) {
    formError.textContent = error.message; formError.classList.remove('hidden');
    delete deleteButton.dataset.confirming; deleteButton.textContent = 'Delete course';
  }
  finally { deleteButton.disabled = false; }
});

setOptions();
document.querySelector('#add-course').addEventListener('click', () => {
  const available = slots.flatMap(slot => days.map((_day, index) => ({ weekday: index + 1, slotIndex: slot.slotIndex })))
    .find(candidate => !schedule.some(item => item.weekday === candidate.weekday && item.slotIndex === candidate.slotIndex));
  openDialog(null, available?.weekday || 1, available?.slotIndex || 0);
});
document.querySelector('#refresh').addEventListener('click', load);
document.querySelector('#records-refresh').addEventListener('click', load);
document.querySelector('#report-refresh').addEventListener('click', loadReportRange);
document.querySelector('#show-schedule').addEventListener('click', () => selectView('schedule'));
document.querySelector('#show-records').addEventListener('click', () => selectView('records'));
document.querySelector('#show-report').addEventListener('click', () => selectView('report'));
recordsTerm.addEventListener('change', () => {
  renderRecords();
  recordsMessage.textContent = '';
  recordsMessage.classList.add('hidden');
  document.querySelectorAll('.export-button').forEach(button => { button.disabled = !recordsTerm.value; });
});
for (const input of [reportStartDate, reportEndDate]) input.addEventListener('change', loadReportRange);
form.elements.termName.addEventListener('input', () => populateTermDates(false));
form.elements.termName.addEventListener('change', () => populateTermDates(true));
document.querySelectorAll('.export-button').forEach(button => button.addEventListener('click', () => download(button.dataset.format, button)));
document.querySelector('#close-dialog').addEventListener('click', closeDialog);
document.querySelector('#cancel-dialog').addEventListener('click', closeDialog);
dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
load();
