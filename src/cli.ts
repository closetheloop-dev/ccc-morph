#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { defaultConfigPath, loadResolvedConfig, parseConfigText } from "./config";
import { ensureDefaults } from "./ensure-defaults";
import { inspectKey } from "./key-inspector";
import { TerminalSession } from "./session";

declare const APP_VERSION: string | undefined;
const VERSION = typeof APP_VERSION === "string" ? APP_VERSION : "dev";
const HELP = `ccc-morph ${VERSION}

A transparent PTY wrapper with configurable keyboard shortcuts.

Usage:
  ccc-morph [--config FILE | --no-config] [--app NAME] -- COMMAND [ARG...]
  ccc-morph --inspect-key
  ccc-morph --check-config FILE
  ccc-morph --ensure-defaults

Options:
  --config FILE      Use only this file as the configuration (no per-app discovery)
  --no-config        Do not discover or load any configuration
  --app NAME         Apply the named app's configuration file
  --inspect-key      Print the exact bytes sent by one key combination
  --check-config F   Validate a global config file; exit 0 if valid, non-zero if not
  --ensure-defaults  Add any missing default bindings to your global config
  -h, --help         Show this help
  -V, --version      Show the version
`;

type ParsedArguments = {
  configPath: string | null;
  configExplicit: boolean;
  appName: string | null;
  command: string[];
};

type CheckConfigRequest = { checkConfigPath: string };

export function parseArguments(
  args: string[],
): ParsedArguments | CheckConfigRequest | "help" | "version" | "inspect-key" | "ensure-defaults" {
  const separator = args.indexOf("--");
  const wrapperArgs = separator < 0 ? args : args.slice(0, separator);
  if (wrapperArgs.includes("--help") || wrapperArgs.includes("-h")) return "help";
  if (wrapperArgs.includes("--version") || wrapperArgs.includes("-V")) return "version";
  if (wrapperArgs.includes("--inspect-key")) {
    if (separator >= 0 || wrapperArgs.length !== 1) {
      throw new Error("--inspect-key cannot be combined with other arguments");
    }
    return "inspect-key";
  }
  if (wrapperArgs.includes("--check-config")) {
    if (separator >= 0 || wrapperArgs.length !== 2 || wrapperArgs[0] !== "--check-config") {
      throw new Error("--check-config takes only a file path and no other arguments");
    }
    const path = wrapperArgs[1];
    if (!path) throw new Error("--check-config requires a file path");
    return { checkConfigPath: path };
  }
  if (wrapperArgs.includes("--ensure-defaults")) {
    if (separator >= 0 || wrapperArgs.length !== 1) {
      throw new Error("--ensure-defaults cannot be combined with other arguments");
    }
    return "ensure-defaults";
  }

  if (separator < 0) throw new Error("missing -- before the wrapped command");
  const command = args.slice(separator + 1);
  if (command.length === 0) throw new Error("missing wrapped command after --");

  let configPath: string | null = defaultConfigPath();
  let configExplicit = false;
  let appName: string | null = null;
  for (let index = 0; index < wrapperArgs.length; index += 1) {
    const argument = wrapperArgs[index];
    if (argument === "--no-config") {
      if (configExplicit || appName !== null) {
        throw new Error("--no-config cannot be combined with --config or --app");
      }
      configPath = null;
      continue;
    }
    if (argument === "--config") {
      if (configPath === null) throw new Error("--config cannot be combined with --no-config");
      if (appName !== null) throw new Error("--config cannot be combined with --app");
      const value = wrapperArgs[++index];
      if (!value) throw new Error("--config requires a file path");
      configPath = value;
      configExplicit = true;
      continue;
    }
    if (argument === "--app") {
      if (configPath === null) throw new Error("--app cannot be combined with --no-config");
      if (configExplicit) throw new Error("--app cannot be combined with --config");
      if (appName !== null) throw new Error("--app may only be specified once");
      const value = wrapperArgs[++index];
      if (!value) throw new Error("--app requires an app name");
      appName = value;
      continue;
    }
    throw new Error(`unknown wrapper option: ${argument}`);
  }

  return { configPath, configExplicit, appName, command };
}

// Without a PTY on both stdin and stdout the wrapper cannot intercept keys, so
// run the child transparently: inherit stdio, forward termination signals, and
// propagate its exit code. No configuration is consulted in this path.
async function passthrough(command: string[]): Promise<number> {
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (error) {
    process.stderr.write(
      `ccc-morph: ${command[0]}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 127;
  }

  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
  for (const signal of signals) process.on(signal, forward);
  try {
    return await child.exited;
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
}

// Validate a global config file without launching anything: exit 0 when it
// parses (including duplicate-encoding checks), non-zero with a message when not.
function checkConfig(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(
      `ccc-morph: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  try {
    parseConfigText(text, path);
  } catch (error) {
    process.stderr.write(`ccc-morph: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  return 0;
}

// Add any missing default bindings to the global config, preserving what is there.
function ensureDefaultsCli(): number {
  const result = ensureDefaults(defaultConfigPath());
  if (result.error !== undefined) {
    process.stderr.write(`ccc-morph: ${result.error}\n`);
    return 2;
  }
  if (result.created) process.stdout.write(`created ${result.path}\n`);
  for (const binding of result.added) {
    process.stdout.write(`added ${binding.keys.join(" ")} (${binding.actionType})\n`);
  }
  for (const { binding, reason } of result.skipped) {
    // "action-bound" is silent: the feature is already available on some key.
    if (reason === "keys-in-use") {
      process.stdout.write(
        `skipped ${binding.keys.join(" ")} (${binding.actionType}): those keys are already in use\n`,
      );
    }
  }
  if (!result.created && result.added.length === 0) {
    process.stdout.write(`${result.path} already has the default bindings\n`);
  }
  return 0;
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed === "inspect-key") return inspectKey();
  if (parsed === "ensure-defaults") return ensureDefaultsCli();
  if ("checkConfigPath" in parsed) return checkConfig(parsed.checkConfigPath);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return passthrough(parsed.command);
  }

  const resolved = loadResolvedConfig(
    parsed.configPath,
    parsed.configExplicit,
    parsed.command,
    parsed.appName,
  );
  return new TerminalSession(resolved, parsed.command).run();
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`ccc-morph: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
