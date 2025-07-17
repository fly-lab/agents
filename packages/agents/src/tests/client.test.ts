import { env } from "cloudflare:test";
import { expect, describe, it, vi, afterEach } from "vitest";
import { AgentClient, agentFetch } from "../client.ts";
import { getAgentByName } from "../index.ts";
import { PartySocket } from "partysocket";
import type { Env } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

class MockWebSocket {
  url: string;
  readyState = 0; // CONNECTING
  onopen?: (event: Event) => void;
  onmessage?: (event: MessageEvent) => void;
  onclose?: (event: CloseEvent) => void;
  onerror?: (event: Event) => void;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(_data: string) {}

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent("close"));
  }
}

vi.mock("partysocket", () => ({
  PartySocket: class MockPartySocket extends EventTarget {
    ws?: MockWebSocket;
    _options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      super();
      this._options = options;

      this.ws = new MockWebSocket(
        `ws://localhost/agents/${options.party}/${options.room}`
      );
    }

    send(data: string) {
      this.ws?.send(data);
    }

    static fetch(_opts: Record<string, unknown>, _init?: RequestInit) {
      return Promise.resolve(new Response("OK", { status: 200 }));
    }
  }
}));

describe("AgentClient Functionality", () => {
  describe("Real Durable Object Integration", () => {
    it("should sync state with real Durable Object through HTTP", async () => {
      const testId = `client-state-sync-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      const testState = {
        clientSync: true,
        timestamp: Date.now(),
        data: "real sync test"
      };

      // Test HTTP state synchronization (simulating real client-server flow)
      const setResponse = await agentWithRouting.fetch(
        new Request("http://localhost/setState", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testState)
        })
      );

      expect(setResponse.status).toBe(200);

      // Verify state persistence through HTTP endpoint
      const getResponse = await agentWithRouting.fetch(
        new Request("http://localhost/getState")
      );
      const retrievedState = (await getResponse.json()) as typeof testState;
      expect(retrievedState).toEqual(testState);
      expect(retrievedState.clientSync).toBe(true);
      expect(retrievedState.timestamp).toBe(testState.timestamp);
    });

    it("should handle WebSocket connections with real agents", async () => {
      const testId = `client-ws-${Date.now()}-${Math.random()}`;
      const agentWithRouting = await getAgentByName(env.TEST_AGENT, testId);

      // Test actual WebSocket upgrade functionality
      const wsResponse = await agentWithRouting.fetch(
        new Request("http://localhost/", {
          method: "GET",
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": "test-key",
            "Sec-WebSocket-Version": "13"
          }
        })
      );

      expect(wsResponse.status).toBe(101);
      expect(wsResponse.webSocket).toBeDefined();

      // Verify the WebSocket is properly initialized
      const ws = wsResponse.webSocket!;
      ws.accept();

      // Test that we can send data through the WebSocket
      ws.send(JSON.stringify({ type: "test", data: "websocket works" }));
    });
  });

  describe("RPC Call Functionality", () => {
    it("should handle complete RPC request-response cycles", async () => {
      const onStateUpdate = vi.fn();
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999",
        onStateUpdate
      });

      const sendSpy = vi.spyOn(client, "send");

      // Test actual RPC call with real parameters
      const callPromise = client.call("processData", [
        {
          input: "test data",
          options: { validate: true }
        }
      ]);

      expect(sendSpy).toHaveBeenCalled();
      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);
      expect(sentData.type).toBe("rpc");
      expect(sentData.method).toBe("processData");
      expect(sentData.args[0]).toEqual({
        input: "test data",
        options: { validate: true }
      });
      expect(sentData.id).toBeDefined();

      // Simulate realistic server response
      const serverResponse = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: true,
          result: {
            processed: true,
            output: "processed test data",
            validationPassed: true
          }
        })
      });

      client.dispatchEvent(serverResponse);

      const result = (await callPromise) as {
        processed: boolean;
        output: string;
        validationPassed: boolean;
      };
      expect(result).toBeDefined();
      expect(result.processed).toBe(true);
      expect(result.output).toBe("processed test data");
      expect(result.validationPassed).toBe(true);
    });

    it("should handle RPC error responses with specific error details", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const sendSpy = vi.spyOn(client, "send");
      const callPromise = client.call("invalidOperation", [{ badData: true }]);

      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);

      // Simulate realistic error response
      const errorResponse = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: false,
          error: "ValidationError: badData parameter not allowed",
          code: "INVALID_PARAMETER"
        })
      });

      client.dispatchEvent(errorResponse);

      await expect(callPromise).rejects.toThrow(
        "ValidationError: badData parameter not allowed"
      );
    });
  });

  describe("State Management with Data Flow", () => {
    it("should handle bidirectional state synchronization", () => {
      const stateUpdates: Array<{ state: unknown; source: string }> = [];
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999",
        onStateUpdate: (state, source) => stateUpdates.push({ state, source })
      });

      const sendSpy = vi.spyOn(client, "send");

      // Client updates state
      const clientState = {
        userAction: "file_uploaded",
        fileName: "document.pdf",
        uploadTime: Date.now()
      };

      client.setState(clientState);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({ state: clientState, type: "cf_agent_state" })
      );
      expect(stateUpdates).toContainEqual({
        state: clientState,
        source: "client"
      });

      // Server responds with processing state
      const serverStateEvent = new MessageEvent("message", {
        data: JSON.stringify({
          type: "cf_agent_state",
          state: {
            processing: true,
            fileName: "document.pdf",
            progress: 0.5,
            estimatedCompletion: Date.now() + 30000
          }
        })
      });

      client.dispatchEvent(serverStateEvent);

      expect(stateUpdates).toHaveLength(2);
      expect(stateUpdates[1].source).toBe("server");
      expect((stateUpdates[1].state as any).processing).toBe(true);
      expect((stateUpdates[1].state as any).progress).toBe(0.5);
    });
  });
});

describe("agentFetch Network Simulation", () => {
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("should handle complete HTTP request-response cycles", async () => {
    // Mock realistic response with headers and body
    fetchSpy = vi.spyOn(PartySocket, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { id: 123, name: "test-resource" },
          timestamp: Date.now()
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Agent-Version": "1.0.0"
          }
        }
      )
    );

    const response = await agentFetch(
      {
        agent: "TestAgent",
        name: "resource-123",
        host: "agents.example.com"
      },
      {
        method: "GET",
        headers: { Accept: "application/json" }
      }
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        party: "test-agent",
        prefix: "agents",
        room: "resource-123",
        host: "agents.example.com"
      }),
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Agent-Version")).toBe("1.0.0");

    const data = (await response.json()) as {
      success: boolean;
      data: { id: number; name: string };
      timestamp: number;
    };
    expect(data.success).toBe(true);
    expect(data.data.id).toBe(123);
    expect(data.data.name).toBe("test-resource");
  });

  it("should handle error scenarios with proper error handling", async () => {
    // Test 429 rate limiting scenario
    fetchSpy = vi.spyOn(PartySocket, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          retryAfter: 60,
          remainingRequests: 0
        }),
        {
          status: 429,
          headers: {
            "Retry-After": "60",
            "X-RateLimit-Remaining": "0"
          }
        }
      )
    );

    const response = await agentFetch({
      agent: "TestAgent",
      host: "localhost:1999"
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");

    const errorData = (await response.json()) as {
      error: string;
      retryAfter: number;
      remainingRequests: number;
    };
    expect(errorData.error).toBe("Rate limit exceeded");
    expect(errorData.retryAfter).toBe(60);
  });

  it("should handle network failures", async () => {
    const networkError = new Error("fetch failed");
    networkError.name = "TypeError";
    networkError.cause = "ECONNREFUSED";

    fetchSpy = vi.spyOn(PartySocket, "fetch").mockRejectedValue(networkError);

    await expect(
      agentFetch({
        agent: "TestAgent",
        host: "unreachable-server.com"
      })
    ).rejects.toThrow("fetch failed");
  });
});
