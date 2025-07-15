import { expect, describe, it, vi, beforeEach, afterEach } from "vitest";
import { MCPClientManager, getNamespacedData } from "../mcp/client";
import { MCPClientConnection } from "../mcp/client-connection";
import type { AgentsOAuthProvider } from "../mcp/do-oauth-client-provider";

vi.mock("../mcp/client-connection", () => ({
  MCPClientConnection: vi
    .fn()
    .mockImplementation((url: URL, _info: unknown, options: unknown) => {
      const instance = {
        url,
        options,
        connectionState: "connecting",
        tools: [] as unknown[],
        prompts: [] as unknown[],
        resources: [] as unknown[],
        resourceTemplates: [] as unknown[],
        serverCapabilities: undefined as unknown,
        client: {
          close: vi.fn().mockResolvedValue(undefined),
          callTool: vi.fn().mockResolvedValue({
            isError: false,
            content: [{ text: "Tool result" }]
          }),
          readResource: vi
            .fn()
            .mockResolvedValue({ content: "Resource content" }),
          getPrompt: vi.fn().mockResolvedValue({
            messages: [{ role: "user", content: "Prompt" }]
          })
        },
        init: vi.fn().mockImplementation(async (code?: string) => {
          if (code === "fail_auth") {
            instance.connectionState = "authenticating";
            return;
          }
          if (code === "throw_error") {
            instance.connectionState = "failed";
            throw new Error("Connection failed");
          }
          instance.connectionState = "ready";
          instance.serverCapabilities = {
            tools: {},
            prompts: {},
            resources: {}
          };
          instance.tools = [
            {
              name: "test-tool",
              description: "A test tool",
              inputSchema: { type: "object" }
            }
          ];
          instance.prompts = [
            { name: "test-prompt", description: "A test prompt" }
          ];
          instance.resources = [
            { uri: "test://resource", name: "test-resource" }
          ];
          instance.resourceTemplates = [
            { uriTemplate: "test://resource/{id}", name: "test-template" }
          ];
        })
      };
      return instance;
    })
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123")
}));

vi.mock("ai", () => ({
  jsonSchema: vi.fn((schema) => schema)
}));

