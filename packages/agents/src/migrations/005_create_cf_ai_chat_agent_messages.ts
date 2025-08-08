export const createCfAiChatAgentMessagesMigration = {
  name: "005_create_cf_ai_chat_agent_messages",
  sql: `
        CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (
            id TEXT PRIMARY KEY NOT NULL,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT current_timestamp
        );
    `
};
