import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { env } from "./env";
import { warn } from "./logger";
import type { ActionName } from "./interactive-actions";

interface DecideResponseActionsInput {
  prompt: string;
  response: string;
  model: string;
  provider: string;
  timeoutMs: number;
}

const ACTIONS: ActionName[] = ["regen", "short", "deep"];
const ACTION_SET = new Set<ActionName>(ACTIONS);

const ACTION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "string",
        enum: ACTIONS,
      },
      uniqueItems: true,
      maxItems: 3,
    },
  },
  required: ["actions"],
} as const;

function buildDecisionPrompt(prompt: string, response: string): string {
  return [
    "Choose follow-up actions that would materially improve user value for this specific turn.",
    "",
    "Allowed actions:",
    '- "regen": alternate full answer',
    '- "short": concise rewrite',
    '- "deep": deeper practical detail',
    "",
    "Rules:",
    "- Output MUST be a strict JSON object matching the provided schema.",
    "- Do not output any explanatory text.",
    "- Include only actions that are genuinely useful right now.",
    "",
    "User prompt:",
    prompt,
    "",
    "Assistant response:",
    response,
  ].join("\n");
}

function validateDecisionShape(value: unknown): ActionName[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Decision output is not an object");
  }

  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "actions") {
    throw new Error("Decision output contains unexpected properties");
  }

  if (!Array.isArray(payload.actions)) {
    throw new Error("Decision output actions is not an array");
  }

  const actions: ActionName[] = [];
  const seen = new Set<ActionName>();
  for (const item of payload.actions) {
    if (typeof item !== "string" || !ACTION_SET.has(item as ActionName)) {
      throw new Error(`Unsupported action value: ${String(item)}`);
    }
    const action = item as ActionName;
    if (seen.has(action)) {
      throw new Error("Decision output actions contains duplicates");
    }
    seen.add(action);
    actions.push(action);
  }

  if (actions.length > 3) {
    throw new Error("Decision output actions exceeds max size");
  }

  return actions;
}

function runProcess(
  bin: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill("SIGKILL");
      reject(new Error(`Decision process timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      reject(err);
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (code !== 0) {
        reject(
          new Error(
            `Decision process exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function decideWithClaude(input: DecideResponseActionsInput): Promise<ActionName[]> {
  const prompt = buildDecisionPrompt(input.prompt, input.response);
  const schemaJson = JSON.stringify(ACTION_DECISION_SCHEMA);
  const filteredEnv = { ...process.env };
  delete filteredEnv.CLAUDECODE;
  delete filteredEnv.CLAUDE_CODE_ENTRYPOINT;
  delete filteredEnv.INIT_CWD;
  delete filteredEnv.PWD;
  delete filteredEnv.OLDPWD;

  const result = await runProcess(
    env.CLAUDE_BIN,
    [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      schemaJson,
      "--model",
      input.model,
      "--no-session-persistence",
      "--tools",
      "",
      prompt,
    ],
    { cwd: env.TG_WORKING_DIR, timeoutMs: input.timeoutMs, env: filteredEnv }
  );

  const parsed = JSON.parse(result.stdout);
  return validateDecisionShape(parsed);
}

async function decideWithCodex(input: DecideResponseActionsInput): Promise<ActionName[]> {
  const tempDir = mkdtempSync(join(tmpdir(), "tg-action-advisor-"));
  const schemaPath = join(tempDir, "schema.json");
  const outputPath = join(tempDir, "output.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(ACTION_DECISION_SCHEMA), "utf-8");

    await runProcess(
      env.CODEX_BIN,
      [
        "exec",
        "--model",
        input.model,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--ephemeral",
        "--skip-git-repo-check",
        buildDecisionPrompt(input.prompt, input.response),
      ],
      { cwd: env.TG_WORKING_DIR, timeoutMs: input.timeoutMs }
    );

    const raw = readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateDecisionShape(parsed);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function decideResponseActions(
  input: DecideResponseActionsInput
): Promise<ActionName[]> {
  try {
    if (input.provider === "claude-cli") {
      return await decideWithClaude(input);
    }
    if (input.provider === "codex-cli") {
      return await decideWithCodex(input);
    }
    warn("action-advisor", "unsupported_provider", { provider: input.provider });
    return [];
  } catch (err) {
    warn("action-advisor", "decision_failed", {
      provider: input.provider,
      model: input.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

