import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import { Agent, type AgentEmail, unstable_callable } from "../index.ts";

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

    // For root path POST requests, check if it's an RPC message
    if (url.pathname === "/" && request.method === "POST") {
      try {
        await request.json();
        // Let the parent class handle RPC messages
        return super.onRequest(request);
      } catch {
        // If not JSON, fall through to default response
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

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  // Override onError to avoid console.error which triggers queueMicrotask issues
  override onError(error: unknown): void {
    // Silently handle errors in tests
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
    // Bring this in when we write tests for the complete email handler flow
  }
};
