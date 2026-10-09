const { asc, gt } = ctx.sdk;
let { lastId = null, processed = 0 } = ctx.checkpoint ?? {};
for (;;) {
  let query = ctx.db.from('AcademicTerm').orderBy(asc('termId')).limit(100);
  if (lastId !== null) query = query.where(gt('termId', lastId));
  const terms = await query.list();
  if (!terms.length) break;
  for (const term of terms) {
    const normalized = term.name.toLocaleLowerCase('en-US');
    const year = term.name.match(/\b(20\d{2})\b/)?.[1];
    let defaults = null;
    if (year && normalized.includes('fall')) defaults = { startDate: `${year}-08-15T00:00:00.000Z`, endDate: `${year}-12-15T00:00:00.000Z` };
    else if (year && (normalized.includes('centre term') || normalized.includes('center term'))) defaults = { startDate: `${year}-01-01T00:00:00.000Z`, endDate: `${year}-01-28T00:00:00.000Z` };
    else if (year && normalized.includes('spring')) defaults = { startDate: `${year}-02-01T00:00:00.000Z`, endDate: `${year}-05-15T00:00:00.000Z` };
    if (defaults && (!term.startDate || !term.endDate)) {
      await ctx.db.save('AcademicTerm', { ...term, startDate: term.startDate || defaults.startDate, endDate: term.endDate || defaults.endDate });
    }
    lastId = term.termId;
    processed++;
  }
  await ctx.saveCheckpoint({ lastId, processed });
  ctx.progress(processed);
}
