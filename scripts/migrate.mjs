// Shared by prompted tasks and immutable deployment images. No application imports.
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const collections = ['attributes', 'indexes', 'resolvers', 'triggers'];
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const entities = schema => {
  // SDK 2.8.x supplies entities:[] when the scoped gateway returns tables.
  // Prefer the actual gateway definitions; never interpret that default as empty data.
  if (Array.isArray(schema.tables)) {
    assert(!schema.entities?.length || equal(schema.entities, schema.tables), 'Conflicting schema arrays; inspect the raw live schema before publication.');
    return schema.tables;
  }
  assert(Array.isArray(schema.entities), 'Schema response is missing entity definitions.');
  return schema.entities;
};
const equal = (a, b) => canonical(a) === canonical(b);
const subset = (expected, actual) => expected && typeof expected === 'object'
  ? actual != null && Object.entries(expected).every(([key, value]) => subset(value, actual[key])) : equal(expected, actual);
function assert(condition, message) { if (!condition) throw new Error(message); }
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// Merge named members, never replace whole entities or implicitly remove unknown code.
export function mergeSchema(remote, patch = {}, { cleanup = false } = {}) {
  assert(!patch.tables, 'Migration patches use entities, not tables.');
  assert(!patch.remove?.length || cleanup, 'Removals belong in cleanup after verification.');
  const result = { entities: structuredClone(entities(remote)), revisionDescription: patch.revisionDescription ?? 'Workspace migration' };
  for (const change of patch.entities ?? []) {
    assert(change.name, 'Every entity needs a name.');
    let target = result.entities.find(table => table.name === change.name);
    if (!target) { result.entities.push(structuredClone(change)); continue; }
    for (const [key, value] of Object.entries(change)) {
      if (collections.includes(key)) {
        target[key] ??= [];
        for (const member of value) {
          const previous = target[key].find(item => item.name === member.name);
          if (previous) {
            assert(cleanup || subset(member, previous), `Changing ${change.name}.${member.name} requires a verified cleanup phase; expand with a compatible field first.`);
            Object.assign(previous, structuredClone(member));
          } else {
            assert(cleanup || key !== 'attributes' || member.isNullable === true,
              `New field ${change.name}.${member.name} must be nullable during expansion of an existing table.`);
            target[key].push(structuredClone(member));
          }
        }
      } else {
        assert(cleanup || target[key] === undefined || subset(value, target[key]), `Changing ${change.name}.${key} requires cleanup.`);
        target[key] = structuredClone(value);
      }
    }
  }
  for (const removal of patch.remove ?? []) {
    const table = result.entities.find(item => item.name === removal.table);
    if (!table) continue;
    if (removal.entity === true) result.entities = result.entities.filter(item => item !== table);
    else for (const key of collections) {
      if (removal[key]) table[key] = (table[key] ?? []).filter(item => !removal[key].includes(item.name));
    }
  }
  return result;
}

export function compatible(required, actual, { allowNullable = false } = {}) {
  for (const expected of entities(required)) {
    const found = entities(actual).find(table => table.name === expected.name);
    if (!found) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (collections.includes(key)) {
        if (!value.every(member => (found[key] ?? []).some(item => {
          if (item.name !== member.name) return false;
          const requiredMember = allowNullable && key === 'attributes' && member.isNullable === false && item.isNullable === true
            ? Object.fromEntries(Object.entries(member).filter(([name]) => name !== 'isNullable')) : member;
          return subset(requiredMember, item);
        }))) return false;
      } else if (!subset(value, found[key])) return false;
    }
  }
  return true;
}

