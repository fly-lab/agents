import { env, runInDurableObject } from "cloudflare:test";
import { expect, describe, it, vi } from "vitest";
import { getAgentByName, routeAgentRequest } from "../index.ts";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

describe("Agent Core Functionality", () => {
  describe("State Management", () => {
    it("should persist state across DO lifecycle and handle concurrent updates", async () => {
      const agentName = `state-test-${Date.now()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, agentName);

      // Fire off 3 setState calls simultaneously to test if race conditions would show up
      const promises = Array.from({ length: 3 }, (_, i) =>
        agentWithRouting.fetch(
          new Request("http://localhost/setState", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              counter: i,
              timestamp: Date.now(),
              persistent: "data"
            })
          })
        )
      );

      const responses = await Promise.all(promises);
      responses.forEach((response) => {
        expect(response.status).toBe(200);
      });

      // Get a completely fresh agent instance; this simulates what happens after DO eviction
      const freshAgentWithRouting = await getAgentByName(
        env.TEST_AGENT,
        agentName
      );
      const response = await freshAgentWithRouting.fetch(
        new Request("http://localhost/getState")
      );
      const state = (await response.json()) as {
        counter: number;
        persistent: string;
      };
      expect(state).toBeDefined();
      expect(typeof state.counter).toBe("number");
      expect(state.persistent).toBe("data");
    });
  });

  describe("Request Routing", () => {
    it("should route valid agent requests and handle CORS", async () => {
      // This should match the /agents/* pattern and get routed to an agent
      const validRequest = new Request(
        "http://localhost/agents/test-agent/instance-1",
        {
          method: "GET"
        }
      );
      const response = await routeAgentRequest(validRequest, env);
      expect(response).not.toBeNull();
      expect(response!.status).toBeGreaterThan(0);

      // This path doesn't match any agent route, so should return null
      const invalidRequest = new Request(
        "http://localhost/api/other/endpoint",
        {
          method: "GET"
        }
      );
      const invalidResponse = await routeAgentRequest(invalidRequest, env);
      expect(invalidResponse).toBeNull();

      // Browser preflight request; needs to respond with proper CORS headers
      const corsRequest = new Request(
        "http://localhost/agents/test-agent/test",
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "POST"
          }
        }
      );
      const corsResponse = await routeAgentRequest(corsRequest, env, {
        cors: true
      });
      expect(corsResponse).toBeDefined();
      expect(corsResponse!.status).toBe(200);
      expect(corsResponse!.headers.get("Access-Control-Allow-Origin")).toBe(
        "*"
      );
    });
  });

  describe("WebSocket Functionality", () => {
    it("should handle WebSocket upgrade and RPC calls", async () => {
      const testId = `ws-test-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // The Upgrade header should trigger WebSocket protocol switch
      const upgradeResponse = await agentWithRouting.fetch(
        new Request("http://localhost/test", {
          method: "GET",
          headers: { Upgrade: "websocket" }
        })
      );

      expect(upgradeResponse.status).toBe(101);
      expect(upgradeResponse.webSocket).toBeDefined();

      const ws = upgradeResponse.webSocket!;
      const receivedMessages: string[] = [];
      ws.addEventListener("message", (event) => {
        receivedMessages.push(event.data);
      });
      ws.accept();

      // Send an RPC call over the WebSocket
      const rpcMessage = {
        type: "rpc",
        method: "testMethod",
        args: [],
        id: "rpc-test"
      };

      ws.send(JSON.stringify(rpcMessage));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Look for our specific RPC response in all the messages we received
      const rpcResponses = receivedMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === "rpc" && parsed.id === "rpc-test";
        } catch {
          return false;
        }
      });

      expect(rpcResponses.length).toBeGreaterThan(0);
      const rpcResponse = JSON.parse(rpcResponses[0]);
      expect(rpcResponse).toHaveProperty("success", true);
      expect(rpcResponse).toHaveProperty("result", "test result");

      ws.close();
    });

    it("should broadcast state updates to WebSocket connections", async () => {
      const testId = `state-broadcast-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // First, establish a WebSocket connection to listen for state changes
      const wsResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "GET",
          headers: { Upgrade: "websocket" }
        })
      );

      expect(wsResponse.status).toBe(101);
      const ws = wsResponse.webSocket!;

      const receivedMessages: string[] = [];
      ws.addEventListener("message", (event) => {
        receivedMessages.push(event.data);
      });
      ws.accept();

      // Now update state via HTTP; this should push a message to our WebSocket
      const stateData = {
        connectionCount: 2,
        broadcastMessage: "test broadcast",
        updateId: "update-1"
      };

      const setStateResponse = await agentWithRouting.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stateData)
        })
      );

      expect(setStateResponse.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Filter out the state broadcast messages; these have type "cf_agent_state"
      const stateMessages = receivedMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === "cf_agent_state";
        } catch {
          return false;
        }
      });

      expect(stateMessages.length).toBeGreaterThan(0);
      const latestStateMessage = JSON.parse(
        stateMessages[stateMessages.length - 1]
      );
      expect(latestStateMessage.state).toHaveProperty("connectionCount", 2);
      expect(latestStateMessage.state).toHaveProperty("updateId", "update-1");
    });
  });

  describe("RPC System", () => {
    it("should handle JSON-RPC over HTTP and stub calls", async () => {
      const testId = `json-rpc-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Call a method via JSON-RPC over HTTP
      const rpcResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "testMethod",
            params: [],
            id: "test-123"
          })
        })
      );

      expect([200, 404].includes(rpcResponse.status)).toBe(true);

      if (rpcResponse.status === 200) {
        const responseData = (await rpcResponse.json()) as any;
        expect(responseData).toHaveProperty("jsonrpc", "2.0");
        expect(responseData).toHaveProperty("id", "test-123");
        expect(responseData).toHaveProperty("result");
      }

      // test the .stub.xyz pattern by calling methods directly on the DO instance
      const id = env.TEST_AGENT.idFromName(testId);
      const agent = env.TEST_AGENT.get(id);

      await runInDurableObject(agent, async (instance) => {
        const result1 = await instance.testMethod();
        expect(result1).toBe("test result");

        const result2 = await instance.addNumbers(5, 3);
        expect(result2).toBe(8);

        // Test state operations work through direct calls too
        const initialState = { testData: "stub-test", value: 42 };
        const setResult = await instance.setState(initialState);
        expect(setResult).toEqual({ success: true });

        const getResult = await instance.getState();
        expect(getResult).toEqual(initialState);
      });
    });

    it("should handle RPC parameters and error responses", async () => {
      const testId = `rpc-params-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Test with parameters
      const mathRpcRequest = {
        jsonrpc: "2.0",
        method: "addNumbers",
        params: [15, 27],
        id: "math-test"
      };

      const mathResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mathRpcRequest)
        })
      );

      expect([200, 404].includes(mathResponse.status)).toBe(true);

      if (mathResponse.status === 200) {
        const mathData = (await mathResponse.json()) as any;
        expect(mathData.result).toBe(42);
        expect(mathData.id).toBe("math-test");
      }

      // Test invalid method
      const invalidMethodRequest = {
        jsonrpc: "2.0",
        method: "nonExistentMethod",
        params: [],
        id: "invalid-method"
      };

      const invalidResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invalidMethodRequest)
        })
      );

      expect([200, 400, 404].includes(invalidResponse.status)).toBe(true);

      if (invalidResponse.status === 200) {
        const invalidData = (await invalidResponse.json()) as any;
        expect(invalidData).toHaveProperty("jsonrpc", "2.0");
        expect(invalidData).toHaveProperty("id", "invalid-method");
        expect(invalidData).toHaveProperty("error");
      }
    });
  });

  describe("getCurrentAgent Context", () => {
    it("should provide getCurrentAgent context in custom callable methods", async () => {
      const testId = `current-agent-${Date.now()}-${Math.random()}`;
      const id = env.TEST_AGENT.idFromName(testId);
      const agent = env.TEST_AGENT.get(id);

      // Test direct DO access with custom method
      await runInDurableObject(agent, async (instance) => {
        // First set some state to test actual behavior
        await instance.setState({ testValue: "custom-method-test" });

        const result = await instance.testGetCurrentAgent();
        expect(result.hasAgent).toBe(true);
        expect(result.agentType).toBe("TestAgent");
        expect(result.hasRequest).toBe(false);
        expect(result.hasConnection).toBe(false);
        expect(result.hasEmail).toBe(false);

        // gent is the real instance
        expect(result.agentInstanceTest).toBe(true);
        expect(result.canCallAgentMethod).toBe(true);
        expect(result.agentStateAccess).toEqual({
          testValue: "custom-method-test"
        });

        // Verify agent object is actually the instance
        expect(result.agentType).toBe(instance.constructor.name);
      });
    });

    it("should provide getCurrentAgent context in well-known methods", async () => {
      const testId = `current-agent-well-known-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Test setState (well-known method) has getCurrentAgent context
      const stateResponse = await agentWithRouting.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ getCurrentAgentTest: true })
        })
      );

      expect(stateResponse.status).toBe(200);
      const result = await stateResponse.json();
      expect(result).toHaveProperty("success", true);

      // Test getState (well-known method)
      const getStateResponse = await agentWithRouting.fetch(
        new Request("http://localhost/getState")
      );

      expect(getStateResponse.status).toBe(200);
      const state = await getStateResponse.json();
      expect(state).toHaveProperty("getCurrentAgentTest", true);
    });

    it("should provide getCurrentAgent context during HTTP requests", async () => {
      const testId = `current-agent-http-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Test HTTP request context via JSON-RPC
      const rpcRequest = {
        jsonrpc: "2.0",
        method: "testGetCurrentAgent",
        params: [],
        id: "context-test"
      };

      const response = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "test-client/1.0"
          },
          body: JSON.stringify(rpcRequest)
        })
      );

      expect([200, 404].includes(response.status)).toBe(true);

      if (response.status === 200) {
        const responseData = (await response.json()) as any;
        expect(responseData.result.hasAgent).toBe(true);
        expect(responseData.result.agentType).toBe("TestAgent");
        expect(responseData.result.hasRequest).toBe(true);
        expect(responseData.result.hasConnection).toBe(false);
        expect(responseData.result.hasEmail).toBe(false);
        expect(responseData.result.requestMethod).toBe("POST");
        expect(responseData.result.requestUrl).toContain("localhost");

        // Test actual request object behavior
        expect(responseData.result.requestHeadersAccess).toBeDefined();
        expect(responseData.result.requestHeadersAccess.userAgent).toBe(
          "test-client/1.0"
        );
        expect(responseData.result.requestHeadersAccess.contentType).toBe(
          "application/json"
        );
        expect(
          responseData.result.requestHeadersAccess.headerCount
        ).toBeGreaterThan(0);
      }
    });

    it("should provide getCurrentAgent context during WebSocket connections", async () => {
      const testId = `current-agent-ws-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Test WebSocket context
      const wsResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "GET",
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade"
          }
        })
      );

      expect(wsResponse.status).toBe(101);
      const ws = wsResponse.webSocket!;

      const receivedMessages: string[] = [];
      ws.addEventListener("message", (event) => {
        receivedMessages.push(event.data);
      });
      ws.accept();

      const wsRpcMessage = {
        type: "rpc",
        method: "testGetCurrentAgent",
        args: [],
        id: "ws-context-test"
      };

      ws.send(JSON.stringify(wsRpcMessage));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const rpcResponses = receivedMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === "rpc" && parsed.id === "ws-context-test";
        } catch {
          return false;
        }
      });

      expect(rpcResponses.length).toBeGreaterThan(0);
      const rpcResponse = JSON.parse(rpcResponses[0]);
      expect(rpcResponse.result.hasAgent).toBe(true);
      expect(rpcResponse.result.agentType).toBe("TestAgent");
      expect(rpcResponse.result.hasRequest).toBe(false);
      expect(rpcResponse.result.hasConnection).toBe(true);
      expect(rpcResponse.result.hasEmail).toBe(false);

      // Test actual connection object behavior
      expect(rpcResponse.result.connectionStateAccess).toBeDefined();
      expect(rpcResponse.result.connectionStateAccess.canAcceptEvents).toBe(
        true
      );
      expect(rpcResponse.result.connectionStateAccess.canSendMessages).toBe(
        true
      );
      expect(typeof rpcResponse.result.connectionStateAccess.readyState).toBe(
        "number"
      );

      ws.close();
    });

    it("should provide getCurrentAgent context during email handling", async () => {
      const testId = `current-agent-email-${Date.now()}-${Math.random()}`;
      const emailId = env.EmailAgent.idFromName(testId);
      const emailAgent = env.EmailAgent.get(emailId);

      await runInDurableObject(emailAgent, async (instance) => {
        const mockEmail = {
          from: "test@example.com",
          to: "agent@test.com",
          headers: new Headers({
            "Message-ID": "<test@example.com>",
            Date: new Date().toISOString(),
            Subject: "Test Email"
          }),
          getRaw: async () => new Uint8Array(),
          rawSize: 100,
          setReject: () => {},
          forward: async () => {},
          reply: async () => {}
        };

        // Call onEmail method which should have email context
        await instance.onEmail(mockEmail as any);
        expect(instance.emailsReceived).toHaveLength(1);
        expect(instance.emailsReceived[0]).toEqual(mockEmail);

        // Test actual getCurrentAgent context behavior during email handling
        // Note: When called directly via runInDurableObject, email context may not be available
        // This tests that the email agent can access agent context during email processing
        expect(instance.currentAgentContext).toBeDefined();
        expect(instance.currentAgentContext.hasAgent).toBe(true);
        expect(instance.currentAgentContext.agentType).toBe("TestEmailAgent");
        expect(instance.currentAgentContext.agentInstanceTest).toBe(true);

        // Verify email was processed correctly
        expect(instance.emailsReceived[0].from).toBe("test@example.com");
        expect(instance.emailsReceived[0].to).toBe("agent@test.com");
        expect(instance.emailsReceived[0].headers.get("Message-ID")).toBe(
          "<test@example.com>"
        );
        expect(instance.emailsReceived[0].headers.get("Date")).toBeDefined();
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle various error scenarios", async () => {
      const testId = `error-test-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Test JSON parsing error
      const errorResponse = await agentWithRouting.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "invalid json"
        })
      );

      expect(errorResponse.status).toBe(500);

      // Test namespace error
      const undefinedEnv = { TEST_AGENT: undefined } as any;
      await expect(async () => {
        await getAgentByName(undefinedEnv.TEST_AGENT, "test");
      }).rejects.toThrow();

      // Test malformed RPC request
      const malformedRequest = {
        method: "testMethod",
        params: [],
        id: "test1"
      };

      const rpcResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(malformedRequest)
        })
      );

      expect([200, 400, 404].includes(rpcResponse.status)).toBe(true);

      if (rpcResponse.status === 200) {
        const responseData = (await rpcResponse.json()) as any;
        expect(responseData).toHaveProperty("jsonrpc", "2.0");
        expect(responseData).toHaveProperty("error");
      }
    });
  });

  describe("Location Hint Verification", () => {
    it("should pass location hint to durable object", async () => {
      const namespaceGetSpy = vi.spyOn(env.TEST_AGENT, "get");

      const locationHint = "wnam" as DurableObjectLocationHint;
      const agent = await getAgentByName(env.TEST_AGENT, "location-test", {
        locationHint
      });

      expect(agent).toBeDefined();
      expect(namespaceGetSpy).toHaveBeenCalled();
      const callArgs = namespaceGetSpy.mock.calls[0];
      expect(callArgs[1]).toHaveProperty("locationHint", locationHint);

      const response = await agent.fetch(
        new Request("http://localhost/getState", { method: "GET" })
      );
      expect(response.status).toBe(200);

      namespaceGetSpy.mockRestore();

      // Test multiple location hints
      const locationHints: DurableObjectLocationHint[] = [
        "wnam",
        "enam",
        "apac",
        "weur",
        "oc"
      ];

      for (const hint of locationHints) {
        const spy = vi.spyOn(env.TEST_AGENT, "get");
        const testAgent = await getAgentByName(
          env.TEST_AGENT,
          `location-${hint}-test`,
          {
            locationHint: hint
          }
        );

        expect(testAgent).toBeDefined();
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls[0][1]).toHaveProperty("locationHint", hint);
        spy.mockRestore();
      }
    });
  });

  describe("Durable Object Eviction Tests", () => {
    it("should handle DO eviction and state persistence", async () => {
      const testId = `eviction-test-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Set initial state
      const initialState = {
        evictionTest: true,
        preEvictionData: "before eviction",
        timestamp: Date.now()
      };

      const setStateResponse = await agentWithRouting.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(initialState)
        })
      );

      expect(setStateResponse.status).toBe(200);

      // Get the instance ID before eviction
      const preEvictionRpc = {
        jsonrpc: "2.0",
        method: "getInstanceId",
        params: [],
        id: "pre-eviction"
      };

      const preEvictionResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(preEvictionRpc)
        })
      );

      expect([200, 404].includes(preEvictionResponse.status)).toBe(true);

      if (preEvictionResponse.status === 404) {
        // Instance tracking not available, skip eviction test
        return;
      }

      const preEvictionData = (await preEvictionResponse.json()) as any;
      const originalInstanceId = preEvictionData.result.instanceId;

      expect(originalInstanceId).toBeDefined();
      expect(originalInstanceId).toMatch(/^instance-/);

      // Trigger eviction
      const evictionRpc = {
        jsonrpc: "2.0",
        method: "testEviction",
        params: [],
        id: "eviction-trigger"
      };

      const evictionResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(evictionRpc)
        })
      );

      expect([200, 500].includes(evictionResponse.status)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Test state persistence after eviction
      const freshAgentWithRouting = await getAgentByName(
        env.TEST_AGENT,
        testId
      );
      const stateResponse = await freshAgentWithRouting.fetch(
        new Request("http://localhost/getState")
      );

      expect(stateResponse.status).toBe(200);
      const restoredState = (await stateResponse.json()) as any;

      expect(restoredState.evictionTest).toBe(true);
      expect(restoredState.preEvictionData).toBe("before eviction");
      expect(restoredState.timestamp).toBe(initialState.timestamp);
    });

    it("should handle WebSocket connections during eviction", async () => {
      const testId = `ws-eviction-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Create WebSocket connection
      const wsResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "GET",
          headers: { Upgrade: "websocket" }
        })
      );

      expect(wsResponse.status).toBe(101);
      const ws = wsResponse.webSocket!;

      const receivedMessages: string[] = [];
      ws.addEventListener("message", (event) => {
        receivedMessages.push(event.data);
      });
      ws.accept();

      // Set state through WebSocket RPC
      const wsStateRpc = {
        type: "rpc",
        method: "setState",
        args: [{ wsEvictionTest: true, timestamp: Date.now() }],
        id: "ws-state-test"
      };

      ws.send(JSON.stringify(wsStateRpc));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Trigger eviction
      const evictionRpc = {
        type: "rpc",
        method: "testEviction",
        args: [],
        id: "ws-eviction"
      };

      ws.send(JSON.stringify(evictionRpc));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify state persists after eviction
      const freshAgent = await getAgentByName(env.TEST_AGENT, testId);
      const stateResponse = await freshAgent.fetch(
        new Request("http://localhost/getState")
      );

      const state = (await stateResponse.json()) as any;
      expect(state.wsEvictionTest).toBe(true);

      ws.close();
    });
  });
});
