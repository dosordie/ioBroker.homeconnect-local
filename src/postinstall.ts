import { spawn } from "node:child_process";

function runIoBroker(args: string[]): Promise<void> {
  return new Promise(resolve => {
    const child = spawn("iobroker", args, {
      stdio: "ignore",
      shell: process.platform === "win32",
    });

    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

async function main(): Promise<void> {
  // Best effort only: a failed upload/restart must never break npm installation.
  await runIoBroker(["upload", "homeconnect-local"]);
  await runIoBroker(["restart", "homeconnect-local"]);
}

setTimeout(() => {
  void main().catch(() => undefined);
}, 2000);
