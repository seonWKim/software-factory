// What each store table Runtime owns holds, one line each, and what a column means where its name does not say
// (key `table.column`). Read by the Data page (src/ui/data.ts, design 09-dashboard-app); checked by
// tests/data-table-docs.test.ts.

export const TABLE_DOCS: Readonly<Record<string, string>> = {
  runtime_child_restarts: "Restarts of the factory's child processes, and why.",
  runtime_config_file_changes: "Changes to factory.config.json made from the Settings page, and the branch each went on.",
  runtime_hook_decisions: "What each enabled hook decided at each point it ran.",
  runtime_learned_setting_changes: "Settings the factory changed by itself from its runs, with the evidence.",
  runtime_learned_settings: "The current value of each setting the factory learned.",
  runtime_schema_migrations: "Timestamped schema migrations applied to this store, and when.",
  runtime_settings_changes: "Every runtime setting set or reset: old value, new value and who.",
  runtime_settings_overrides: "Runtime settings set over factory.config.json, per project.",
};
