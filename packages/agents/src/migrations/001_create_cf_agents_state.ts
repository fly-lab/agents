export const createCfAgentsStateMigration = {
  name: "001_create_cf_agents_state",
  sql: `
        CREATE TABLE IF NOT EXISTS cf_agents_state (
            id TEXT PRIMARY KEY NOT NULL,
            state TEXT
        );
    `
};
