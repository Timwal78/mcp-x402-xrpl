import { jest } from "@jest/globals";

type TxResult = { hash: string; wait: () => Promise<unknown> };

const bondMethods = {
  processRevenue: jest.fn<(...args: unknown[]) => Promise<TxResult>>(),
  isFundingClosed: jest.fn<() => Promise<boolean>>(),
  totalRaised: jest.fn<() => Promise<bigint>>(),
};

// Deliberately does NOT re-import the real `ethers` package here — dynamically
// importing the same large (WASM-crypto-backed) module a mock factory is
// meant to replace turned out to be unstable under Jest's experimental VM
// modules (reproducible heap-OOM crash). These are minimal, self-contained
// stand-ins for exactly the four ethers exports the orchestrator uses.
jest.unstable_mockModule("ethers", () => {
  class FakeProvider {
    constructor(_url: string) {}
  }
  class FakeWallet {
    address = "0xFAKE0000000000000000000000000000000000";
    constructor(_key: string, _provider: unknown) {}
  }
  class FakeContract {
    constructor(_address: string, _abi: unknown, _signer: unknown) {
      // Constructors may return an object to override the instance — every
      // `new Contract(...)` call in the orchestrator gets this same
      // controllable mock instead of a real signer/provider round trip.
      return bondMethods;
    }
  }

  function parseUnits(value: string, decimals: number): bigint {
    const [whole, frac = ""] = value.split(".");
    const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
  }

  function formatUnits(value: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    let frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    if (frac === "") frac = "0";
    return `${whole.toString()}.${frac}`;
  }

  function hexlify(bytes: Uint8Array): string {
    return "0x" + Buffer.from(bytes).toString("hex");
  }

  function randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  // The orchestrator does `import { ethers } from "ethers"` — v6's actual
  // shape is a single named `ethers` export bundling everything, not
  // individual top-level named exports. Match that shape here.
  return {
    ethers: {
      JsonRpcProvider: FakeProvider,
      Wallet: FakeWallet,
      Contract: FakeContract,
      parseUnits,
      formatUnits,
      hexlify,
      randomBytes,
    },
  };
});

const { SMLAgentSwarmOrchestrator } = await import("../src/asc/SMLAgentSwarmOrchestrator.js");
type LlmAgentClient = import("../src/asc/llm-agent.js").LlmAgentClient;
type AgentDecision = import("../src/asc/llm-agent.js").AgentDecision;
type AgentRole = import("../src/asc/SMLAgentSwarmOrchestrator.js").AgentRole;

function makeOrchestrator(llmClient?: LlmAgentClient) {
  return new SMLAgentSwarmOrchestrator("https://fake-rpc", "0xfakeprivatekey", "0xfakebond", llmClient);
}

describe("SMLAgentSwarmOrchestrator — deterministic mode (no llmClient)", () => {
  beforeEach(() => {
    bondMethods.processRevenue.mockReset();
    bondMethods.isFundingClosed.mockReset();
    bondMethods.totalRaised.mockReset();
  });

  it("routes CEO -> CTO when CFO reports insufficient funds", async () => {
    const orchestrator = makeOrchestrator();
    await orchestrator.routeSecureMessage({
      sender: "CFO",
      recipient: "CEO",
      payload: "INSUFFICIENT_FUNDS_FOR_HOSTING",
    });

    const history = orchestrator.getMessageHistory();
    const routedToCto = history.find((m) => m.sender === "CEO" && m.recipient === "CTO");
    expect(routedToCto).toBeDefined();
    expect(routedToCto?.payload).toContain("CRITICAL");
  });

  it("calls processRevenue with the parsed amount for a well-formed revenue message", async () => {
    bondMethods.processRevenue.mockResolvedValue({ hash: "0xdeadbeef", wait: async () => undefined });

    const orchestrator = makeOrchestrator();
    await orchestrator.routeSecureMessage({
      sender: "CTO",
      recipient: "CFO",
      payload: `PROCESS_INCOMING_REVENUE:${JSON.stringify({ amount: 12.5 })}`,
    });

    expect(bondMethods.processRevenue).toHaveBeenCalledTimes(1);
    const [amountArg] = bondMethods.processRevenue.mock.calls[0] as [bigint];
    expect(amountArg).toBe(12_500_000n); // 12.5 at 6 decimals
  });

  it("rejects a malformed revenue payload without calling processRevenue", async () => {
    const orchestrator = makeOrchestrator();
    await orchestrator.routeSecureMessage({
      sender: "CTO",
      recipient: "CFO",
      payload: `PROCESS_INCOMING_REVENUE:not-json`,
    });

    expect(bondMethods.processRevenue).not.toHaveBeenCalled();
  });
});

