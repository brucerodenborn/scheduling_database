const { asc, gt } = ctx.sdk;
let lastId = null;
for (;;) {
  let query = ctx.db.from('AcademicTerm').orderBy(asc('termId')).limit(100);
  if (lastId !== null) query = query.where(gt('termId', lastId));
  const terms = await query.list();
  if (!terms.length) break;
  for (const term of terms) {
    const normalized = term.name.toLocaleLowerCase('en-US');
    const knownTerm = /\b20\d{2}\b/.test(term.name) && (normalized.includes('fall') || normalized.includes('centre term') || normalized.includes('center term') || normalized.includes('spring'));
    if (knownTerm && (!term.startDate || !term.endDate)) return false;
    if (term.startDate && term.endDate && term.startDate > term.endDate) return false;
    lastId = term.termId;
  }
}
return true;
