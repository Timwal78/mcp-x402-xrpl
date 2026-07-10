import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type LegacyAction = "READ_RECORD" | "WRITE_RECORD" | "RUN_MACRO";

export interface LegacyQueryRequest {
  targetSystemId: string;
  action: LegacyAction;
  parameters: Record<string, string>;
}

export interface LegacyQueryResponse {
  success: boolean;
  data: Record<string, unknown> | string;
  executionTimeMs: number;
  sysLogSummary: string;
}

const SAFE_PARAM = /^[a-zA-Z0-9_\-.\/]+$/;

function requireParam(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (value === undefined) {
    throw new Error(`Missing required parameter "${key}"`);
  }
  if (!SAFE_PARAM.test(value)) {
    throw new Error(`CRITICAL: shell security violation in parameter "${key}": "${value}"`);
  }
  return value;
}

interface ActionSpec {
  bin: string;
  buildArgs: (params: Record<string, string>) => string[];
}

const ACTION_COMMANDS: Record<LegacyAction, ActionSpec> = {
  READ_RECORD: {
    bin: "query_legacy_db",
    buildArgs: (p) => ["--id", requireParam(p, "recordId"), "--format", "csv"],
  },
  WRITE_RECORD: {
    bin: "query_legacy_db",
    buildArgs: (p) => ["--id", requireParam(p, "recordId"), "--write", requireParam(p, "value")],
  },
  RUN_MACRO: {
    bin: "send_terminal_keypress",
    buildArgs: (p) => ["--macro", requireParam(p, "macroName"), "--delay", "100"],
  },
};

function runExecFile(
  bin: string,
  args: string[],
  options: { cwd: string; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/**
 * Bridges an ASC to a legacy, un-API'd system by shelling out to a fixed
 * whitelist of binaries with an argv array — never a shell string — so
 * there is no injection surface even though parameters come from an
 * incoming (potentially agent-controlled) x402 request.
 */
export class SMLGhostLegacyBridge {
  private readonly sandboxPath: string;
  private readonly allowedBinaries: ReadonlySet<string>;

  constructor(
    sandboxPath: string,
    allowedBinaries: string[] = [
      "query_legacy_db",
      "read_terminal_buffer",
      "send_terminal_keypress",
      "scrape_terminal_screen",
    ]
  ) {
    this.sandboxPath = path.resolve(sandboxPath);
    fs.mkdirSync(this.sandboxPath, { recursive: true });
    this.allowedBinaries = new Set(allowedBinaries);
  }

  public async executeLegacyBridge(request: LegacyQueryRequest): Promise<LegacyQueryResponse> {
    const startTime = Date.now();
    console.log(`[Ghost Bridge] Interfacing with Legacy System ID: ${request.targetSystemId} for action: ${request.action}`);

    try {
      const spec = ACTION_COMMANDS[request.action];
      if (!spec) {
        throw new Error(`Unsupported legacy action: ${request.action}`);
      }
      if (!this.allowedBinaries.has(spec.bin)) {
        throw new Error(`Unauthorized command invocation: ${spec.bin}`);
      }

      const args = spec.buildArgs(request.parameters);
      const { stdout, stderr } = await runExecFile(spec.bin, args, { cwd: this.sandboxPath, timeout: 5000 });
      if (stderr.trim().length > 0) {
        console.warn(`[Ghost Bridge] stderr: ${stderr}`);
      }

      return {
        success: true,
        data: this.parseLegacyData(stdout),
        executionTimeMs: Date.now() - startTime,
        sysLogSummary: "LEGACY_STREAM_READ_SUCCESS",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Ghost Bridge] [FAIL] Execution failed for System ${request.targetSystemId}:`, message);
      return {
        success: false,
        data: message,
        executionTimeMs: Date.now() - startTime,
        sysLogSummary: `LEGACY_STREAM_READ_ERROR: ${message}`,
      };
    }
  }

  private parseLegacyData(rawInput: string): Record<string, unknown> | string {
    const lines = rawInput.trim().split("\n").filter((line) => line.length > 0);
    if (lines.length <= 1) {
      return { rawOutput: rawInput.trim() };
    }

    const headers = lines[0].split(",").map((h) => h.trim());
    const records = lines.slice(1).map((line) => {
      const values = line.split(",").map((v) => v.trim());
      const entry: Record<string, string | null> = {};
      headers.forEach((header, i) => {
        entry[header] = values[i] ?? null;
      });
      return entry;
    });

    return { records };
  }
}
