# MySQL schema steps

One file per schema or data change, run only by `npm run migrate`. The factory never applies a step
when it opens the database: `dev`, `worker`, `controller`, `status`, `ui` and `golden add` refuse to
start while steps are pending, and `doctor` reports them as a FAIL line.

```
npm run migrate -- --status    # current state and the pending steps
npm run migrate -- --dry-run   # SQL of each pending .sql step, rows each pending .ts step would change
npm run migrate                # back up first; applies the pending steps in number order
```

## File format

- `NNNN-<name>.sql` or `NNNN-<name>.ts`: four digits, a dash, lowercase letters, digits and dashes.
- Numbers are contiguous. The first step file is `0012`: states 1 to 11 are the frozen baseline in
  `src/impl/store/mysql/schema.ts`, which only builds an empty database. An existing database is only
  stamped 11.
- Step `NNNN` moves the state (the one row of `schema_state`) from `NNNN-1` to `NNNN`. `npm run migrate`
  refuses, and changes nothing, when the recorded state is not the starting state of the next step.
- `.sql`: statements separated by a `;` at the end of a line (a `;` inside a line does not split).
  Lines starting with `--` are comments.
- `.ts`: a data step. Default export `{ plan(db), apply(db) }` (types in `../step.d.ts`):
  `plan` returns the rows `apply` would change (for `--dry-run`; runs in a READ ONLY transaction),
  `apply` changes them (one transaction together with the state update). `npm run build` compiles it
  to `dist/migrations/mysql/` (`tsconfig.migrations.json`).

## Rules

- Never edit or rename a step that has shipped. Add a new one.
- Never reuse or skip a number. Two pull requests that both add `0012` conflict on purpose: the
  second one renumbers. `tests/migration-steps.test.ts` fails on a duplicate, a gap or a bad name.
- MySQL DDL commits on its own, so a `.sql` step is not atomic. If it fails midway, the state stays at
  the previous number and the next run starts the step again. Write steps that are safe to rerun, or
  keep one statement per step.
