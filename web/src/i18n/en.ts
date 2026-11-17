// The English text of the app, keyed by name. `{name}` marks a value the caller fills in.
// One file per area under en/; a key's prefix (the part before its first dot) decides the file
// (tests/web-i18n-keys.test.ts).
import { shell } from "./en/shell.js";
import { tasks } from "./en/tasks.js";
import { work } from "./en/work.js";
import { health } from "./en/health.js";
import { data } from "./en/data.js";
import { rules } from "./en/rules.js";
import { settings } from "./en/settings.js";
import { plugins } from "./en/plugins.js";

export const en = { ...shell, ...tasks, ...work, ...health, ...data, ...rules, ...settings, ...plugins } as const;

export type MessageKey = keyof typeof en;