describe("SMLAgentSwarmOrchestrator — LLM mode", () => {
  beforeEach(() => {
    bondMethods.processRevenue.mockReset();
    bondMethods.isFundingClosed.mockReset();
    bondMethods.totalRaised.mockReset();
  });

  function fakeLlm(decide: (role: AgentRole, context: string) => Promise<AgentDecision>): LlmAgentClient {
    return { decide };
  }

  it("routes according to the LLM's decision instead of string-matching", async () => {
    const decide = jest.fn(async (_role: AgentRole, _context: string): Promise<AgentDecision> => ({
      action: "route",
      target: "CTO",
      payload: "please optimize the hot path",
      reasoning: "compute cost is trending up",
    }));

    const orchestrator = makeOrchestrator(fakeLlm(decide));
    await orchestrator.routeSecureMessage({
      sender: "CFO",
      recipient: "CEO",
      payload: "this text would never match the deterministic rules",
    });

    const history = orchestrator.getMessageHistory();
    const routedToCto = history.find((m) => m.sender === "CEO" && m.recipient === "CTO");
    expect(routedToCto?.payload).toBe("please optimize the hot path");
    expect(decide).toHaveBeenCalledWith("CEO", expect.any(String));
  });

  it("only calls processRevenue when the LLM's decision is process_revenue, using the message's real amount", async () => {
    bondMethods.processRevenue.mockResolvedValue({ hash: "0xabc123", wait: async () => undefined });
    const decide = jest.fn(async (): Promise<AgentDecision> => ({
      action: "process_revenue",
      reasoning: "amount looks legitimate",
    }));

    const orchestrator = makeOrchestrator(fakeLlm(decide));
    await orchestrator.routeSecureMessage({
      sender: "CTO",
      recipient: "CFO",
      payload: `PROCESS_INCOMING_REVENUE:${JSON.stringify({ amount: 7 })}`,
    });

    expect(bondMethods.processRevenue).toHaveBeenCalledTimes(1);
    const [amountArg] = bondMethods.processRevenue.mock.calls[0] as [bigint];
    expect(amountArg).toBe(7_000_000n);
  });

  it("does NOT call processRevenue when the LLM decides no_action, even with a valid amount", async () => {
    const decide = jest.fn(async (): Promise<AgentDecision> => ({
      action: "no_action",
      reasoning: "amount looks anomalously large relative to history",
    }));

    const orchestrator = makeOrchestrator(fakeLlm(decide));
    await orchestrator.routeSecureMessage({
      sender: "CTO",
      recipient: "CFO",
      payload: `PROCESS_INCOMING_REVENUE:${JSON.stringify({ amount: 999999 })}`,
    });

    expect(bondMethods.processRevenue).not.toHaveBeenCalled();
  });

  it("throws from startAutonomousCeoLoop when constructed without an llmClient", () => {
    const orchestrator = makeOrchestrator();
    expect(() => orchestrator.startAutonomousCeoLoop(1000)).toThrow("requires an LlmAgentClient");
  });

  it("autonomous loop reads on-chain state and acts on the CEO's decision each tick", async () => {
    jest.useFakeTimers();
    bondMethods.isFundingClosed.mockResolvedValue(true);
    bondMethods.totalRaised.mockResolvedValue(500_000_000n); // 500 tokens at 6 decimals

    const decide = jest.fn(async (_role: AgentRole, context: string): Promise<AgentDecision> => {
      expect(context).toContain("isFundingClosed=true");
      expect(context).toContain("500.0");
      return { action: "no_action", reasoning: "all healthy" };
    });

    const orchestrator = makeOrchestrator(fakeLlm(decide));
    orchestrator.startAutonomousCeoLoop(1000);

    await jest.advanceTimersByTimeAsync(1000);

    expect(decide).toHaveBeenCalledTimes(1);
    orchestrator.stopAutonomousCeoLoop();
    jest.useRealTimers();
  });
});
