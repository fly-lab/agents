import { expect, describe, it, vi } from "vitest";
import { AgentClient, agentFetch, camelCaseToKebabCase } from "../client.ts";

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

describe("AgentClient", () => {
  describe("Connection", () => {
    it("should be able to connect to an agent with defaults", () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      expect(client).toBeDefined();
      expect(client.agent).toBe("test-agent"); // Should convert to kebab-case
      expect(client.name).toBe("default");
    });

    it("should be able to connect to an agent with options", () => {
      const client = new AgentClient({
        agent: "TestAgent",
        name: "my-instance",
        host: "custom.host.com"
      });

      expect(client).toBeDefined();
      expect(client.agent).toBe("test-agent");
      expect(client.name).toBe("my-instance");
    });

    it("should handle different agent name formats", () => {
      const testCases = [
        { input: "TestAgent", expected: "test-agent" },
        { input: "test-agent", expected: "test-agent" },
        { input: "TEST_AGENT", expected: "test-agent" },
        { input: "testAgent", expected: "test-agent" }
      ];

      testCases.forEach(({ input, expected }) => {
        const client = new AgentClient({
          agent: input,
          host: "localhost:1999"
        });
        expect(client.agent).toBe(expected);
      });
    });
  });

  describe("State Management", () => {
    it("should sync state from client to server", () => {
      const onStateUpdate = vi.fn();
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999",
        onStateUpdate
      });

      const sendSpy = vi.spyOn(client, "send");
      const newState = { count: 5, name: "test" };

      client.setState(newState);

      expect(sendSpy).toHaveBeenCalledWith(
        JSON.stringify({ state: newState, type: "cf_agent_state" })
      );
      expect(onStateUpdate).toHaveBeenCalledWith(newState, "client");
    });

    it("should receive state updates from server", () => {
      const onStateUpdate = vi.fn();
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999",
        onStateUpdate
      });

      // Simulate server state update
      const serverState = { count: 10, serverData: true };
      const event = new MessageEvent("message", {
        data: JSON.stringify({
          type: "cf_agent_state",
          state: serverState
        })
      });

      client.dispatchEvent(event);

      expect(onStateUpdate).toHaveBeenCalledWith(serverState, "server");
    });

    it("should handle complex state objects", () => {
      const onStateUpdate = vi.fn();
      const client = new AgentClient<{
        user: { id: number; name: string };
        settings: { theme: string };
      }>({
        agent: "TestAgent",
        host: "localhost:1999",
        onStateUpdate
      });

      const complexState = {
        user: { id: 1, name: "Alice" },
        settings: { theme: "dark" }
      };

      client.setState(complexState);

      expect(onStateUpdate).toHaveBeenCalledWith(complexState, "client");
    });
  });

  describe("RPC Calls", () => {
    it("should make RPC calls", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const sendSpy = vi.spyOn(client, "send");

      const callPromise = client.call("testMethod", ["arg1", "arg2"]);

      expect(sendSpy).toHaveBeenCalled();
      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);
      expect(sentData).toMatchObject({
        type: "rpc",
        method: "testMethod",
        args: ["arg1", "arg2"]
      });
      expect(sentData.id).toBeDefined();

      const response = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: true,
          result: { data: "test result" }
        })
      });

      client.dispatchEvent(response);

      const result = await callPromise;
      expect(result).toEqual({ data: "test result" });
    });

    it("should handle RPC errors", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const sendSpy = vi.spyOn(client, "send");

      const callPromise = client.call("failingMethod");

      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);
      const response = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: false,
          error: "Method not found"
        })
      });

      client.dispatchEvent(response);

      await expect(callPromise).rejects.toThrow("Method not found");
    });

    it("should handle streaming RPC responses", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const chunks: unknown[] = [];
      let finalResult: unknown;

      const sendSpy = vi.spyOn(client, "send");

      const callPromise = client.call("streamingMethod", [], {
        onChunk: (chunk) => chunks.push(chunk),
        onDone: (result) => {
          finalResult = result;
        }
      });

      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);

      const chunk1 = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: true,
          result: "chunk1",
          done: false
        })
      });

      const chunk2 = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: true,
          result: "chunk2",
          done: false
        })
      });

      const final = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: true,
          result: "final",
          done: true
        })
      });

      client.dispatchEvent(chunk1);
      client.dispatchEvent(chunk2);
      client.dispatchEvent(final);

      const result = await callPromise;

      expect(chunks).toEqual(["chunk1", "chunk2"]);
      expect(finalResult).toBe("final");
      expect(result).toBe("final");
    });

    it("should handle streaming errors", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const onError = vi.fn();
      const sendSpy = vi.spyOn(client, "send");

      const callPromise = client.call("streamingMethod", [], {
        onError
      });

      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);

      const errorResponse = new MessageEvent("message", {
        data: JSON.stringify({
          type: "rpc",
          id: sentData.id,
          success: false,
          error: "Stream failed"
        })
      });

      client.dispatchEvent(errorResponse);

      await expect(callPromise).rejects.toThrow("Stream failed");
      expect(onError).toHaveBeenCalledWith("Stream failed");
    });
  });

  describe("Message Handling", () => {
    it("should ignore invalid JSON messages", () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const event = new MessageEvent("message", {
        data: "invalid json {"
      });

      expect(() => client.dispatchEvent(event)).not.toThrow();
    });

    it("should ignore unknown message types", () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const event = new MessageEvent("message", {
        data: JSON.stringify({
          type: "unknown",
          data: "test"
        })
      });

      expect(() => client.dispatchEvent(event)).not.toThrow();
    });

    it("should handle multiple concurrent RPC calls", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const sendSpy = vi.spyOn(client, "send");

      const call1 = client.call("method1", [1]);
      const call2 = client.call("method2", [2]);
      const call3 = client.call("method3", [3]);

      const sentData1 = JSON.parse(sendSpy.mock.calls[0][0] as string);
      const sentData2 = JSON.parse(sendSpy.mock.calls[1][0] as string);
      const sentData3 = JSON.parse(sendSpy.mock.calls[2][0] as string);

      // Respond in different order
      client.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "rpc",
            id: sentData2.id,
            success: true,
            result: "result2"
          })
        })
      );

      client.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "rpc",
            id: sentData3.id,
            success: true,
            result: "result3"
          })
        })
      );

      client.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "rpc",
            id: sentData1.id,
            success: true,
            result: "result1"
          })
        })
      );

      const results = await Promise.all([call1, call2, call3]);
      expect(results).toEqual(["result1", "result2", "result3"]);
    });
  });

  describe("TypeScript Support", () => {
    it("should support typed state", () => {
      type MyState = {
        count: number;
        name: string;
      };

      const client = new AgentClient<MyState>({
        agent: "TestAgent",
        host: "localhost:1999",
        onStateUpdate: (state) => {
          expect(typeof state.count).toBe("number");
          expect(typeof state.name).toBe("string");
        }
      });

      client.setState({ count: 1, name: "test" });
    });

    it("should support typed RPC calls", async () => {
      const client = new AgentClient({
        agent: "TestAgent",
        host: "localhost:1999"
      });

      const sendSpy = vi.spyOn(client, "send");

      const callPromise = client.call<{ value: number }>("getNumber");

      const sentData = JSON.parse(sendSpy.mock.calls[0][0] as string);

      client.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "rpc",
            id: sentData.id,
            success: true,
            result: { value: 42 }
          })
        })
      );

      const result = await callPromise;

      expect(result).toEqual({ value: 42 });
      expect(result.value).toBe(42);
    });
  });
});

