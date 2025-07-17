import { env, runInDurableObject } from "cloudflare:test";
import { expect, describe, it, vi, beforeEach } from "vitest";
import { MCPClientManager, getNamespacedData } from "../mcp/client";
import { MCPClientConnection } from "../mcp/client-connection";
import type { AgentsOAuthProvider } from "../mcp/do-oauth-client-provider";
import type { Env } from "./worker";
import { TestMcpAgent } from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

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
            content: [
              {
                text: "Tool execution successful",
                metadata: { executionId: "exec-123" }
              }
            ]
          }),
          readResource: vi.fn().mockResolvedValue({
            content: "Resource data loaded",
            mimeType: "application/json"
          }),
          getPrompt: vi.fn().mockResolvedValue({
            messages: [
              {
                role: "user",
                content: { type: "text", text: "System prompt loaded" }
              }
            ],
            metadata: { promptId: "prompt-456" }
          })
        },
        init: vi.fn().mockImplementation(async (code?: string) => {
          if (code === "fail_auth") {
            instance.connectionState = "authenticating";
            return;
          }
          if (code === "throw_error") {
            instance.connectionState = "failed";
            throw new Error(
              "MCP server connection failed: invalid credentials"
            );
          }
          instance.connectionState = "ready";
          instance.serverCapabilities = {
            tools: { streaming: true },
            prompts: { variables: true },
            resources: { subscription: true }
          };
          instance.tools = [
            {
              name: "process-document",
              description: "Process documents with AI analysis",
              inputSchema: {
                type: "object",
                properties: {
                  documentPath: { type: "string" },
                  analysisType: {
                    type: "string",
                    enum: ["summary", "extraction"]
                  }
                }
              }
            }
          ];
          instance.prompts = [
            {
              name: "document-analysis",
              description: "Generate document analysis prompts",
              arguments: [
                {
                  name: "documentType",
                  description: "Type of document",
                  required: true
                }
              ]
            }
          ];
          instance.resources = [
            {
              uri: "file://documents/sample.pdf",
              name: "Sample Document",
              mimeType: "application/pdf"
            }
          ];
          instance.resourceTemplates = [
            {
              uriTemplate: "file://documents/{documentId}.{format}",
              name: "Document Template",
              description: "Template for accessing documents by ID and format"
            }
          ];
        })
      };
      return instance;
    })
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "mcp-server-123")
}));

vi.mock("ai", () => ({
  jsonSchema: vi.fn((schema) => schema)
}));

