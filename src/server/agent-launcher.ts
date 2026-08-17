import { spawn, type ChildProcess } from "node:child_process";
import { validateHeaderValue } from "node:http";

export type AgentKind = "codex" | "claude";

export interface AgentLaunchPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface AgentLaunchOptions {
  serverUrl?: string;
  profileId?: string;
  args?: readonly string[];
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ParsedAgentCommand {
  kind: AgentKind;
  options: Omit<AgentLaunchOptions, "args">;
  args: string[];
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:7865";
const CODEX_PROVIDER_ID = "compactgate";

export function buildAgentLaunchPlan(
  kind: AgentKind,
  options: AgentLaunchOptions = {}
): AgentLaunchPlan {
  return kind === "codex"
    ? buildCodexLaunch(options)
    : buildClaudeLaunch(options);
}

export function buildCodexLaunch(options: AgentLaunchOptions = {}): AgentLaunchPlan {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? process.env.COMPACTGATE_URL);
  const profileId = validateProfileId(options.profileId);
  const profileHeader = profileId
    ? `, http_headers = { "x-compactgate-profile" = ${tomlString(profileId)} }`
    : "";
  const provider = [
    `name = ${tomlString("OpenAI")}`,
    `base_url = ${tomlString(joinGatewayPath(serverUrl, "v1"))}`,
    `wire_api = ${tomlString("responses")}`,
    "requires_openai_auth = false",
    profileHeader.slice(2)
  ].filter(Boolean).join(", ");

  return {
    command: options.command ?? "codex",
    args: [
      "-c",
      `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
      "-c",
      `model_providers.${CODEX_PROVIDER_ID} = { ${provider} }`,
      ...(options.args ?? [])
    ],
    env: { ...options.env ?? process.env }
  };
}

export function buildClaudeLaunch(options: AgentLaunchOptions = {}): AgentLaunchPlan {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? process.env.COMPACTGATE_URL);
  const profileId = validateProfileId(options.profileId);
  const settingsEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: joinGatewayPath(serverUrl, "anthropic"),
    ANTHROPIC_AUTH_TOKEN: "compactgate-local"
  };
  if (profileId) {
    settingsEnv.ANTHROPIC_CUSTOM_HEADERS = `x-compactgate-profile: ${profileId}`;
  }

  const env = { ...options.env ?? process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_CUSTOM_HEADERS;

  return {
    command: options.command ?? "claude",
    args: ["--settings", JSON.stringify({ env: settingsEnv }), ...(options.args ?? [])],
    env
  };
}

export function parseAgentCommand(argv: readonly string[]): ParsedAgentCommand {
  const kind = argv[0];
  if (kind !== "codex" && kind !== "claude") {
    throw new Error("Usage: compactgate agent <codex|claude> [--url URL] [--profile ID] [-- AGENT_ARGS...].");
  }

  let serverUrl: string | undefined;
  let profileId: string | undefined;
  const args: string[] = [];
  let index = 1;
  while (index < argv.length) {
    const value = argv[index];
    if (value === "--") {
      args.push(...argv.slice(index + 1));
      break;
    }
    const match = /^--(url|profile)(?:=(.*))?$/.exec(value);
    if (match) {
      const next = match[2] ?? argv[index + 1];
      if (!next) {
        throw new Error(`--${match[1]} requires a value.`);
      }
      if (match[1] === "url") {
        serverUrl = next;
      } else {
        profileId = next;
      }
      index += match[2] === undefined ? 2 : 1;
      continue;
    }
    args.push(...argv.slice(index));
    break;
  }

  return {
    kind,
    options: { serverUrl, profileId },
    args
  };
}

export async function runAgentLauncher(
  argv: readonly string[],
  spawnProcess: typeof spawn = spawn
): Promise<number> {
  const parsed = parseAgentCommand(argv);
  const plan = buildAgentLaunchPlan(parsed.kind, {
    ...parsed.options,
    args: parsed.args
  });
  return waitForChild(spawnProcess(plan.command, plan.args, {
    env: plan.env,
    stdio: "inherit"
  }));
}

function normalizeServerUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CompactGate URL must be an absolute http or https URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("CompactGate URL must be an http or https URL without credentials, query, or hash.");
  }
  parsed.pathname = parsed.pathname.replace(/\/(?:v1|anthropic)\/?$/, "").replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function joinGatewayPath(serverUrl: string, suffix: string): string {
  return `${serverUrl}/${suffix}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function validateProfileId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || value !== value.trim() || value.length > 256) {
    throw new Error("CompactGate profile ID must be 1-256 characters without surrounding whitespace.");
  }
  try {
    validateHeaderValue("x-compactgate-profile", value);
  } catch {
    throw new Error("CompactGate profile ID is not a valid HTTP header value.");
  }
  return value;
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
      const handler = () => {
        if (child.exitCode === null) {
          child.kill(signal);
        }
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    const cleanup = () => {
      for (const [forwardedSignal, handler] of handlers) {
        process.off(forwardedSignal, handler);
      }
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + signalNumber(signal) : 1));
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as Record<NodeJS.Signals, number>)[signal] ?? 1;
}
