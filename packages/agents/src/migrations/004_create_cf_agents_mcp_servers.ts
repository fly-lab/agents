export const createCfAgentsMcpServersMigration = {
  name: "004_create_cf_agents_mcp_servers",
  sql: `
          CREATE TABLE IF NOT EXISTS cf_agents_mcp_servers (
              id TEXT PRIMARY KEY NOT NULL,
              name TEXT NOT NULL,
              server_url TEXT NOT NULL,
              callback_url TEXT NOT NULL,
              client_id TEXT,
              auth_url TEXT,
              server_options TEXT
          );
      `
};
