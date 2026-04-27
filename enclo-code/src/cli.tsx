#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./app.js";
import { createConfigStore } from "./config.js";
import { runJsonRpcServer } from "./rpc/server.js";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("enclo")
    .description("On-prem LLM CLI for the enclo server.")
    .option(
      "--config-dir <path>",
      "override the config directory (default: ~/.enclo)",
    )
    .option(
      "--json-rpc",
      "run as a headless JSON-RPC stdio server (LSP-style framing)",
    )
    .option(
      "--rpc-config-file <path>",
      "with --json-rpc: persist auth tokens to this file (default: in-memory only)",
    )
    .version("0.1.0");
  program.parse();
  const opts = program.opts<{
    configDir?: string;
    jsonRpc?: boolean;
    rpcConfigFile?: string;
  }>();

  if (opts.jsonRpc) {
    const code = await runJsonRpcServer({
      ...(opts.rpcConfigFile ? { configFilePath: opts.rpcConfigFile } : {}),
    });
    process.exit(code);
  }

  const config = createConfigStore(
    opts.configDir ? { dir: opts.configDir } : {},
  );

  const { waitUntilExit } = render(<App config={config} />);
  await waitUntilExit();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
