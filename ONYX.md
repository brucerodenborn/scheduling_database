# Live Onyx application integration

Assume every workspace is building a production application backed by the user's database, including while working in preview. Implement complete data flows, persistence when requested, authorization, and usable failure handling. Only build a mock/demo when the user explicitly requests one.

Database-backed application features use live Onyx data by default. For example, a request to show `Symbols` means reading the existing `Symbols` table at application runtime. Inspect its actual schema and build the screen around those fields. Rows queried while developing are diagnostic samples, not application source data. Do not copy them into JavaScript arrays, static JSON, HTML, build output, seed migrations, or production fallback fixtures. Use mock data only when the user explicitly requests a mock/demo, or in isolated tests.

## Model structured data with typed entities

Store structured application state in explicit, typed Onyx attributes. Model nested
or repeating data with appropriate domain entities and relationships or stable parent
identifiers. Define indexes for the queries the application needs.

Do not serialize application state into JSON payloads inside an entity. This includes
JSON strings, opaque objects/maps, and catch-all `payload`, `data`, `metadata`,
`settings`, or `extras` attributes. Model settings, permissions and event details
explicitly. Renaming attributes, splitting blobs or changing their encoding does not
satisfy this rule. Convenience, flexibility and avoiding migrations are not exceptions.
JSON API transport and schema files do not justify storing application state as JSON.
Only an explicit user instruction to persist JSON overrides this default; an API
payload, an existing blob or avoiding field modeling does not imply that request.

Name entities for domain concepts, such as `Workspace`, `Invoice`, and `InvoiceLine`.
Do not use generic names or add redundant `Record`, `Entity`, `Row`, `Data`, `Object`,
or `Model` prefixes or suffixes. Use packages or import aliases for code naming
conflicts; every word in an entity name must add domain meaning.

For example, use `Invoice(invoiceId, customerId, status, issuedAt)` and
`InvoiceLine(invoiceLineId, invoiceId, productId, quantity, unitPrice)` with typed
attributes, instead of `InvoiceRecord(id, payload)` containing a serialized invoice.

Existing JSON blobs and generic names are legacy constraints, not patterns to copy.
Preserve unrelated entities and data. When the requested change replaces persisted
storage, migrate and verify affected values and references before retiring old
attributes or entities; a class or table rename alone is insufficient. Before
completing persistence work, review entity definitions and save/load paths for typed,
individually queryable application fields, meaningful names and no serialization blobs.

## Build the complete request path

The default architecture is browser → authenticated application API → Onyx SDK → the environment's bound database. Reuse the project's server or framework server routes. If the project is frontend-only, create the necessary server-side middle tier as part of the task without asking for separate approval to add application code. Wire it into development, build, start, and container configuration so the workspace preview and deployment run the complete application. Keep the configured application port and readiness route working.

In this starter, extend `server/app.mjs` and reuse the `db` initialized by `server/index.mjs` through `onyxConfiguration` in `server/config.mjs`. Browser code in `client/` calls same-origin application endpoints; it never imports the Onyx SDK or connects to Onyx with database credentials. In an imported project, implement the equivalent boundary using its existing framework.

Implement real loading, empty, and failure states, plus refresh and pagination/search when needed. Execute queries on application requests, not only during task execution, startup, or the frontend build. Database changes must appear on a subsequent fetch without regenerating or rebuilding the application. A deliberate runtime cache needs a refresh/invalidation policy. An unavailable database must produce an honest error state, never silently substitute a captured snapshot.

## Separate task inspection from application access

Workspace tasks default to the Onyx permissions the user's role allows; saved restrictions still apply.
Use `WorkspaceAPI(database_id="target-id")` to work with another accessible database in the same
organization, including a newly created or cloned database after it is ready. The attached database
is the default. This selection does not change application credentials, runtime bindings or the
bound environment's migration journal. Task queries support Onyx search, aggregations, subqueries,
and resolver paths. Web search is available for documentation and development research.

Workspace tasks can inspect permitted schema and data through the temporary Onyx Research gateway. When `schemaUpdates` is enabled in the trusted `research/security.md`, application tasks must apply schema changes needed for the requested software, including new and existing tables, attributes, indexes, resolvers and triggers. The grant authorizes publication in the same task; do not restrict it to additions or require another approval, manual import or separate migration conversation. Without the grant, report the missing permission and unapplied changes. Fetch the current schema, preserve unrelated definitions, validate the merged candidate, publish through the scoped gateway and verify that the schema is applied before reporting success. Its `ONYX_DATABASE_BASE_URL`, SDK credential aliases, and task capability are for authorized task operations only and expire when the task ends. Read the trusted task context's `research/schema.md`, `research/security.md`, and installed SDK documentation before querying. Research analysis/report instructions describe the tools; the deliverable here is working application code.

