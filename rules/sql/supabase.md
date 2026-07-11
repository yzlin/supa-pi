# Supabase Migrations

- Do not use `CREATE INDEX CONCURRENTLY` in Supabase migrations. The Supabase CLI may pipeline multi-statement migrations, making invalid-index cleanup followed by concurrent index creation unsafe.
- Use `CREATE INDEX` instead.
