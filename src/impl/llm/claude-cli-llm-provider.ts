import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../interfaces/llm-provider.js";
import type { SecretStore } from "../../interfaces/secret-store.js";
import { runProcess } from "../process/run-process.js";
import { buildAgentEnv, harnessCredential } from "../runner/claude-code-runner.js";

/** Anthropic via the Claude Code CLI on the subscription login (D2). No tools, one turn. */
export class ClaudeCliLLMProvider implements LLMProvider {
  constructor(
    private readonly opts: {
      secrets: SecretStore;
      claudeConfigDir: string;
      workDir: string;
      models: { cheap: string; standard: string; strong: string };
      claudeBin?: string;
    },
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: null as number | null };
    if (req.data_env === "prod") return { text: "", stop_reason: "refused", usage };

    await mkdir(join(this.opts.workDir, "tmp"), { recursive: true });
    const env = buildAgentEnv({ env_allowlist: {} }, await harnessCredential(this.opts.secrets), {
      home: this.opts.workDir,
      claudeConfigDir: this.opts.claudeConfigDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
    });
    const prompt = req.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
    const args = [
      this.opts.claudeBin ?? "claude", "-p",
      "--output-format", "json",
      "--tools", "",
      "--setting-sources", "project",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", this.opts.models[req.model_class],
      ...(req.system ? ["--system-prompt", req.system] : []),
      ...(req.output_schema ? ["--json-schema", JSON.stringify(req.output_schema)] : []),
    ];
    const r = await runProcess(args, {
      cwd: this.opts.workDir,
      env,
      stdin: prompt,
      ...(req.signal !== undefined && { signal: req.signal }),
    });
    try {
      const out = JSON.parse(r.stdout) as {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      usage.input_tokens = out.usage?.input_tokens ?? 0;
      usage.output_tokens = out.usage?.output_tokens ?? 0;
      usage.cost_usd = out.total_cost_usd ?? null;
      return {
        text: out.result ?? "",
        ...(out.structured_output !== undefined && { parsed: out.structured_output }),
        stop_reason: out.is_error ? "error" : "end",
        usage,
      };
    } catch {
      return { text: "", stop_reason: "error", usage };
    }
  }
}