describe("MCPClientManager", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPClientManager("test-client", "1.0.0");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Constructor", () => {
    it("should create a new MCPClientManager instance", () => {
      expect(manager).toBeDefined();
      expect(manager.mcpConnections).toEqual({});
    });

    it("should store name and version", () => {
      const customManager = new MCPClientManager("custom-client", "2.0.0");
      expect(customManager).toBeDefined();
    });
  });

  describe("Connection Management", () => {
    it("should connect to an MCP server without auth", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await manager.connect("http://localhost:3000");

      expect(result).toEqual({ id: "test-id-123" });
      expect(manager.mcpConnections["test-id-123"]).toBeDefined();
      expect(MCPClientConnection).toHaveBeenCalledWith(
        new URL("http://localhost:3000"),
        { name: "test-client", version: "1.0.0" },
        { client: {}, transport: {} }
      );

      warnSpy.mockRestore();
    });

    it("should connect with transport and client options", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const options = {
        transport: {},
        client: { capabilities: {} }
      };

      await manager.connect("http://localhost:3000", options);

      expect(MCPClientConnection).toHaveBeenCalledWith(
        new URL("http://localhost:3000"),
        { name: "test-client", version: "1.0.0" },
        options
      );

      warnSpy.mockRestore();
    });

    it("should handle OAuth authentication flow", async () => {
      const mockAuthProvider: AgentsOAuthProvider = {
        serverId: "",
        clientId: "oauth-client-123",
        authUrl: "https://auth.example.com/authorize",
        redirectUrl: new URL("http://localhost:3000/callback/test-id-123"),
        clientMetadata: {
          client_name: "test-client",
          client_uri: "example.com",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://localhost:3000/callback/test-id-123"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        },
        clientInformation: vi.fn().mockResolvedValue(undefined),
        saveClientInformation: vi.fn().mockResolvedValue(undefined),
        tokens: vi.fn().mockResolvedValue(undefined),
        saveTokens: vi.fn().mockResolvedValue(undefined),
        redirectToAuthorization: vi.fn().mockResolvedValue(undefined),
        codeVerifier: vi.fn().mockResolvedValue("test-verifier"),
        saveCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      const result = await manager.connect("http://localhost:3000", {
        transport: { authProvider: mockAuthProvider }
      });

      expect(result).toEqual({
        id: "test-id-123",
        authUrl: "https://auth.example.com/authorize",
        clientId: "oauth-client-123"
      });
      expect(mockAuthProvider.serverId).toBe("test-id-123");
    });

    it("should handle reconnection with OAuth code", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await manager.connect("http://localhost:3000", {
        reconnect: {
          id: "existing-id",
          oauthClientId: "oauth-client-123",
          oauthCode: "auth-code-456"
        }
      });

      expect(manager.mcpConnections["existing-id"]).toBeDefined();
      expect(manager.mcpConnections["existing-id"].init).toHaveBeenCalledWith(
        "auth-code-456"
      );

      warnSpy.mockRestore();
    });

    it("should warn when no authProvider is provided", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await manager.connect("http://localhost:3000");

      expect(warnSpy).toHaveBeenCalledWith(
        "No authProvider provided in the transport options. This client will only support unauthenticated remote MCP Servers"
      );

      warnSpy.mockRestore();
    });

    it("should close a specific connection", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.connect("http://localhost:3000");

      const closeMock = manager.mcpConnections["test-id-123"].client.close;
      await manager.closeConnection("test-id-123");

      expect(closeMock).toHaveBeenCalled();
      expect(manager.mcpConnections["test-id-123"]).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("should throw error when closing non-existent connection", async () => {
      await expect(manager.closeConnection("non-existent")).rejects.toThrow(
        'Connection with id "non-existent" does not exist.'
      );
    });

    it("should close all connections", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await manager.connect("http://localhost:3000");
      const id1 = "test-id-123";

      const { nanoid } = await import("nanoid");
      (nanoid as ReturnType<typeof vi.fn>).mockReturnValueOnce("test-id-456");

      await manager.connect("http://localhost:3001");
      const id2 = "test-id-456";

      const closeMocks = [
        manager.mcpConnections[id1].client.close,
        manager.mcpConnections[id2].client.close
      ];

      await manager.closeAllConnections();

      closeMocks.forEach((mock) => {
        expect(mock).toHaveBeenCalled();
      });

      warnSpy.mockRestore();
    });
  });

  describe("OAuth Callback Handling", () => {
    beforeEach(async () => {
      const mockAuthProvider: AgentsOAuthProvider = {
        serverId: "",
        clientId: "oauth-client-123",
        authUrl: "https://auth.example.com/authorize",
        redirectUrl: new URL("http://localhost:3000/callback/test-id-123"),
        clientMetadata: {
          client_name: "test-client",
          client_uri: "example.com",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://localhost:3000/callback/test-id-123"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        },
        clientInformation: vi.fn().mockResolvedValue(undefined),
        saveClientInformation: vi.fn().mockResolvedValue(undefined),
        tokens: vi.fn().mockResolvedValue(undefined),
        saveTokens: vi.fn().mockResolvedValue(undefined),
        redirectToAuthorization: vi.fn().mockResolvedValue(undefined),
        codeVerifier: vi.fn().mockResolvedValue("test-verifier"),
        saveCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      await manager.connect("http://localhost:3000", {
        transport: { authProvider: mockAuthProvider }
      });
    });

    it("should identify callback requests", () => {
      const callbackReq = new Request(
        "http://localhost:3000/callback/test-id-123?code=abc&state=xyz"
      );
      const nonCallbackReq = new Request("http://localhost:3000/api/data");

      expect(manager.isCallbackRequest(callbackReq)).toBe(true);
      expect(manager.isCallbackRequest(nonCallbackReq)).toBe(false);
    });

    it("should handle callback request successfully", async () => {
      const req = new Request(
        "http://localhost:3000/callback/test-id-123?code=auth-code&state=oauth-client-123"
      );

      manager.mcpConnections["test-id-123"].connectionState = "authenticating";

      const result = await manager.handleCallbackRequest(req);

      expect(result).toEqual({ serverId: "test-id-123" });
      expect(manager.mcpConnections["test-id-123"].connectionState).toBe(
        "ready"
      );
    });

    it("should throw error if no code in callback", async () => {
      const req = new Request(
        "http://localhost:3000/callback/test-id-123?state=oauth-client-123"
      );

      await expect(manager.handleCallbackRequest(req)).rejects.toThrow(
        "Unauthorized: no code provided"
      );
    });

    it("should throw error if no state in callback", async () => {
      const req = new Request(
        "http://localhost:3000/callback/test-id-123?code=auth-code"
      );

      await expect(manager.handleCallbackRequest(req)).rejects.toThrow(
        "Unauthorized: no state provided"
      );
    });

    it("should throw error if server not in authenticating state", async () => {
      const req = new Request(
        "http://localhost:3000/callback/test-id-123?code=auth-code&state=oauth-client-123"
      );

      manager.mcpConnections["test-id-123"].connectionState = "ready";

      await expect(manager.handleCallbackRequest(req)).rejects.toThrow(
        "Failed to authenticate: the client isn't in the `authenticating` state"
      );
    });

    it("should throw error if no matching callback URL", async () => {
      const req = new Request(
        "http://wrong-host.com/callback?code=auth-code&state=oauth-client-123"
      );

      await expect(manager.handleCallbackRequest(req)).rejects.toThrow(
        "No callback URI match found for the request url"
      );
    });

    it("should throw error if authentication fails after callback", async () => {
      const req = new Request(
        "http://localhost:3000/callback/test-id-123?code=fail_auth&state=oauth-client-123"
      );

      manager.mcpConnections["test-id-123"].connectionState = "authenticating";

      await expect(manager.handleCallbackRequest(req)).rejects.toThrow(
        "Failed to authenticate: client failed to initialize"
      );
    });
  });

  describe("List Methods", () => {
    beforeEach(async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await manager.connect("http://localhost:3000");

      const { nanoid } = await import("nanoid");
      (nanoid as ReturnType<typeof vi.fn>).mockReturnValueOnce("test-id-456");

      await manager.connect("http://localhost:3001");

      warnSpy.mockRestore();
    });

    it("should list tools from all connections", () => {
      const tools = manager.listTools();

      expect(tools).toHaveLength(2);
      expect(tools[0]).toMatchObject({
        name: "test-tool",
        description: "A test tool",
        serverId: "test-id-123"
      });
    });

    it("should list prompts from all connections", () => {
      const prompts = manager.listPrompts();

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toMatchObject({
        name: "test-prompt",
        description: "A test prompt",
        serverId: "test-id-123"
      });
    });

    it("should list resources from all connections", () => {
      const resources = manager.listResources();

      expect(resources).toHaveLength(2);
      expect(resources[0]).toMatchObject({
        uri: "test://resource",
        name: "test-resource",
        serverId: "test-id-123"
      });
    });

    it("should list resource templates from all connections", () => {
      const templates = manager.listResourceTemplates();

      expect(templates).toHaveLength(2);
      expect(templates[0]).toMatchObject({
        uriTemplate: "test://resource/{id}",
        name: "test-template",
        serverId: "test-id-123"
      });
    });
  });

  describe("AI Tools Integration", () => {
    beforeEach(async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.connect("http://localhost:3000");
      warnSpy.mockRestore();
    });

    it("should convert MCP tools to AI SDK tools", () => {
      const aiTools = manager.unstable_getAITools();

      expect(aiTools).toBeDefined();
      expect(aiTools["test-id-123_test-tool"]).toBeDefined();
      expect(aiTools["test-id-123_test-tool"].description).toBe("A test tool");
      expect(typeof aiTools["test-id-123_test-tool"].execute).toBe("function");
    });

    it("should execute AI tool and return result", async () => {
      const aiTools = manager.unstable_getAITools();
      const tool = aiTools["test-id-123_test-tool"];
      expect(tool).toBeDefined();
      expect(tool.execute).toBeDefined();

      const result = await (
        tool as unknown as { execute: (args: unknown) => Promise<unknown> }
      ).execute({ arg: "value" });

      expect(result).toEqual({
        isError: false,
        content: [{ text: "Tool result" }]
      });
      expect(
        manager.mcpConnections["test-id-123"].client.callTool
      ).toHaveBeenCalled();

      const mockCallTool = manager.mcpConnections["test-id-123"].client
        .callTool as ReturnType<typeof vi.fn>;
      const callArgs = mockCallTool.mock.calls[0];
      expect(callArgs[0]).toMatchObject({
        arguments: { arg: "value" },
        name: "test-tool"
      });
    });

    it("should throw error when AI tool execution fails", async () => {
      manager.mcpConnections["test-id-123"].client.callTool = vi
        .fn()
        .mockResolvedValue({
          isError: true,
          content: [{ text: "Tool error" }]
        });

      const aiTools = manager.unstable_getAITools();
      const tool = aiTools["test-id-123_test-tool"];
      expect(tool).toBeDefined();
      expect(tool.execute).toBeDefined();

      await expect(
        (
          tool as unknown as { execute: (args: unknown) => Promise<unknown> }
        ).execute({})
      ).rejects.toThrow("Tool error");
    });
  });

  describe("Namespaced Operations", () => {
    beforeEach(async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.connect("http://localhost:3000");
      warnSpy.mockRestore();
    });

    it("should call tool on correct server", async () => {
      const result = await manager.callTool({
        serverId: "test-id-123",
        name: "test-tool",
        arguments: { param: "value" }
      });

      expect(result).toEqual({
        isError: false,
        content: [{ text: "Tool result" }]
      });
      expect(
        manager.mcpConnections["test-id-123"].client.callTool
      ).toHaveBeenCalledWith(
        {
          serverId: "test-id-123",
          name: "test-tool",
          arguments: { param: "value" }
        },
        undefined,
        undefined
      );
    });

    it("should handle namespaced tool names", async () => {
      await manager.callTool({
        serverId: "test-id-123",
        name: "test-id-123.test-tool",
        arguments: {}
      });

      expect(
        manager.mcpConnections["test-id-123"].client.callTool
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "test-tool"
        }),
        undefined,
        undefined
      );
    });

    it("should read resource from correct server", async () => {
      const options = { timeout: 5000 };
      const result = await manager.readResource(
        {
          serverId: "test-id-123",
          uri: "test://resource"
        },
        options
      );

      expect(result).toEqual({ content: "Resource content" });
      expect(
        manager.mcpConnections["test-id-123"].client.readResource
      ).toHaveBeenCalledWith(
        {
          serverId: "test-id-123",
          uri: "test://resource"
        },
        options
      );
    });

    it("should get prompt from correct server", async () => {
      const options = { timeout: 5000 };
      const result = await manager.getPrompt(
        {
          serverId: "test-id-123",
          name: "test-prompt",
          arguments: { key: "value" }
        },
        options
      );

      expect(result).toEqual({
        messages: [{ role: "user", content: "Prompt" }]
      });
      expect(
        manager.mcpConnections["test-id-123"].client.getPrompt
      ).toHaveBeenCalledWith(
        {
          serverId: "test-id-123",
          name: "test-prompt",
          arguments: { key: "value" }
        },
        options
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle connection initialization errors", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        manager.connect("http://localhost:3000", {
          reconnect: {
            id: "error-id",
            oauthCode: "throw_error"
          }
        })
      ).rejects.toThrow("Connection failed");

      expect(manager.mcpConnections["error-id"].connectionState).toBe("failed");

      warnSpy.mockRestore();
    });

    it("should handle missing server in callback", async () => {
      const newManager = new MCPClientManager("test-client", "1.0.0");
      const req = new Request(
        "http://localhost:3000/callback/unknown-id?code=auth-code&state=oauth-client-123"
      );

      await expect(newManager.handleCallbackRequest(req)).rejects.toThrow(
        "No callback URI match found for the request url"
      );
    });

    it("should handle missing authProvider in callback", async () => {
      const mockAuthProvider: AgentsOAuthProvider = {
        serverId: "",
        clientId: "oauth-client-123",
        authUrl: "https://auth.example.com/authorize",
        redirectUrl: new URL("http://localhost:3000/callback/test-auth-id"),
        clientMetadata: {
          client_name: "test-client",
          client_uri: "example.com",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://localhost:3000/callback/test-auth-id"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        },
        clientInformation: vi.fn().mockResolvedValue(undefined),
        saveClientInformation: vi.fn().mockResolvedValue(undefined),
        tokens: vi.fn().mockResolvedValue(undefined),
        saveTokens: vi.fn().mockResolvedValue(undefined),
        redirectToAuthorization: vi.fn().mockResolvedValue(undefined),
        codeVerifier: vi.fn().mockResolvedValue("test-verifier"),
        saveCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      await manager.connect("http://localhost:3000", {
        transport: { authProvider: mockAuthProvider },
        reconnect: { id: "test-auth-id" }
      });

      manager.mcpConnections["test-auth-id"].connectionState = "authenticating";
      manager.mcpConnections["test-auth-id"].options.transport.authProvider =
        undefined;

      const req = new Request(
        "http://localhost:3000/callback/test-auth-id?code=auth-code&state=oauth-client-123"
      );

      await expect(manager.handleCallbackRequest(req)).rejects.toThrow(
        "Trying to finalize authentication for a server connection without an authProvider"
      );
    });
  });
});

