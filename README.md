# Blank Canvas

Run `npm ci` and `npm run dev`, then open port 3000. Readiness is `/health/ready`.
Use `npm run build`, `npm start`, and `npm test` to verify and run the application.
This canvas has no example business logic or schema migrations.

A database can be selected during creation or attached later in Workspaces → Environments.
Provisioned credentials are injected into the server; never copy keys into project files.
`server/database.mjs` provides a lazy, server-only official Onyx SDK client. Use it from
authenticated, authorized routes when adding database features. Read `ONYX.md` first.
Missing bindings raise a setup error; no data is cached or substituted. The canvas itself
does not query a database or imply that its connection has been verified.

If `WORKSPACE_TYPE.md` is present, workspace setup uses your connected AI account or configured Onyx model to
build that specialized starter before opening preview. Follow its task progress in
Workspaces. If account access fails, reconnect your AI account and retry setup. Review
generated migrations and external service requirements before enabling those features.
