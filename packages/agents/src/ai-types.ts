import type { Message as ChatMessage } from "ai";

import type { Agent } from ".";

/**
 * Types of messages sent from the Agent to clients
 */
export type OutgoingMessage =
  | {
      /** Indicates this message contains updated chat messages */
      type: "cf_agent_chat_messages";
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates this message is a response to a chat request */
      type: "cf_agent_use_chat_response";
      /** Unique ID of the request this response corresponds to */
      id: string;
      /** Content body of the response */
      body: string;
      /** Whether this is the final chunk of the response */
      done: boolean;
    }
  | {
      /** Indicates this message contains updated chat messages */
      type: "cf_agent_chat_messages";
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates this message is a command to clear chat history */
      type: "cf_agent_chat_clear";
    };

/**
 * Types of messages sent from clients to the Agent
 */
export type IncomingMessage =
  | {
      /** Indicates this message is a request to the chat API */
      type: "cf_agent_use_chat_request";
      /** Unique ID for this request */
      id: string;
      /** Request initialization options */
      init: Pick<
        RequestInit,
        | "method"
        | "keepalive"
        | "headers"
        | "body"
        | "redirect"
        | "integrity"
        | "credentials"
        | "mode"
        | "referrer"
        | "referrerPolicy"
        | "window"
      >;
    }
  | {
      /** Indicates this message is a command to clear chat history */
      type: "cf_agent_chat_clear";
    }
  | {
      /** Indicates this message contains updated chat messages */
      type: "cf_agent_chat_messages";
      /** Array of chat messages */
      messages: ChatMessage[];
    }
  | {
      /** Indicates the user wants to stop generation of this message */
      type: "cf_agent_chat_request_cancel";
      id: string;
    };

export type AgentState<State = unknown> = {
  id: string;
  state: State;
};

export type AgentQueue<T = unknown> = {
  id: string;
  payload: T;
  callback: keyof Agent<unknown>;
  created_at: number;
};

export type AgentSchedule<T = unknown> = {
  id: string;
  callback: keyof Agent<unknown>;
  payload: T;
  type: "scheduled" | "delayed" | "cron";
  time: number;
  delayInSeconds: number;
  cron: string;
  created_at: number;
};

export type AgentMcpServer = {
  id: string;
  name: string;
  server_url: string;
  callback_url: string;
  client_id: string | null;
  auth_url: string | null;
  server_options: string;
};

export type AIChatAgentMessage = {
  id: string;
  message: string;
  created_at: number;
};
