#!/usr/bin/env node
import { runAgentLauncher } from "./agent-launcher.js";

const [command, ...args] = process.argv.slice(2);

if (command !== "agent") {
  console.error("Usage: compactgate agent <codex|claude> [--url URL] [--profile ID] [-- AGENT_ARGS...].");
  process.exitCode = 2;
} else {
  try {
    process.exitCode = await runAgentLauncher(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
