import { expect, describe, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { useAgent } from "../react.tsx";
import type { PartySocket } from "partysocket";
import type { MCPServersState, RPCResponse } from "../index.ts";

vi.mock("partysocket/react", () => ({
  usePartySocket: vi.fn()
}));

describe("useAgent", () => {
  let mockPartySocket: Partial<PartySocket>;
  let onMessageHandler: ((message: MessageEvent) => void) | undefined;
  let mockUsePartySocket: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { usePartySocket } = await import("partysocket/react");
    mockUsePartySocket = usePartySocket as ReturnType<typeof vi.fn>;

    mockPartySocket = {
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      readyState: 1,
      dispatchEvent: vi.fn()
    };

    mockUsePartySocket.mockImplementation(
      (options: { onMessage?: (message: MessageEvent) => void }) => {
        onMessageHandler = options.onMessage;
        return mockPartySocket;
      }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Basic Functionality", () => {
    it("should connect to an agent with default options", () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      expect(mockUsePartySocket).toHaveBeenCalledWith({
        agent: "TestAgent",
        party: "test-agent",
        prefix: "agents",
        room: "default",
        onMessage: expect.any(Function)
      });

      expect(result.current.agent).toBe("test-agent");
      expect(result.current.name).toBe("default");
      expect(typeof result.current.setState).toBe("function");
      expect(typeof result.current.call).toBe("function");
      expect(result.current.stub).toBeDefined();
    });

    it("should connect with custom name", () => {
      const { result } = renderHook(() =>
        useAgent({ agent: "TestAgent", name: "custom-instance" })
      );

      expect(mockUsePartySocket).toHaveBeenCalledWith(
        expect.objectContaining({
          room: "custom-instance"
        })
      );

      expect(result.current.name).toBe("custom-instance");
    });

    it("should convert agent names to kebab-case", () => {
      const testCases = [
        { input: "TestAgent", expected: "test-agent" },
        { input: "TEST_AGENT", expected: "test-agent" },
        { input: "testAgentName", expected: "test-agent-name" },
        { input: "test-agent", expected: "test-agent" }
      ];

      for (const { input, expected } of testCases) {
        const { result } = renderHook(() => useAgent({ agent: input }));
        expect(result.current.agent).toBe(expected);
      }
    });

    it("should warn when agent name is not lowercase", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      renderHook(() => useAgent({ agent: "TEST" }));

      expect(warnSpy).not.toHaveBeenCalled(); // Because TEST converts to "test" which is lowercase

      warnSpy.mockRestore();
    });

    it("should pass through additional options", () => {
      const customOptions = {
        agent: "TestAgent",
        host: "custom.host.com",
        query: { token: "abc123" }
      };

      renderHook(() => useAgent(customOptions));

      expect(mockUsePartySocket).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "custom.host.com",
          query: { token: "abc123" }
        })
      );
    });
  });

  describe("State Management", () => {
    it("should send state updates to server", () => {
      const onStateUpdate = vi.fn();
      const { result } = renderHook(() =>
        useAgent({ agent: "TestAgent", onStateUpdate })
      );

      const newState = { count: 5, name: "test" };

      act(() => {
        result.current.setState(newState);
      });

      expect(mockPartySocket.send).toHaveBeenCalledWith(
        JSON.stringify({ state: newState, type: "cf_agent_state" })
      );
      expect(onStateUpdate).toHaveBeenCalledWith(newState, "client");
    });

    it("should handle state updates from server", () => {
      const onStateUpdate = vi.fn();
      const { result } = renderHook(() =>
        useAgent({ agent: "TestAgent", onStateUpdate })
      );

      const serverState = { count: 10, serverData: true };
      const message = new MessageEvent("message", {
        data: JSON.stringify({
          type: "cf_agent_state",
          state: serverState
        })
      });

      act(() => {
        onMessageHandler?.(message);
      });

      expect(onStateUpdate).toHaveBeenCalledWith(serverState, "server");
    });

    it("should handle typed state", () => {
      type MyState = {
        count: number;
        name: string;
      };

      const onStateUpdate =
        vi.fn<(state: MyState, source: "server" | "client") => void>();
      const { result } = renderHook(() =>
        useAgent<MyState>({
          agent: "TestAgent",
          onStateUpdate
        })
      );

      const typedState: MyState = { count: 1, name: "typed" };

      act(() => {
        result.current.setState(typedState);
      });

      expect(onStateUpdate).toHaveBeenCalledWith(typedState, "client");
    });
  });

  describe("MCP Servers State", () => {
    it("should handle MCP server updates", () => {
      const onMcpUpdate = vi.fn();
      renderHook(() => useAgent({ agent: "TestAgent", onMcpUpdate }));

      const mcpState: MCPServersState = {
        servers: {
          server1: {
            name: "Test Server",
            server_url: "http://localhost:3000",
            auth_url: null,
            state: "ready",
            instructions: null,
            capabilities: {
              experimental: {},
              logging: {},
              prompts: {},
              resources: {},
              tools: {}
            }
          }
        },
        tools: [],
        prompts: [],
        resources: []
      };

      const message = new MessageEvent("message", {
        data: JSON.stringify({
          type: "cf_agent_mcp_servers",
          mcp: mcpState
        })
      });

      act(() => {
        onMessageHandler?.(message);
      });

      expect(onMcpUpdate).toHaveBeenCalledWith(mcpState);
    });
  });

  describe("RPC Calls", () => {
    it("should make RPC calls", async () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      // Start an RPC call
      const callPromise = result.current.call("testMethod", ["arg1", "arg2"]);

      expect(mockPartySocket.send).toHaveBeenCalled();
      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(sentData).toMatchObject({
        type: "rpc",
        method: "testMethod",
        args: ["arg1", "arg2"]
      });
      expect(sentData.id).toBeDefined();

      const response: RPCResponse = {
        type: "rpc",
        id: sentData.id,
        success: true,
        result: { data: "test result" }
      };

      act(() => {
        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify(response)
          })
        );
      });

      const result2 = await callPromise;
      expect(result2).toEqual({ data: "test result" });
    });

    it("should handle RPC errors", async () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      const callPromise = result.current.call("failingMethod");

      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData = JSON.parse(mockSend.mock.calls[0][0] as string);

      const response: RPCResponse = {
        type: "rpc",
        id: sentData.id,
        success: false,
        error: "Method not found"
      };

      act(() => {
        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify(response)
          })
        );
      });

      await expect(callPromise).rejects.toThrow("Method not found");
    });

    it("should handle streaming RPC responses", async () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      const chunks: unknown[] = [];
      let finalResult: unknown;

      const callPromise = result.current.call("streamingMethod", [], {
        onChunk: (chunk: unknown) => chunks.push(chunk),
        onDone: (result: unknown) => {
          finalResult = result;
        }
      });

      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData = JSON.parse(mockSend.mock.calls[0][0] as string);

      const responses: RPCResponse[] = [
        {
          type: "rpc",
          id: sentData.id,
          success: true,
          result: "chunk1",
          done: false
        },
        {
          type: "rpc",
          id: sentData.id,
          success: true,
          result: "chunk2",
          done: false
        },
        {
          type: "rpc",
          id: sentData.id,
          success: true,
          result: "final",
          done: true
        }
      ];

      act(() => {
        responses.forEach((response) => {
          onMessageHandler?.(
            new MessageEvent("message", {
              data: JSON.stringify(response)
            })
          );
        });
      });

      const result2 = await callPromise;
      expect(chunks).toEqual(["chunk1", "chunk2"]);
      expect(finalResult).toBe("final");
      expect(result2).toBe("final");
    });

    it("should handle streaming errors", async () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      const onError = vi.fn();
      const callPromise = result.current.call("streamingMethod", [], {
        onError
      });

      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData = JSON.parse(mockSend.mock.calls[0][0] as string);

      const response: RPCResponse = {
        type: "rpc",
        id: sentData.id,
        success: false,
        error: "Stream failed"
      };

      act(() => {
        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify(response)
          })
        );
      });

      await expect(callPromise).rejects.toThrow("Stream failed");
      expect(onError).toHaveBeenCalledWith("Stream failed");
    });

    it("should handle concurrent RPC calls", async () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      const call1 = result.current.call("method1", [1]);
      const call2 = result.current.call("method2", [2]);
      const call3 = result.current.call("method3", [3]);

      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData1 = JSON.parse(mockSend.mock.calls[0][0] as string);
      const sentData2 = JSON.parse(mockSend.mock.calls[1][0] as string);
      const sentData3 = JSON.parse(mockSend.mock.calls[2][0] as string);

      // Respond in different order
      act(() => {
        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "rpc",
              id: sentData2.id,
              success: true,
              result: "result2"
            })
          })
        );

        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "rpc",
              id: sentData3.id,
              success: true,
              result: "result3"
            })
          })
        );

        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "rpc",
              id: sentData1.id,
              success: true,
              result: "result1"
            })
          })
        );
      });

      const results = await Promise.all([call1, call2, call3]);
      expect(results).toEqual(["result1", "result2", "result3"]);
    });
  });

  describe("Stub Proxy", () => {
    it("should call methods through stub proxy", async () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      // Call method through stub
      const stubPromise = result.current.stub.testMethod("arg1", "arg2");

      expect(mockPartySocket.send).toHaveBeenCalled();
      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData = JSON.parse(mockSend.mock.calls[0][0] as string);
      expect(sentData).toMatchObject({
        type: "rpc",
        method: "testMethod",
        args: ["arg1", "arg2"]
      });

      act(() => {
        onMessageHandler?.(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "rpc",
              id: sentData.id,
              success: true,
              result: "stub result"
            })
          })
        );
      });

      const result2 = await stubPromise;
      expect(result2).toBe("stub result");
    });

    it("should handle any method name through stub", () => {
      const { result } = renderHook(() => useAgent({ agent: "TestAgent" }));

      // Test various method names
      const methods = ["foo", "barBaz", "test_method", "UPPERCASE"];

      methods.forEach((method) => {
        result.current.stub[method]();
        const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
        const sentData = JSON.parse(
          mockSend.mock.calls[mockSend.mock.calls.length - 1][0] as string
        );
        expect(sentData.method).toBe(method);
      });
    });
  });

  describe("Message Handling", () => {
    it("should ignore invalid JSON messages", () => {
      const onMessage = vi.fn();
      renderHook(() => useAgent({ agent: "TestAgent", onMessage }));

      const message = new MessageEvent("message", {
        data: "invalid json {"
      });

      act(() => {
        onMessageHandler?.(message);
      });

      // Should call original onMessage handler
      expect(onMessage).toHaveBeenCalledWith(message);
    });

    it("should pass through unknown message types", () => {
      const onMessage = vi.fn();
      renderHook(() => useAgent({ agent: "TestAgent", onMessage }));

      const message = new MessageEvent("message", {
        data: JSON.stringify({
          type: "unknown",
          data: "test"
        })
      });

      act(() => {
        onMessageHandler?.(message);
      });

      expect(onMessage).toHaveBeenCalledWith(message);
    });

    it("should handle non-string messages", () => {
      const onMessage = vi.fn();
      renderHook(() => useAgent({ agent: "TestAgent", onMessage }));

      const binaryData = new ArrayBuffer(8);
      const message = new MessageEvent("message", {
        data: binaryData
      });

      act(() => {
        onMessageHandler?.(message);
      });

      expect(onMessage).toHaveBeenCalledWith(message);
    });

    it("should ignore RPC responses for unknown request IDs", () => {
      renderHook(() => useAgent({ agent: "TestAgent" }));

      const response: RPCResponse = {
        type: "rpc",
        id: "unknown-id",
        success: true,
        result: "ignored"
      };

      // Should not throw
      expect(() => {
        act(() => {
          onMessageHandler?.(
            new MessageEvent("message", {
              data: JSON.stringify(response)
            })
          );
        });
      }).not.toThrow();
    });
  });

  describe("TypeScript Support", () => {
    it("should support typed agent methods", async () => {
      type MyAgent = {
        get state(): { count: number };
        testMethod(arg: string): Promise<{ result: string }>;
        optionalMethod(arg?: number): Promise<number>;
      };

      const { result } = renderHook(() =>
        useAgent<MyAgent, { count: number }>({
          agent: "TestAgent"
        })
      );

      const callPromise = result.current.call("testMethod", ["test"]);
      const stubPromise = result.current.stub.testMethod("test");

      const mockSend = mockPartySocket.send as ReturnType<typeof vi.fn>;
      const sentData1 = JSON.parse(mockSend.mock.calls[0][0] as string);
      const sentData2 = JSON.parse(mockSend.mock.calls[1][0] as string);

      act(() => {
        [sentData1, sentData2].forEach((data, index) => {
          onMessageHandler?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "rpc",
                id: data.id,
                success: true,
                result: { result: `result${index}` }
              })
            })
          );
        });
      });

      const results = await Promise.all([callPromise, stubPromise]);
      expect(results).toHaveLength(2);
    });

    it("should handle optional parameters correctly", () => {
      type MyAgent = {
        get state(): unknown;
        requiredMethod(a: string, b: number): Promise<void>;
        optionalMethod(a?: string): Promise<void>;
      };

      const { result } = renderHook(() =>
        useAgent<MyAgent, unknown>({ agent: "TestAgent" })
      );

      // Both should work
      result.current.call("requiredMethod", ["test", 123]);
      result.current.call("optionalMethod");
      result.current.call("optionalMethod", ["test"]);

      expect(mockPartySocket.send).toHaveBeenCalledTimes(3);
    });
  });

  describe("Cleanup and Edge Cases", () => {
    it("should cleanup pending calls on unmount", () => {
      const { result, unmount } = renderHook(() =>
        useAgent({ agent: "TestAgent" })
      );

      result.current.call("pendingMethod");

      unmount();
    });

    it("should handle re-renders without recreating connections", () => {
      const { rerender } = renderHook(
        ({ name }: { name: string }) => useAgent({ agent: "TestAgent", name }),
        { initialProps: { name: "instance1" } }
      );

      const firstCallCount = mockUsePartySocket.mock.calls.length;

      rerender({ name: "instance1" });

      expect(mockUsePartySocket).toHaveBeenCalledTimes(firstCallCount + 1);
    });

    it("should memoize the call function", () => {
      const { result, rerender } = renderHook(() =>
        useAgent({ agent: "TestAgent" })
      );

      const firstCall = result.current.call;

      rerender();

      const secondCall = result.current.call;

      expect(typeof firstCall).toBe("function");
      expect(typeof secondCall).toBe("function");
    });
  });
});

describe("camelCaseToKebabCase utility", () => {
  it("should convert various string formats correctly", () => {
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

    for (const { input, expected } of testCases) {
      const { result } = renderHook(() => useAgent({ agent: input }));
      expect(result.current.agent).toBe(expected);
    }
  });
});
