export const createCfAgentsSchedulesMigration = {
  name: "003_create_cf_agents_schedules",
  sql: `
        CREATE TABLE IF NOT EXISTS cf_agents_schedules (
            id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
            callback TEXT,
            payload TEXT,
            type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
            time INTEGER,
            delayInSeconds INTEGER,
            cron TEXT,
            created_at INTEGER DEFAULT (unixepoch())
        );
    `
};