describe("getNamespacedData", () => {
  it("should namespace data with server IDs", () => {
    const mockConnections: Record<string, MCPClientConnection> = {
      server1: {
        tools: [
          { name: "tool1", description: "Tool 1", inputSchema: {} },
          { name: "tool2", description: "Tool 2", inputSchema: {} }
        ],
        prompts: [],
        resources: [],
        resourceTemplates: []
      } as unknown as MCPClientConnection,
      server2: {
        tools: [{ name: "tool3", description: "Tool 3", inputSchema: {} }],
        prompts: [],
        resources: [],
        resourceTemplates: []
      } as unknown as MCPClientConnection
    };

    const namespacedTools = getNamespacedData(mockConnections, "tools");

    expect(namespacedTools).toHaveLength(3);
    expect(namespacedTools[0]).toMatchObject({
      name: "tool1",
      description: "Tool 1",
      serverId: "server1"
    });
    expect(namespacedTools[2]).toMatchObject({
      name: "tool3",
      description: "Tool 3",
      serverId: "server2"
    });
  });

  it("should handle empty connections", () => {
    const namespacedData = getNamespacedData({}, "tools");
    expect(namespacedData).toEqual([]);
  });

  it("should handle all data types", () => {
    const mockConnection: MCPClientConnection = {
      tools: [{ name: "tool", description: "A tool", inputSchema: {} }],
      prompts: [{ name: "prompt", description: "A prompt" }],
      resources: [{ uri: "resource://test", name: "resource" }],
      resourceTemplates: [{ uriTemplate: "resource://{id}", name: "template" }]
    } as unknown as MCPClientConnection;

    const connections = { "test-server": mockConnection };

    expect(getNamespacedData(connections, "tools")).toHaveLength(1);
    expect(getNamespacedData(connections, "prompts")).toHaveLength(1);
    expect(getNamespacedData(connections, "resources")).toHaveLength(1);
    expect(getNamespacedData(connections, "resourceTemplates")).toHaveLength(1);
  });
});
