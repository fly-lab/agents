import { expect, describe, it } from "vitest";
import {
  Agent,
  getAgentByName,
  routeAgentRequest,
  unstable_callable,
  getCurrentAgent
} from "../index.ts";

describe("Agent", () => {
  describe("getAgentByName", () => {});
  describe("routeAgentRequest", () => {});
  describe("rpc", () => {});
  describe("scheduling", () => {});
  describe("queueing", () => {});
  describe("getCurrentAgent", () => {});
  describe("o11y", () => {});
  describe(".state", () => {});
  describe("email", () => {});
});

// getAgentByName should return an agent with specified name
// routeAgentRequest should route a request to an agent
// - with defaults
// - with options
// routeAgentRequest should route a websocket request to an agent
// - with defaults
// - with options

// rpc tests

// scheduling

// queueing

// getCurrentAgent
// - agent, request, connection, email

// o11y

// .state

// email

// onError should catch errors
// onError should catch websocket errors

// .destroy()
