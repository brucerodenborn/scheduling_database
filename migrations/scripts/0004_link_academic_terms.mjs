const { asc, gt } = ctx.sdk;
let { lastId = null, processed = 0 } = ctx.checkpoint ?? {};
for (;;) {
  let query = ctx.db.from('Course').orderBy(asc('courseId')).limit(100);
  if (lastId !== null) query = query.where(gt('courseId', lastId));
  const courses = await query.list();
  if (!courses.length) break;
  for (const course of courses) {
    const name = typeof course.term === 'string' ? course.term.trim().replace(/\s+/g, ' ') : '';
    if (name && !course.termId) {
      const normalizedName = name.toLocaleLowerCase('en-US');
      const termId = `legacy-${Buffer.from(normalizedName, 'utf8').toString('base64url')}`;
      await ctx.db.save('AcademicTerm', { termId, name, normalizedName, createdAt: '1970-01-01T00:00:00.000Z' });
      await ctx.db.save('Course', { ...course, termId });
    }
    lastId = course.courseId;
    processed++;
  }
  await ctx.saveCheckpoint({ lastId, processed });
  ctx.progress(processed);
}
