import { jest } from "@jest/globals";

const createMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();

class FakeAnthropic {
  messages = { create: createMock };
  constructor(_opts: { apiKey: string }) {}
}

jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: FakeAnthropic,
}));

const { AnthropicAgentClient } = await import("../src/asc/llm-agent.js");

describe("AnthropicAgentClient", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("sends the role's system prompt and forces tool use, then parses the decision", async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "record_decision",
          input: { action: "route", target: "CTO", payload: "optimize now", reasoning: "cost is rising" },
        },
      ],
    });

    const client = new AnthropicAgentClient("fake-key");
    const decision = await client.decide("CEO", "some context");

    expect(decision).toEqual({
      action: "route",
      target: "CTO",
      payload: "optimize now",
      reasoning: "cost is rising",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const callArgs = createMock.mock.calls[0][0] as {
      system: string;
      tool_choice: { type: string; name: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(callArgs.system).toContain("CEO agent");
    expect(callArgs.tool_choice).toEqual({ type: "tool", name: "record_decision" });
    expect(callArgs.messages[0].content).toBe("some context");
  });

  it("throws if the model returns no tool_use block", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "I refuse to decide." }] });

    const client = new AnthropicAgentClient("fake-key");
    await expect(client.decide("QA", "context")).rejects.toThrow("returned no tool_use block");
  });

  it("throws if the model chooses route without a target", async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "record_decision",
          input: { action: "route", reasoning: "forgot the target" },
        },
      ],
    });

    const client = new AnthropicAgentClient("fake-key");
    await expect(client.decide("CTO", "context")).rejects.toThrow('chose action "route" without a target');
  });
});