export async function loadPlan(root) {
  const config = await readJson(path.join(root, '.onyx/migrations.json'));
  assert(config.version === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(config.namespace), 'Invalid migration manifest version or namespace.');
  const directory = path.join(root, 'migrations');
  const names = (await fs.readdir(directory)).filter(name => /^\d{4,}_[a-z0-9_]+\.json$/.test(name)).sort((a, b) => BigInt(a.split('_')[0]) < BigInt(b.split('_')[0]) ? -1 : 1);
  const plan = [];
  for (const name of names) {
    const source = await fs.readFile(path.join(directory, name), 'utf8');
    const definition = JSON.parse(source);
    assert(definition.id === name.slice(0, -5), `Migration ID must match ${name}.`);
    assert(Object.keys(definition).every(key => ['id', 'expand', 'transform', 'verify', 'cleanup', 'resumable'].includes(key)), `Unsupported migration field in ${name}.`);
    assert(!(definition.transform || definition.cleanup) || definition.verify, `${name} needs a verification script.`);
    let contents = source;
    const scripts = {};
    for (const phase of ['transform', 'verify']) if (definition[phase]) {
      const relative = definition[phase];
      assert(typeof relative === 'string' && /^[a-zA-Z0-9_./-]+\.mjs$/.test(relative) && !relative.split('/').includes('..') && !path.isAbsolute(relative), 'Scripts must stay inside migrations/.');
      const file = await fs.realpath(path.join(directory, relative));
      assert(file.startsWith(await fs.realpath(directory) + path.sep), 'Migration script escapes its directory.');
      const script = await fs.readFile(file, 'utf8');
      contents += '\n' + relative + '\n' + script;
      // Function bodies are self-contained: all dependencies are supplied in context.
      scripts[phase] = new AsyncFunction('ctx', `'use strict';\n${script}\n//# sourceURL=migrations/${relative}`);
    }
    plan.push({ ...definition, checksum: hash(contents), scripts });
  }
  assert(new Set(plan.map(item => BigInt(item.id.split('_')[0]).toString())).size === plan.length, 'Migration sequence numbers must be unique.');
  return { config, plan };
}

export async function withLock(directory, owner, action) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'lock');
  if (owner) {
    assert((await readJson(path.join(lock, 'owner.json'))).owner === owner, 'Deployment migration lock is unavailable.');
    return action();
  }
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another migration owns this database lock. Inspect the active operation before recovering an interrupted lock.'); throw error; }
  try {
    await atomicJson(path.join(lock, 'owner.json'), { owner: randomUUID(), operationId: process.env.ONYX_MIGRATION_OPERATION_ID ?? null, pid: process.pid, startedAt: new Date().toISOString() });
    return await action();
  } finally { await fs.rm(lock, { recursive: true }); }
}

