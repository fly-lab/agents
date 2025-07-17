import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import {
  Agent,
  type AgentEmail,
  unstable_callable,
  getCurrentAgent
} from "../index.ts";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  TEST_AGENT: DurableObjectNamespace<TestAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
};

type State = {
  count: number;
};

type Props = {
  testValue: string;
};

// Simple test agent for basic functionality testing
export class TestAgent extends Agent<Env> {
  // Track scheduled callbacks for testing
  scheduledCallbacks: string[] = [];

  // Instance tracking for eviction tests
  private _instanceId?: string;
  private _instanceCreated = Date.now();

  // Override onError to avoid console.error in tests
  override onError(error: unknown): void {
    // In tests, we'll just log instead of throwing
    console.error("Test error:", error);
  }

  // Override onRequest to handle basic HTTP
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle state management endpoints
    if (url.pathname === "/setState" && request.method === "POST") {
      try {
        const body = await request.json();
        await this.setState(body);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    }

    if (url.pathname === "/getState") {
      return new Response(JSON.stringify(this.state), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Handle scheduling endpoints
    if (url.pathname === "/schedule" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          when: string | number;
          callback: string;
          payload?: unknown;
        };
        // The schedule method signature is: schedule(when, callback, payload)
        const id = await this.schedule(
          body.when,
          body.callback as keyof this,
          body.payload
        );
        return new Response(JSON.stringify({ id, success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error)
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    }

    if (url.pathname === "/getSchedules") {
      const schedules = await this.getSchedules();
      return new Response(JSON.stringify(schedules), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // For root path POST requests, let the parent class handle RPC messages
    if (url.pathname === "/" && request.method === "POST") {
      try {
        // Check Content-Type to see if it might be JSON-RPC
        const contentType = request.headers.get("Content-Type");
        if (contentType && contentType.includes("application/json")) {
          // Let the parent class handle RPC messages
          return super.onRequest(request);
        }
      } catch {
        // If there's an error, fall through to default response
      }
    }

    return new Response("OK", { status: 200 });
  }

  @unstable_callable()
  async getState() {
    return this.state;
  }

  @unstable_callable()
  async setState(newState: unknown) {
    await super.setState(newState);
    return { success: true };
  }

  @unstable_callable()
  async testMethod() {
    return "test result";
  }

  @unstable_callable({ streaming: true })
  async *streamingMethod() {
    yield "chunk1";
    yield "chunk2";
  }

  @unstable_callable()
  async testCallable(arg1: string, arg2: string) {
    return { result: `Called with ${arg1} and ${arg2}` };
  }

  @unstable_callable()
  async addNumbers(a: number, b: number) {
    return a + b;
  }

  @unstable_callable()
  async testGetCurrentAgent() {
    // Test getCurrentAgent functionality
    const context = getCurrentAgent();

    // Test actual behavior - can we call methods on the agent?
    let canCallAgentMethod = false;
    let agentStateAccess = null;
    let requestHeadersAccess = null;
    let connectionStateAccess = null;

    if (context.agent) {
      try {
        // Try to access agent's state directly
        agentStateAccess = context.agent.state;
        canCallAgentMethod = true;
      } catch (error) {
        canCallAgentMethod = false;
      }
    }

    // Test actual request object behavior
    if (context.request) {
      try {
        let headerCount = 0;
        context.request.headers.forEach(() => headerCount++);
        requestHeadersAccess = {
          userAgent: context.request.headers.get("User-Agent"),
          contentType: context.request.headers.get("Content-Type"),
          headerCount
        };
      } catch (error) {
        requestHeadersAccess = null;
      }
    }

    // Test actual connection object behavior
    if (context.connection) {
      try {
        connectionStateAccess = {
          readyState: context.connection.readyState,
          // Test that we can actually call connection methods
          canAcceptEvents: typeof context.connection.accept === "function",
          canSendMessages: typeof context.connection.send === "function"
        };
      } catch (error) {
        connectionStateAccess = null;
      }
    }

    return {
      hasAgent: !!context.agent,
      hasRequest: !!context.request,
      hasConnection: !!context.connection,
      hasEmail: !!context.email,
      agentType: context.agent ? context.agent.constructor.name : null,
      requestMethod: context.request ? context.request.method : null,
      requestUrl: context.request ? context.request.url : null,
      canCallAgentMethod,
      agentStateAccess,
      // Test that we get the actual agent instance
      agentInstanceTest: context.agent === this,
      // Test actual request object functionality
      requestHeadersAccess,
      // Test actual connection object functionality
      connectionStateAccess
    };
  }

  @unstable_callable()
  async testEviction() {
    // Test method to simulate DO eviction
    // Note: This is for testing purposes and may not always trigger actual eviction
    try {
      const ctx = getCurrentAgent();
      // In a real scenario, we would need access to the execution context
      // For testing, we'll just simulate the eviction
      if (ctx.agent) {
        // Simulate eviction by clearing some state
        this._instanceId = undefined;
      }
    } catch (error) {
      // Eviction may fail in test environment, that's okay
    }
    return { evicted: true, timestamp: Date.now() };
  }

  @unstable_callable()
  async getInstanceId() {
    // Return a unique ID for this DO instance to verify eviction/recreation
    if (!this._instanceId) {
      this._instanceId = `instance-${Date.now()}-${Math.random()}`;
    }
    return { instanceId: this._instanceId, created: this._instanceCreated };
  }

  // Schedulable callback methods
  async testCallback(payload: unknown) {
    this.scheduledCallbacks.push(`testCallback: ${JSON.stringify(payload)}`);
    await this.setState({
      ...((this.state as object) || {}),
      lastScheduledCallback: {
        name: "testCallback",
        payload,
        timestamp: Date.now()
      }
    });
  }

  async incrementCounter() {
    const current = (this.state as { counter?: number })?.counter || 0;
    await this.setState({
      ...((this.state as object) || {}),
      counter: current + 1
    });
  }
}

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  async init() {
    this.server.tool(
      "greet",
      "A simple greeting tool",
      { name: z.string().describe("Name to greet") },
      async ({ name }): Promise<CallToolResult> => {
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    this.server.tool(
      "getPropsTestValue",
      {},
      async (): Promise<CallToolResult> => {
        return {
          content: [{ text: this.props.testValue, type: "text" }]
        };
      }
    );
  }
}

// Test email agents
export class TestEmailAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];
  currentAgentContext: any = null;

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
    // Test getCurrentAgent context during email handling
    const context = getCurrentAgent();
    this.currentAgentContext = {
      hasAgent: !!context.agent,
      hasRequest: !!context.request,
      hasConnection: !!context.connection,
      hasEmail: !!context.email,
      agentType: context.agent ? context.agent.constructor.name : null,
      // Test actual email object behavior
      emailFrom: context.email ? context.email.from : null,
      emailTo: context.email ? context.email.to : null,
      emailHeadersAccess: context.email
        ? (() => {
            let headerCount = 0;
            context.email!.headers.forEach(() => headerCount++);
            return {
              messageId: context.email!.headers.get("Message-ID"),
              date: context.email!.headers.get("Date"),
              subject: context.email!.headers.get("Subject"),
              headerCount
            };
          })()
        : null,
      // Test that we get the actual agent instance
      agentInstanceTest: context.agent === this
    };
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export class TestCaseSensitiveAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export class TestUserNotificationAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // set some props that should be passed init
    ctx.props = {
      testValue: "123"
    };

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return TestMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return TestMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Email handler for test environment
  }
};
