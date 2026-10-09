const { asc, gt } = ctx.sdk;
const terms = new Map();
let lastTermId = null;
for (;;) {
  let query = ctx.db.from('AcademicTerm').orderBy(asc('termId')).limit(100);
  if (lastTermId !== null) query = query.where(gt('termId', lastTermId));
  const rows = await query.list();
  if (!rows.length) break;
  for (const term of rows) {
    if (!term.termId || !term.name || !term.normalizedName) return false;
    terms.set(term.termId, term);
    lastTermId = term.termId;
  }
}
let lastCourseId = null;
for (;;) {
  let query = ctx.db.from('Course').orderBy(asc('courseId')).limit(100);
  if (lastCourseId !== null) query = query.where(gt('courseId', lastCourseId));
  const courses = await query.list();
  if (!courses.length) break;
  for (const course of courses) {
    const legacyName = typeof course.term === 'string' ? course.term.trim().replace(/\s+/g, ' ') : '';
    if (course.termId && !terms.has(course.termId)) return false;
    if (legacyName) {
      const linked = terms.get(course.termId);
      if (!linked || linked.normalizedName !== legacyName.toLocaleLowerCase('en-US')) return false;
    }
    lastCourseId = course.courseId;
  }
}
return true;
