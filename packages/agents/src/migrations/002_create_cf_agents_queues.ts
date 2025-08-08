export const createCfAgentsQueuesMigration = {
  name: "002_create_cf_agents_queues",
  sql: `
        CREATE TABLE IF NOT EXISTS cf_agents_queues (
            id TEXT PRIMARY KEY NOT NULL,
            payload TEXT,
            callback TEXT,
            created_at INTEGER DEFAULT (unixepoch())
        );
`
};
