import type { Migration } from "workers-qb";

import { createCfAgentsStateMigration } from "./001_create_cf_agents_state";
import { createCfAgentsQueuesMigration } from "./002_create_cf_agents_queues";
import { createCfAgentsSchedulesMigration } from "./003_create_cf_agents_schedules";
import { createCfAgentsMcpServersMigration } from "./004_create_cf_agents_mcp_servers";
import { createCfAiChatAgentMessagesMigration } from "./005_create_cf_ai_chat_agent_messages";

export const migrations: Migration[] = [
  createCfAgentsStateMigration,
  createCfAgentsQueuesMigration,
  createCfAgentsSchedulesMigration,
  createCfAgentsMcpServersMigration,
  createCfAiChatAgentMessagesMigration
];