export async function runMigrations({ root, stateDirectory, db, sdk = {}, command = 'apply', resume, lockOwner, emit = () => {} }) {
  assert(['check', 'status', 'plan', 'compatible', 'prepare', 'finalize', 'apply'].includes(command), 'Unknown migration command.');
  const { config, plan } = await loadPlan(root);
  if (command === 'check') return { valid: true, migrations: plan.map(({ id, checksum }) => ({ id, checksum })) };
  assert(stateDirectory, 'Migration storage is unavailable. Run this through a database-bound workspace task or deployment.');
  const execute = async () => {
    const journalFile = path.join(stateDirectory, `${config.namespace}.json`);
    const journal = await readJson(journalFile, { version: 1, migrations: [] });
    assert(journal.version === 1 && Array.isArray(journal.migrations), 'Unsupported migration journal.');
    const save = () => atomicJson(journalFile, journal);
    for (const [index, recorded] of journal.migrations.entries()) {
      const candidate = plan[index];
      if (command === 'compatible' && !candidate) continue; // Rollback checks requirements; never migrates backwards.
      assert(candidate?.id === recorded.id && candidate.checksum === recorded.checksum, `Migration history changed at ${recorded.id}. Restore applied files and append a new migration.`);
    }
    if (command === 'status') return journal;
    if (command === 'plan') return { migrations: plan.map(item => ({ id: item.id, checksum: item.checksum,
      status: journal.migrations.find(row => row.id === item.id)?.status ?? 'pending',
      phases: ['expand', 'transform', 'verify', 'cleanup'].filter(phase => item[phase]) })) };
    const contract = await readJson(path.join(root, 'schema/onyx.schema.json'));
    if (command === 'compatible') {
      assert(compatible(contract, await db.getSchema()), 'Candidate application is incompatible with the live schema. Database changes are never rolled back with an image.');
      return { compatible: true };
    }
    function patchApplied(patch, actual) {
      return compatible({ entities: patch.entities ?? [] }, actual) && (patch.remove ?? []).every(removal => {
        const table = entities(actual).find(item => item.name === removal.table);
        return removal.entity ? !table : !table || collections.every(key => !(table[key] ?? []).some(item => removal[key]?.includes(item.name)));
      });
    }
    async function publish(patch, cleanup, record) {
      if (!patch) return;
      const before = await db.getSchema();
      const candidate = mergeSchema(before, patch, { cleanup });
      if (equal(entities(before), candidate.entities)) {
        try {
          for (const table of patch.entities ?? []) await db.from(table.name).limit(1).list();
          return; // Adopt an already active definition without republishing it.
        } catch (error) {
          if ([401, 403].includes(error.status ?? error.statusCode)) throw error;
          // A matching saved draft is not proof of activation; publish below.
        }
      }
      const validation = await db.validateSchema(candidate);
      assert(validation?.valid === true, 'Schema validation failed; nothing was published. Inspect the full schema and validation response through WorkspaceAPI.');
      assert(equal(entities(before), entities(await db.getSchema())), 'Live schema changed during validation. Inspect drift and resume.');
      record.publicationPending = { phase: cleanup ? 'cleanup' : 'expand', patchChecksum: hash(canonical(patch)) };
      await save();
      await db.updateSchema(candidate, { publish: true });
      // Schema publication can return while the database is still activating. Poll
      // reads, never retry the write implicitly. The journal retains an uncertain phase.
      const deadline = Date.now() + 90000;
      for (;;) {
        try {
          const applied = await db.getSchema();
          assert(compatible(candidate, applied) && patchApplied(patch, applied), 'Published schema did not activate as expected.');
          for (const table of patch.entities ?? []) await db.from(table.name).limit(1).list();
          break;
        } catch (error) {
          if (Date.now() >= deadline || [401, 403].includes(error.status ?? error.statusCode)) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    async function step(item, record, phase, work) {
      if (record.completed.includes(phase)) return;
      record.activePhase = phase; record.status = 'running'; await save();
      emit({ type: 'migration', id: item.id, phase, status: 'running' });
      try {
        await work();
        record.completed.push(phase); record.activePhase = null; delete record.publicationPending; await save();
        emit({ type: 'migration', id: item.id, phase, status: 'completed' });
      } catch (error) {
        record.status = 'failed'; await save();
        emit({ type: 'migration', id: item.id, phase, status: 'failed' });
        throw error;
      }
    }
    const records = [];
    // Expand and transform every pending version before any cleanup or candidate startup.
    for (const item of plan) {
      let record = journal.migrations.find(row => row.id === item.id);
      if (!record) {
        assert(command !== 'finalize', 'Prepare pending migrations before cleanup.');
        record = { id: item.id, checksum: item.checksum, status: 'pending', completed: [], checkpoint: null };
        journal.migrations.push(record); await save();
      }
      records.push([item, record]);
      if (record.status === 'completed') continue;
      if (record.status === 'failed' || record.status === 'running') {
        assert(resume === item.id && (record.activePhase !== 'transform' || item.resumable === true),
          `${item.id} has an incomplete ${record.activePhase} phase. Inspect live state; explicitly resume only after establishing that replay is safe.`);
      }
      const context = {
        db, sdk, get checkpoint() { return structuredClone(record.checkpoint); },
        saveCheckpoint: async value => {
          assert(Buffer.byteLength(JSON.stringify(value)) <= 65536, 'Checkpoint exceeds 64 KiB. Store cursors and counts, not records.');
          record.checkpoint = structuredClone(value); await save();
        },
        progress: count => {
          assert(Number.isSafeInteger(count) && count >= 0, 'Progress must be a nonnegative row count.');
          emit({ type: 'migration', id: item.id, phase: record.activePhase, processed: count });
        },
      };
      if (command !== 'finalize' && record.status !== 'prepared') {
        await step(item, record, 'expand', () => publish(item.expand, false, record));
        await step(item, record, 'transform', () => item.scripts.transform?.(context));
        await step(item, record, 'verify', async () => { if (item.scripts.verify) assert(await item.scripts.verify(context) === true, `${item.id} verification failed; cleanup was not run.`); });
        record.status = 'prepared'; await save();
      }
      if (command === 'finalize') assert(record.status === 'prepared' || resume === item.id, `${item.id} has not been prepared.`);
      records[records.length - 1].push(context);
    }
    if (command !== 'prepare') {
      for (const [item, record, context] of records) {
        if (record.status === 'completed') continue;
        // Verify again after old writers drain. A failed check never drops source data.
        await step(item, record, 'cleanup', async () => {
          const pending = record.publicationPending;
          const acknowledged = item.cleanup && pending?.phase === 'cleanup' && pending.patchChecksum === hash(canonical(item.cleanup)) && patchApplied(item.cleanup, await db.getSchema());
          // Verification completed before this recorded publish attempt. If acknowledgement
          // was lost after source fields were retired, inspect the applied target instead
          // of querying fields that no longer exist or repeating an uncertain publication.
          if (!acknowledged) {
            if (item.scripts.verify) assert(await item.scripts.verify(context) === true, `${item.id} verification failed before cleanup.`);
            await publish(item.cleanup, true, record);
          }
        });
        record.status = 'completed'; record.finishedAt = new Date().toISOString(); await save();
      }
    }
    const actual = await db.getSchema();
    let satisfies = compatible(contract, actual);
    if (!satisfies && command === 'prepare' && compatible(contract, actual, { allowNullable: true })) {
      // Verified non-null data can serve the candidate before its constraint tightens.
      // Other incompatibilities (including types/names) must already be resolved.
      let finalSchema = actual;
      for (const [item, record] of records) if (record.status !== 'completed' && item.cleanup)
        finalSchema = mergeSchema(finalSchema, item.cleanup, { cleanup: true });
      satisfies = compatible(contract, finalSchema);
    }
    assert(satisfies, 'Live schema does not satisfy the application contract. Add the missing migration.');
    return journal;
  };
  return ['status', 'plan', 'compatible'].includes(command) && !lockOwner ? execute() : withLock(stateDirectory, lockOwner, execute);
}

async function main() {
  const command = process.argv[2] ?? 'apply';
  const option = name => process.argv.slice(3).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
  const root = process.cwd();
  if (command === 'check') { emit(await runMigrations({ root, command })); return; }
  const env = process.env;
  const sdk = await import('@onyx.dev/onyx-database');
  const task = Boolean(env.ONYX_WORKSPACE_TASK_CAPABILITY && env.ONYX_RESEARCH_GATEWAY === env.ONYX_DATABASE_BASE_URL);
  const baseUrl = task ? env.ONYX_DATABASE_BASE_URL : env.ONYX_BASE_URL || env.ONYX_DATABASE_BASE_URL || 'https://api.onyx.dev';
  const apiKey = task ? env.ONYX_DATABASE_API_KEY : env.ONYX_MIGRATION_API_KEY;
  const apiSecret = task ? env.ONYX_DATABASE_API_SECRET : env.ONYX_MIGRATION_API_SECRET;
  assert(env.ONYX_DATABASE_ID && apiKey && apiSecret, 'Migration credentials are unavailable. Use Environment settings to provision database credentials.');
  const db = sdk.onyx.init({ baseUrl, databaseId: env.ONYX_DATABASE_ID, apiKey, apiSecret, wireFormat: 'json',
    retry: { enabled: false }, requestLoggingEnabled: false, responseLoggingEnabled: false,
    fetch: (url, options) => {
      const target = new URL(url), base = new URL(baseUrl);
      assert(target.origin === base.origin && target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') && !target.username && !target.password, 'Migration request escaped its bound API.');
      return fetch(url, { ...options, redirect: 'error' });
    } });
  emit(await runMigrations({ root, command, stateDirectory: env.ONYX_MIGRATION_STATE_DIR, db, sdk, emit,
    resume: option('resume'), lockOwner: option('lock-owner') }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  let message = String(error.message);
  for (const [key, value] of Object.entries(process.env)) if (/SECRET|TOKEN|KEY|CREDENTIAL|PASSWORD/.test(key) && value) message = message.split(value).join('[REDACTED]');
  const location = String(error.stack).match(/migrations\/[^\s)]+:\d+:\d+/)?.[0];
  process.stderr.write(JSON.stringify({ error: message, ...(location ? { location } : {}) }) + '\n');
  process.exitCode = 1;
});
