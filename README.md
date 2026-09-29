# Tillflow POS

POS for Ireland: cloud, offline-capable point of sale for Irish retail shops, cafes and restaurants.
See [docs/PLAN.md](docs/PLAN.md) for the build plan and architecture.

## Getting started

```bash
pnpm install
pnpm supabase start      # local Postgres + Auth (needs Docker)
cp .env.example .env.local   # then fill in values (local ones come from `pnpm supabase status`)
pnpm dev
```

Run `pnpm verify` (lint, typecheck, test, build) before every commit.