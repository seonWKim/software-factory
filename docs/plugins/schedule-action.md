# ScheduleAction

What it does: runs a fired schedule occurrence (design [08-schedules.md](../design/08-schedules.md)). A schedule is a stored record with a cadence; the controller's `schedule` unit claims each due occurrence once, on the controller's tick and at the tick's time, and hands each fired one to the selected action.

The interface (`src/interfaces/schedule-action.ts`) has one call, `run(schedule, occurrence_at)`: the schedule record and the slot the occurrence was due for (not the time it was claimed). It must be safe to run twice for the same occurrence: a crash after the claim and before the run ended may hand it over again. A throw is logged as `schedule action failed`, and the schedule's run still ends, so its next occurrence fires.

**Config.** The key is `plugins.schedule_action`, one ScheduleAction plugin name:

```jsonc
"plugins": { "schedule_action": "<name>" }   // run each fired occurrence with that plugin
```

**No default.** The kind is optional and no plugin is its default: a descriptor with a `default` field fails startup. With `plugins.schedule_action` left out (or `"none"`), no action is selected, and the `schedule` unit claims nothing: a due occurrence stays unclaimed, with no run row, until an action is selected. With no schedules stored, a tick changes nothing and the factory starts as before. A name no plugin has fails startup with an error that names `ScheduleAction`, `plugins.schedule_action` and the available names.

A plugin's context is the base context. Compose builds the selected plugin once, through the registry, and binds it to the store's claim pass (`scheduledAction`, `src/core/controller-deps.ts`).

**Adding an action.** Put a `<name>.plugin.ts` descriptor beside the implementation (`export default definePlugin({ kind: "schedule_action", name: "<name>", create: () => ... })`, `src/plugin-api.ts`); the registry discovers it with no loader change. Do not mark it `default`.

Plugins: none yet. No ScheduleAction plugin exists: the owner has not named the action a schedule runs.

**Switch back:** remove `schedule_action` from `plugins`; due occurrences are then left unclaimed.
