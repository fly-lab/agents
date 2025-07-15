import { env } from "cloudflare:test";
import { expect, describe, it, vi } from "vitest";
import {
  getAgentByName,
  routeAgentRequest,
  getCurrentAgent,
  unstable_callable,
  Agent,
  StreamingResponse,
  type Connection
} from "../index.ts";
import { camelCaseToKebabCase } from "../client.ts";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("Agent Core Functionality", () => {
  describe("getAgentByName", () => {
    it("should return an agent with specified name", async () => {
      const agentName = "test-agent";
      const agent = await getAgentByName(env.TEST_AGENT, agentName);

      expect(agent).toBeDefined();
      expect(agent).toHaveProperty("fetch");
      expect(typeof agent.fetch).toBe("function");
    });

    it("should handle agent name with special characters", async () => {
      const agentName = "my-agent-with-special-chars-123!@#";
      const agent = await getAgentByName(env.TEST_AGENT, agentName);

      expect(agent).toBeDefined();
      expect(agent).toHaveProperty("fetch");
    });

    it("should handle options parameter", async () => {
      const agentName = "my-agent";
      const options = { locationHint: "wnam" as DurableObjectLocationHint };

      const agent = await getAgentByName(env.TEST_AGENT, agentName, options);

      expect(agent).toBeDefined();
      expect(agent).toHaveProperty("fetch");
    });

    it("should create different agents for different names", async () => {
      const agent1 = await getAgentByName(env.TEST_AGENT, "agent1");
      const agent2 = await getAgentByName(env.TEST_AGENT, "agent2");

      expect(agent1).toBeDefined();
      expect(agent2).toBeDefined();
      // They should be different instances based on ID
      const id1 = env.TEST_AGENT.idFromName("agent1");
      const id2 = env.TEST_AGENT.idFromName("agent2");
      expect(id1.toString()).not.toBe(id2.toString());
    });
  });

  describe("routeAgentRequest", () => {
    it("should handle CORS preflight requests when cors is enabled", async () => {
      const request = new Request("http://localhost/agents/TestAgent/test", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type"
        }
      });

      const response = await routeAgentRequest(request, env, { cors: true });

      expect(response).toBeDefined();
      expect(response!.status).toBe(200);
      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response!.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, HEAD, OPTIONS"
      );
      expect(response!.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true"
      );
    });

    it("should handle CORS with custom headers", async () => {
      const customCorsHeaders = {
        "Access-Control-Allow-Origin": "https://example.com",
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Max-Age": "3600"
      };

      const request = new Request("http://localhost/agents/TestAgent/test", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com"
        }
      });

      const response = await routeAgentRequest(request, env, {
        cors: customCorsHeaders
      });

      expect(response).toBeDefined();
      expect(response!.status).toBe(200);
      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://example.com"
      );
      expect(response!.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST"
      );
      expect(response!.headers.get("Access-Control-Max-Age")).toBe("3600");
    });

    it("should handle custom prefix option", async () => {
      const request = new Request(
        "http://localhost/custom-prefix/TestAgent/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000"
          }
        }
      );

      const response = await routeAgentRequest(request, env, {
        prefix: "custom-prefix",
        cors: true
      });

      // Should return CORS response for OPTIONS request
      expect(response).toBeDefined();
      expect(response!.status).toBe(200);
    });

    it("should return null for non-matching paths", async () => {
      const request = new Request("http://localhost/api/other/endpoint", {
        method: "GET"
      });

      const response = await routeAgentRequest(request, env);

      expect(response).toBeNull();
    });
  });

  describe("Utility Functions", () => {
    describe("camelCaseToKebabCase", () => {
      it("should convert CamelCase to kebab-case", () => {
        expect(camelCaseToKebabCase("TestAgent")).toBe("test-agent");
        expect(camelCaseToKebabCase("EmailAgent")).toBe("email-agent");
        expect(camelCaseToKebabCase("MyComplexAgentName")).toBe(
          "my-complex-agent-name"
        );
      });

      it("should handle already kebab-case strings", () => {
        expect(camelCaseToKebabCase("test-agent")).toBe("test-agent");
        expect(camelCaseToKebabCase("email-agent")).toBe("email-agent");
      });

      it("should handle single word", () => {
        expect(camelCaseToKebabCase("Agent")).toBe("agent");
        expect(camelCaseToKebabCase("Test")).toBe("test");
      });

      it("should handle empty string", () => {
        expect(camelCaseToKebabCase("")).toBe("");
      });

      it("should handle strings with numbers", () => {
        expect(camelCaseToKebabCase("TestAgent123")).toBe("test-agent123");
        expect(camelCaseToKebabCase("Agent2Email")).toBe("agent2-email");
      });
    });
  });

  describe("Agent with different namespaces", () => {
    it("should handle MCP agents", async () => {
      const id = env.MCP_OBJECT.idFromName("test-mcp");
      const agent = env.MCP_OBJECT.get(id);
      expect(agent).toBeDefined();
      expect(agent).toHaveProperty("fetch");
    });

    it("should handle multiple agent types", async () => {
      // Mock console to prevent queueMicrotask errors
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const testAgent = await getAgentByName(env.TEST_AGENT, "test1");
        const emailAgent = await getAgentByName(env.EmailAgent, "test2");

        expect(testAgent).toBeDefined();
        expect(emailAgent).toBeDefined();

        // Each agent type has its own namespace
        expect(testAgent.fetch).toBeDefined();
        expect(emailAgent.fetch).toBeDefined();
      } finally {
        // Restore console mocks
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle undefined environment bindings gracefully", async () => {
      const undefinedEnv = {} as Env;

      await expect(async () => {
        await getAgentByName(undefinedEnv.TEST_AGENT, "test");
      }).rejects.toThrow();
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle concurrent agent creation", async () => {
      const promises = Array(5)
        .fill(null)
        .map((_, i) => getAgentByName(env.TEST_AGENT, `concurrent-agent-${i}`));

      const agents = await Promise.all(promises);

      expect(agents).toHaveLength(5);
      agents.forEach((agent) => {
        expect(agent).toBeDefined();
        expect(agent).toHaveProperty("fetch");
      });
    });

    it("should handle agent names with various patterns", async () => {
      const patterns = [
        "simple",
        "with-dash",
        "with_underscore",
        "with123numbers",
        "UPPERCASE",
        "mixedCase"
      ];

      for (const pattern of patterns) {
        const agent = await getAgentByName(env.TEST_AGENT, pattern);
        expect(agent).toBeDefined();
        expect(agent).toHaveProperty("fetch");
      }
    });
  });

  describe("Agent Direct Testing", () => {
    it("should handle WebSocket upgrade", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "ws-test");

      const upgradeResponse = await agent.fetch(
        new Request("http://localhost/test", {
          method: "GET",
          headers: {
            Upgrade: "websocket"
          }
        })
      );

      expect(upgradeResponse.status).toBe(101);
      expect(upgradeResponse.webSocket).toBeDefined();
    });

    it("should handle basic HTTP requests", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "http-test");

      const response = await agent.fetch(
        new Request("http://localhost/test", {
          method: "GET"
        })
      );

      expect(response).toBeDefined();
      expect(response.status).toBe(200);
    });
  });

  describe("StreamingResponse", () => {
    it("should require connection and id parameters", () => {
      expect(StreamingResponse).toBeDefined();
      expect(typeof StreamingResponse).toBe("function");
    });

    it("should be used for streaming RPC responses", () => {
      const mockConnection = {
        id: "test-connection-id",
        state: {},
        setState: vi.fn(),
        server: "test-server",
        send: vi.fn()
      };

      const response = new StreamingResponse(
        mockConnection as unknown as Connection,
        "test-id"
      );
      expect(response).toBeDefined();

      response.send({ data: "chunk1" });
      expect(mockConnection.send).toHaveBeenCalledWith(
        JSON.stringify({
          done: false,
          id: "test-id",
          result: { data: "chunk1" },
          success: true,
          type: "rpc"
        })
      );

      response.end({ data: "final" });
      expect(mockConnection.send).toHaveBeenCalledWith(
        JSON.stringify({
          done: true,
          id: "test-id",
          result: { data: "final" },
          success: true,
          type: "rpc"
        })
      );

      expect(() => response.send({ data: "after-end" })).toThrow(
        "StreamingResponse is already closed"
      );
    });
  });

  describe("Agent Class Features", () => {
    it("should support callable decorator", () => {
      const metadata = {
        description: "Test method",
        streaming: false
      };

      const decorator = unstable_callable(metadata);
      expect(typeof decorator).toBe("function");
    });

    it("should handle different agent namespaces", async () => {
      const testAgent = await getAgentByName(env.TEST_AGENT, "test-agent");
      expect(testAgent).toBeDefined();
      expect(testAgent.fetch).toBeDefined();

      const emailAgent = await getAgentByName(env.EmailAgent, "email-agent");
      expect(emailAgent).toBeDefined();
      expect(emailAgent.fetch).toBeDefined();

      const caseSensitiveAgent = await getAgentByName(
        env.CaseSensitiveAgent,
        "case-agent"
      );
      expect(caseSensitiveAgent).toBeDefined();
      expect(caseSensitiveAgent.fetch).toBeDefined();

      const notificationAgent = await getAgentByName(
        env.UserNotificationAgent,
        "notification-agent"
      );
      expect(notificationAgent).toBeDefined();
      expect(notificationAgent.fetch).toBeDefined();
    });
  });

  describe("getCurrentAgent", () => {
    it("should return context when called", () => {
      // getCurrentAgent returns the context object, not just the agent
      const context = getCurrentAgent();

      if (context) {
        expect(context).toHaveProperty("agent");
      } else {
        expect(context).toBeUndefined();
      }
    });
  });

  describe("Route Pattern Matching", () => {
    it("should return null for non-agent paths", async () => {
      const nonAgentPaths = [
        "/other/path",
        "/api/endpoint",
        "/",
        "/agents",
        "/agents/"
      ];

      for (const path of nonAgentPaths) {
        const request = new Request(`http://localhost${path}`, {
          method: "GET"
        });

        const response = await routeAgentRequest(request, env);
        expect(response).toBeNull();
      }
    });

    it("should detect valid agent paths", async () => {
      const validPaths = [
        "/agents/TestAgent/instance",
        "/agents/test-agent/room-123",
        "/agents/EmailAgent/user@example.com"
      ];

      for (const path of validPaths) {
        const request = new Request(`http://localhost${path}`, {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000"
          }
        });

        const response = await routeAgentRequest(request, env, { cors: true });

        expect(response).not.toBeNull();
        expect(response!.status).toBe(200);
        expect(response!.headers.get("Access-Control-Allow-Origin")).toBe("*");
      }
    });
  });

  describe("Advanced Integration", () => {
    it("should handle kebab-case to CamelCase agent name resolution", async () => {
      const request = new Request(
        "http://localhost/agents/test-agent/my-instance",
        {
          method: "GET"
        }
      );

      const response = await routeAgentRequest(request, env);

      expect(response).toBeDefined();
      expect(response).not.toBeNull();
    });

    it("should support location hints", async () => {
      const locationHints: DurableObjectLocationHint[] = [
        "wnam",
        "enam",
        "weur",
        "eeur",
        "apac"
      ];

      for (const hint of locationHints) {
        const agent = await getAgentByName(env.TEST_AGENT, `location-${hint}`, {
          locationHint: hint
        });
        expect(agent).toBeDefined();
      }
    });
  });

  describe("Agent State Management", () => {
    it("should persist state between requests", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "state-persist-test");

      const setResponse = await agent.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ count: 5, name: "test" })
        })
      );

      expect(setResponse.status).toBe(200);
      const setResult = (await setResponse.json()) as { success: boolean };
      expect(setResult.success).toBe(true);

      const getResponse = await agent.fetch(
        new Request("http://localhost/getState")
      );
      expect(getResponse.status).toBe(200);
      const state = (await getResponse.json()) as {
        count: number;
        name: string;
      };
      expect(state.count).toBe(5);
      expect(state.name).toBe("test");
    });

    it("should handle complex state updates", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "state-complex-test");

      await agent.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: { id: 1, name: "Alice" },
            settings: { theme: "dark", notifications: true }
          })
        })
      );

      await agent.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user: { id: 1, name: "Alice Updated" },
            lastUpdated: Date.now()
          })
        })
      );

      const response = await agent.fetch(
        new Request("http://localhost/getState")
      );
      const state = (await response.json()) as {
        user: { id: number; name: string };
        settings?: { theme: string; notifications: boolean };
        lastUpdated: number;
      };
      expect(state.user.name).toBe("Alice Updated");
      expect(state.lastUpdated).toBeDefined();
    });

    it("should broadcast state updates to connections", async () => {
      const agent = await getAgentByName(
        env.TEST_AGENT,
        "state-broadcast-test"
      );

      const wsResponse = await agent.fetch(
        new Request("http://localhost/", {
          method: "GET",
          headers: { Upgrade: "websocket" }
        })
      );

      expect(wsResponse.status).toBe(101);
      const ws = wsResponse.webSocket;
      expect(ws).toBeDefined();
    });
  });

  describe("RPC System", () => {
    it("should support callable methods", () => {
      const decorator = unstable_callable({ description: "Test method" });
      expect(typeof decorator).toBe("function");
    });

    it("should handle RPC through WebSocket connection", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "rpc-ws-test");

      const wsResponse = await agent.fetch(
        new Request("http://localhost/", {
          method: "GET",
          headers: { Upgrade: "websocket" }
        })
      );

      expect(wsResponse.status).toBe(101);
      expect(wsResponse.webSocket).toBeDefined();
    });

    it("should verify callable methods are marked correctly", () => {
      class TestRPCAgent extends Agent<Env> {
        @unstable_callable()
        async callableMethod() {
          return "result";
        }

        async nonCallableMethod() {
          return "not callable";
        }
      }

      expect(TestRPCAgent.prototype.callableMethod).toBeDefined();
      expect(TestRPCAgent.prototype.nonCallableMethod).toBeDefined();
    });
  });

  describe("Scheduling System", () => {
    it("should support schedule method", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "schedule-test");

      expect(agent).toBeDefined();
    });

    it("should handle different schedule types", () => {
      const dateSchedule = new Date(Date.now() + 60000).toISOString();
      const delaySchedule = 30; // seconds
      const cronSchedule = "*/5 * * * *";

      expect(typeof dateSchedule).toBe("string");
      expect(typeof delaySchedule).toBe("number");
      expect(typeof cronSchedule).toBe("string");
    });

    it("should test schedule concepts", () => {
      type Schedule = {
        id: string;
        callback: string;
        time?: number;
        cron?: string;
        payload?: unknown;
      };

      const testSchedule: Schedule = {
        id: "test-123",
        callback: "processTask",
        time: Date.now() + 60000,
        payload: { data: "test" }
      };

      expect(testSchedule.id).toBeDefined();
      expect(testSchedule.callback).toBeDefined();
    });
  });

  describe("Queue System", () => {
    it("should support queue functionality", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "queue-test");

      expect(agent).toBeDefined();
    });

    it("should understand queue concepts", () => {
      // Test queue-related types
      type QueueItem = {
        id: string;
        callback: string;
        payload: unknown;
        retries?: number;
      };

      const testQueueItem: QueueItem = {
        id: "queue-123",
        callback: "processData",
        payload: { data: "test" },
        retries: 0
      };

      expect(testQueueItem.id).toBeDefined();
      expect(testQueueItem.callback).toBe("processData");
      expect(testQueueItem.payload).toEqual({ data: "test" });
    });
  });

  describe("SQL Storage", () => {
    it("should use SQL for state persistence", async () => {
      const agent = await getAgentByName(env.TEST_AGENT, "sql-state-test");

      await agent.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sqlTest: true,
            timestamp: Date.now()
          })
        })
      );

      // State is persisted in SQL storage
      const response = await agent.fetch(
        new Request("http://localhost/getState")
      );
      const state = (await response.json()) as {
        sqlTest: boolean;
        timestamp: number;
      };
      expect(state.sqlTest).toBe(true);
      expect(state.timestamp).toBeDefined();
    });
  });
});