Never copy the task's gateway URL, database ID, token, or environment values into application code or configuration. Do not reuse a task capability as the application's authentication mechanism. Generating server code that reads runtime configuration does not require access to production credentials during the task.

Preview and deployed application servers receive their own environment bindings at runtime:

| Setting | Purpose |
| --- | --- |
| `ONYX_BASE_URL` | Onyx API base URL; the starter defaults to `https://api.onyx.dev`. |
| `ONYX_DATABASE_ID` | The selected environment's bound database, injected by the runtime. |
| `ONYX_API_KEY`, `ONYX_API_SECRET` | Application credentials resolved from encrypted environment secrets. |

The workspace runtime supplies both `ONYX_BASE_URL` / `ONYX_API_KEY` / `ONYX_API_SECRET` and the official SDK names `ONYX_DATABASE_BASE_URL` / `ONYX_DATABASE_API_KEY` / `ONYX_DATABASE_API_SECRET`. Provisioned credentials are already bound to the environment; consume the injected values rather than asking the user to copy keys into project files. Managed credentials use the issuing control plane's public API endpoint, including the preview API when developing against that instance. Never assume the production API hostname is correct for every workspace. During a task the SDK aliases point to the inspection gateway instead, so do not evaluate them and write their values into the project. Use runtime variable references and placeholders only. Never place secrets in `VITE_*`, `NEXT_PUBLIC_*`, `PUBLIC_*`, frontend bundles, public configuration responses, logs, Git, Docker build arguments, or image layers. Keep SDK request/response logging disabled.

Starting an existing preview refreshes its container when its runtime environment has changed, including credentials, API URL, or database bindings. A successful query through the task gateway does not verify the preview: check the application's actual endpoint and report whether the live preview was verified. Diagnose a 401/403 by checking the bound API origin and credential injection before asking the user to recreate credentials. Never print secret values while diagnosing configuration.

Missing bindings do not justify hardcoding data or omitting the backend. Implement the integration, test it with isolated adapters, and report the exact missing environment setup and any live checks that could not run. Credential provisioning remains an explicit authorized workspace operation. Resolve compatibility requirements and complete needed schema work through the task's granted APIs before reporting completion. The AI database-change flow is optional for users who request a separate plan and apply process. Record writes and backfills require `mutations` separately; preserve unrelated definitions and data.

In the trusted task context, `application-runtime.json` identifies the selected application's API URL, database, environment, and whether application credential bindings are configured. It contains no secret values or references. Use it to distinguish missing bindings from incorrect application wiring. Its presence is not a live connectivity check, and its settings are not the inspection gateway's settings.

## Authorize each application endpoint

Authenticate callers on the server and enforce application authorization before querying. Preserve the project's verified Firebase identity and per-user/tenant ownership rules. Shared reference tables still need the intended application access policy; do not expose an arbitrary database/table/query proxy. Allowlist tables and fields, validate filters and pagination, and return only permitted data. Onyx application keys are database-scoped, so an SDK key alone does not authorize every application user to see every record.

For the starter's private workspace preview, preserve the existing server verification of runtime-injected preview identity. Never trust an unsigned browser-supplied user ID or enable a preview authentication bypass in deployed applications. Outside private preview, preserve/configure the application's real sign-in and authorization.

Inspect existing tables and discover exact table/column names and types. Reuse definitions that already satisfy the feature. When changes are needed, update the application schema contract and apply them through the granted task APIs. Keep database changes within the requested feature's scope and preserve unrelated entities and data.

## Verify the integration

Trace a browser request through the authenticated server handler to the actual SDK query. Add meaningful checks that a changed database response appears on a subsequent request, unauthorized callers cannot query data, and an empty result or connection failure is handled without snapshot fallback. Use synthetic fixtures only inside tests. Run the relevant tests and build; check the live application when its environment is available. Report which checks used adapters and which reached live Onyx, and state missing setup accurately.

## Cumulative migrations and script debugging

Read `MIGRATIONS.md` supplied with every database-bound application task. Its runner
uses the official SDK through the existing task gateway, so `schemaUpdates` and
`mutations` still apply independently. Record expansion, transformation, verification
and cleanup as immutable migration files; run them in the current authorized task and
ship them in the application image for other environments. Deployments and prompts
share durable database-scoped history, checksums, checkpoints and locking. No feature
environment variables or extra schema-publication approval are required.

`research/database-api.openapi.yaml` in trusted task context is the maintained product
API specification, including schema types. It is reference material, not a grant:
`WorkspaceAPI().catalog()` is authoritative for callable operations. Fetch the full
live schema with the schema grant to preserve resolver and trigger source. Inspect
installed SDK README/types for exact query/save/schema signatures. Use migration
syntax checks, read-only plans, journals and source locations to debug; for saved
Onyx scripts the existing `scripts.execute` returns success, logs and error locations.