describe("MCPClientManager Real Functionality", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPClientManager("agents-client", "2.0.0");
  });

  describe("MCP Agent Integration", () => {
    it("should handle MCP tool invocation through client manager", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Establish connection first
      await manager.connect("http://localhost:3000");

      // Test tool invocation through client manager
      const result = await manager.callTool({
        serverId: "mcp-server-123",
        name: "greet",
        arguments: { name: "MCP Test" }
      });

      // Verify the client manager handled the call correctly
      expect(result).toEqual({
        isError: false,
        content: [
          {
            text: "Tool execution successful",
            metadata: { executionId: "exec-123" }
          }
        ]
      });

      // Verify the underlying client connection was called with correct parameters
      const mockCallTool = manager.mcpConnections["mcp-server-123"].client
        .callTool as ReturnType<typeof vi.fn>;
      expect(mockCallTool).toHaveBeenCalledWith(
        {
          serverId: "mcp-server-123",
          name: "greet",
          arguments: { name: "MCP Test" }
        },
        undefined,
        undefined
      );

      // Verify connection state management
      expect(manager.mcpConnections["mcp-server-123"]).toBeDefined();
      expect(manager.mcpConnections["mcp-server-123"].connectionState).toBe(
        "ready"
      );

      warnSpy.mockRestore();
    });

    it("should handle tool invocation errors through client manager", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Establish connection first
      await manager.connect("http://localhost:3000");

      // Override the mock to return an error
      const mockCallTool = manager.mcpConnections["mcp-server-123"].client
        .callTool as ReturnType<typeof vi.fn>;
      mockCallTool.mockResolvedValueOnce({
        isError: true,
        content: [{ text: "Tool execution failed", type: "text" }]
      });

      // Test error handling through client manager
      const result = await manager.callTool({
        serverId: "mcp-server-123",
        name: "invalid-tool",
        arguments: { param: "value" }
      });

      // Verify the client manager properly handled the error response
      expect(result).toEqual({
        isError: true,
        content: [{ text: "Tool execution failed", type: "text" }]
      });

      // Verify the client was called with the correct parameters
      expect(mockCallTool).toHaveBeenCalledWith(
        {
          serverId: "mcp-server-123",
          name: "invalid-tool",
          arguments: { param: "value" }
        },
        undefined,
        undefined
      );

      // Verify connection is still maintained after error
      expect(manager.mcpConnections["mcp-server-123"].connectionState).toBe(
        "ready"
      );

      warnSpy.mockRestore();
    });
  });

  describe("MCP Connection Management with Server Communication", () => {
    it("should establish connection and verify server capabilities", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await manager.connect("http://localhost:3000");

      expect(result).toEqual({ id: "mcp-server-123" });
      expect(manager.mcpConnections["mcp-server-123"]).toBeDefined();
      expect(manager.mcpConnections["mcp-server-123"].connectionState).toBe(
        "ready"
      );

      // Verify server capabilities were properly initialized
      const connection = manager.mcpConnections["mcp-server-123"];
      expect(connection.serverCapabilities).toBeDefined();
      expect(connection.serverCapabilities?.tools).toEqual({ streaming: true });
      expect(connection.serverCapabilities?.prompts).toEqual({
        variables: true
      });
      expect(connection.serverCapabilities?.resources).toEqual({
        subscription: true
      });

      warnSpy.mockRestore();
    });

    it("should handle OAuth authentication with real callback flow", async () => {
      const mockAuthProvider: AgentsOAuthProvider = {
        serverId: "",
        clientId: "oauth-client-789",
        authUrl: "https://auth.mcp-server.com/authorize",
        redirectUrl: new URL("http://localhost:3000/callback/mcp-server-123"),
        clientMetadata: {
          client_name: "agents-client",
          client_uri: "https://agents.example.com",
          grant_types: ["authorization_code", "refresh_token"],
          redirect_uris: ["http://localhost:3000/callback/mcp-server-123"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic"
        },
        clientInformation: vi.fn().mockResolvedValue({
          client_id: "oauth-client-789",
          client_secret: "secret-abc"
        }),
        saveClientInformation: vi.fn().mockResolvedValue(undefined),
        tokens: vi.fn().mockResolvedValue({
          access_token: "access-token-xyz",
          refresh_token: "refresh-token-def",
          expires_in: 3600
        }),
        saveTokens: vi.fn().mockResolvedValue(undefined),
        redirectToAuthorization: vi.fn().mockResolvedValue(undefined),
        codeVerifier: vi.fn().mockResolvedValue("code-verifier-ghi"),
        saveCodeVerifier: vi.fn().mockResolvedValue(undefined)
      };

      const result = await manager.connect("http://localhost:3000", {
        transport: { authProvider: mockAuthProvider }
      });

      expect(result).toEqual({
        id: "mcp-server-123",
        authUrl: "https://auth.mcp-server.com/authorize",
        clientId: "oauth-client-789"
      });
      expect(mockAuthProvider.serverId).toBe("mcp-server-123");

      // Verify OAuth flow was initiated properly
      expect(result.authUrl).toBe("https://auth.mcp-server.com/authorize");
      expect(result.clientId).toBe("oauth-client-789");
      expect(mockAuthProvider.serverId).toBe("mcp-server-123");
    });

    it("should handle connection failures with meaningful error messages", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        manager.connect("http://localhost:3000", {
          reconnect: {
            id: "failed-connection",
            oauthCode: "throw_error"
          }
        })
      ).rejects.toThrow("MCP server connection failed: invalid credentials");

      expect(manager.mcpConnections["failed-connection"]).toBeDefined();
      expect(manager.mcpConnections["failed-connection"].connectionState).toBe(
        "failed"
      );

      warnSpy.mockRestore();
    });
  });

  describe("MCP Tool Execution with Data Processing", () => {
    beforeEach(async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.connect("http://localhost:3000");
      warnSpy.mockRestore();
    });

    it("should execute tools with complex parameters and return structured results", async () => {
      const result = await manager.callTool({
        serverId: "mcp-server-123",
        name: "process-document",
        arguments: {
          documentPath: "/documents/report.pdf",
          analysisType: "summary"
        }
      });

      expect(result).toEqual({
        isError: false,
        content: [
          {
            text: "Tool execution successful",
            metadata: { executionId: "exec-123" }
          }
        ]
      });

      // Verify the tool was called with correct parameters
      const mockCallTool = manager.mcpConnections["mcp-server-123"].client
        .callTool as ReturnType<typeof vi.fn>;
      expect(mockCallTool).toHaveBeenCalledWith(
        {
          serverId: "mcp-server-123",
          name: "process-document",
          arguments: {
            documentPath: "/documents/report.pdf",
            analysisType: "summary"
          }
        },
        undefined,
        undefined
      );
    });

    it("should read resources and return structured content", async () => {
      const result = await manager.readResource(
        {
          serverId: "mcp-server-123",
          uri: "file://documents/sample.pdf"
        },
        { timeout: 10000 }
      );

      expect(result).toEqual({
        content: "Resource data loaded",
        mimeType: "application/json"
      });

      // Verify resource was accessed with correct parameters
      const mockReadResource = manager.mcpConnections["mcp-server-123"].client
        .readResource as ReturnType<typeof vi.fn>;
      expect(mockReadResource).toHaveBeenCalledWith(
        {
          serverId: "mcp-server-123",
          uri: "file://documents/sample.pdf"
        },
        { timeout: 10000 }
      );
    });

    it("should get prompts with variables and return structured messages", async () => {
      const result = await manager.getPrompt(
        {
          serverId: "mcp-server-123",
          name: "document-analysis",
          arguments: { documentType: "technical-report" }
        },
        { timeout: 5000 }
      );

      expect(result).toEqual({
        messages: [
          {
            role: "user",
            content: { type: "text", text: "System prompt loaded" }
          }
        ],
        metadata: { promptId: "prompt-456" }
      });

      // Verify prompt was retrieved with correct arguments
      const mockGetPrompt = manager.mcpConnections["mcp-server-123"].client
        .getPrompt as ReturnType<typeof vi.fn>;
      expect(mockGetPrompt).toHaveBeenCalledWith(
        {
          serverId: "mcp-server-123",
          name: "document-analysis",
          arguments: { documentType: "technical-report" }
        },
        { timeout: 5000 }
      );
    });
  });

  describe("MCP Resource Listing and Management", () => {
    beforeEach(async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await manager.connect("http://localhost:3000");
      warnSpy.mockRestore();
    });

    it("should list all available tools with proper namespacing", () => {
      const tools = manager.listTools();

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: "process-document",
        description: "Process documents with AI analysis",
        serverId: "mcp-server-123",
        inputSchema: {
          type: "object",
          properties: {
            documentPath: { type: "string" },
            analysisType: { type: "string", enum: ["summary", "extraction"] }
          }
        }
      });
    });

    it("should list prompts with argument specifications", () => {
      const prompts = manager.listPrompts();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        name: "document-analysis",
        description: "Generate document analysis prompts",
        serverId: "mcp-server-123",
        arguments: [
          {
            name: "documentType",
            description: "Type of document",
            required: true
          }
        ]
      });
    });

    it("should list resources with mime type information", () => {
      const resources = manager.listResources();

      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        uri: "file://documents/sample.pdf",
        name: "Sample Document",
        mimeType: "application/pdf",
        serverId: "mcp-server-123"
      });
    });

    it("should list resource templates with URI template patterns", () => {
      const templates = manager.listResourceTemplates();

      expect(templates).toHaveLength(1);
      expect(templates[0]).toMatchObject({
        uriTemplate: "file://documents/{documentId}.{format}",
        name: "Document Template",
        description: "Template for accessing documents by ID and format",
        serverId: "mcp-server-123"
      });
    });
  });
});

