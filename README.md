# Course Schedule

A database-backed weekly course scheduler with seven one-hour class blocks from 8:00 AM to 4:00 PM and a 10-minute break between classes.

## Run

```bash
npm ci
npm run dev
```

Open port 3000. Readiness is available at `/health/ready`.

The application uses the Onyx database credentials injected by the workspace runtime. Apply the versioned database schema with `npm run migrate`; validate migration files with `npm run migrate:check`.

## Verify

```bash
npm run build
npm test
npm start
```
