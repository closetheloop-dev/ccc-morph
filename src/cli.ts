#!/usr/bin/env bun

import { defaultConfigPath, loadResolvedConfig } from "./config";
import { inspectKey } from "./key-inspector";
import { TerminalSession } from "./session";

declare const APP_VERSION: string | undefined;
const VERSION = typeof APP_VERSION === "string" ? APP_VERSION : "dev";
const HELP = `ccc-morph ${VERSION}

A transparent PTY wrapper with configurable keyboard shortcuts.

Usage:
  ccc-morph [--config FILE | --no-config] [--app NAME] -- COMMAND [ARG...]
  ccc-morph --inspect-key

Options:
  --config FILE  Use only this file as the configuration (no per-app discovery)
  --no-config    Do not discover or load any configuration
  --app NAME     Apply the named app's configuration file
  --inspect-key  Print the exact bytes sent by one key combination
  -h, --help     Show this help
  -V, --version  Show the version
`;

type ParsedArguments = {
  configPath: string | null;
  configExplicit: boolean;
  appName: string | null;
  command: string[];
};

export function parseArguments(
  args: string[],
): ParsedArguments | "help" | "version" | "inspect-key" {
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