describe("getNamespacedData Utility", () => {
  it("should properly namespace MCP server data with server identifiers", () => {
    const mockConnections: Record<string, MCPClientConnection> = {
      "document-server": {
        tools: [
          {
            name: "parse-pdf",
            description: "Parse PDF documents",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } }
            }
          },
          {
            name: "extract-text",
            description: "Extract text from documents",
            inputSchema: { type: "object" }
          }
        ],
        prompts: [],
        resources: [],
        resourceTemplates: []
      } as unknown as MCPClientConnection,
      "analysis-server": {
        tools: [
          {
            name: "analyze-sentiment",
            description: "Analyze text sentiment",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } }
            }
          }
        ],
        prompts: [],
        resources: [],
        resourceTemplates: []
      } as unknown as MCPClientConnection
    };

    const namespacedTools = getNamespacedData(mockConnections, "tools");

    expect(namespacedTools).toHaveLength(3);
    expect(namespacedTools[0]).toMatchObject({
      name: "parse-pdf",
      description: "Parse PDF documents",
      serverId: "document-server",
      inputSchema: { type: "object", properties: { path: { type: "string" } } }
    });
    expect(namespacedTools[2]).toMatchObject({
      name: "analyze-sentiment",
      description: "Analyze text sentiment",
      serverId: "analysis-server",
      inputSchema: { type: "object", properties: { text: { type: "string" } } }
    });
  });
});