describe("agentFetch", () => {
  it("should make HTTP requests to agents", async () => {
    const response = await agentFetch(
      {
        agent: "TestAgent",
        name: "my-instance",
        host: "localhost:1999"
      },
      {
        method: "POST",
        body: JSON.stringify({ data: "test" })
      }
    );

    expect(response).toBeDefined();
    expect(response.status).toBe(200);
  });

  it("should use default instance name", async () => {
    const response = await agentFetch({
      agent: "TestAgent",
      host: "localhost:1999"
    });

    expect(response).toBeDefined();
    expect(response.status).toBe(200);
  });

  it("should convert agent names to kebab-case", async () => {
    const response = await agentFetch({
      agent: "MyTestAgent",
      host: "localhost:1999"
    });

    expect(response).toBeDefined();
  });
});

describe("camelCaseToKebabCase", () => {
  it("should convert various formats correctly", () => {
    const testCases = [
      { input: "TestAgent", expected: "test-agent" },
      { input: "testAgent", expected: "test-agent" },
      { input: "test", expected: "test" },
      { input: "TEST", expected: "test" },
      { input: "TEST_AGENT", expected: "test-agent" },
      { input: "test_agent", expected: "test-agent" },
      { input: "TestAgentName", expected: "test-agent-name" },
      { input: "ABC", expected: "abc" },
      { input: "test-agent", expected: "test-agent" },
      { input: "", expected: "" },
      { input: "Test123", expected: "test123" },
      { input: "test123Agent", expected: "test123-agent" }
    ];

    testCases.forEach(({ input, expected }) => {
      expect(camelCaseToKebabCase(input)).toBe(expected);
    });
  });

  it("should handle edge cases", () => {
    expect(camelCaseToKebabCase("A")).toBe("a");
    expect(camelCaseToKebabCase("aB")).toBe("a-b");
    expect(camelCaseToKebabCase("aBc")).toBe("a-bc");
    expect(camelCaseToKebabCase("_test_")).toBe("-test");
  });
});

describe("Error Handling", () => {
  it("should throw error for deprecated fetch method", () => {
    expect(() => AgentClient.fetch({} as never)).toThrow(
      "AgentClient.fetch is not implemented, use agentFetch instead"
    );
  });

  it("should handle connection errors gracefully", () => {
    const client = new AgentClient({
      agent: "TestAgent",
      host: "localhost:1999"
    });

    expect(client).toBeDefined();
  });
});
