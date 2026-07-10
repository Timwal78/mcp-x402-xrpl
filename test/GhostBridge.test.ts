import { jest } from "@jest/globals";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
const execFileMock = jest.fn<(bin: string, args: string[], options: unknown, callback: ExecFileCallback) => void>();

jest.unstable_mockModule("node:child_process", () => ({
  execFile: execFileMock,
}));

const { SMLGhostLegacyBridge } = await import("../src/bridges/SMLGhostLegacyBridge.js");

describe("SMLGhostLegacyBridge", () => {
  const sandbox = "/tmp/sml-ghost-bridge-test-sandbox";

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("rejects parameters containing shell metacharacters without ever invoking execFile", async () => {
    const bridge = new SMLGhostLegacyBridge(sandbox);
    const result = await bridge.executeLegacyBridge({
      targetSystemId: "LEGACY-01",
      action: "READ_RECORD",
      parameters: { recordId: "1; rm -rf /" },
    });

    expect(result.success).toBe(false);
    expect(result.sysLogSummary).toContain("LEGACY_STREAM_READ_ERROR");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects binaries outside the configured whitelist", async () => {
    const bridge = new SMLGhostLegacyBridge(sandbox, ["read_terminal_buffer"]);
    const result = await bridge.executeLegacyBridge({
      targetSystemId: "LEGACY-01",
      action: "READ_RECORD",
      parameters: { recordId: "42" },
    });

    expect(result.success).toBe(false);
    expect(result.data).toContain("Unauthorized command invocation");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("parses CSV stdout into structured records on success", async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(null, "id,name\n42,widget\n", "");
    });

    const bridge = new SMLGhostLegacyBridge(sandbox);
    const result = await bridge.executeLegacyBridge({
      targetSystemId: "LEGACY-01",
      action: "READ_RECORD",
      parameters: { recordId: "42" },
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ records: [{ id: "42", name: "widget" }] });
    expect(execFileMock).toHaveBeenCalledWith(
      "query_legacy_db",
      ["--id", "42", "--format", "csv"],
      expect.objectContaining({ cwd: expect.any(String) }),
      expect.any(Function)
    );
  });

  it("surfaces execFile failures as a failed response instead of throwing", async () => {
    execFileMock.mockImplementation((_bin, _args, _options, callback) => {
      callback(new Error("binary not found"), "", "");
    });

    const bridge = new SMLGhostLegacyBridge(sandbox);
    const result = await bridge.executeLegacyBridge({
      targetSystemId: "LEGACY-01",
      action: "RUN_MACRO",
      parameters: { macroName: "close_ticket" },
    });

    expect(result.success).toBe(false);
    expect(result.data).toContain("binary not found");
  });
});
