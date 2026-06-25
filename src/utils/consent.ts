import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { display } from "./display.js";

const CONFIG_DIR = join(homedir(), ".kodwai");
const CONSENT_FILE = join(CONFIG_DIR, "consent.json");

interface ConsentRecord {
  accepted: boolean;
  accepted_at: string;
  version: string;
}

const CONSENT_VERSION = "1.0";

export async function hasConsented(): Promise<boolean> {
  try {
    const data = JSON.parse(await readFile(CONSENT_FILE, "utf-8")) as ConsentRecord;
    return data.accepted && data.version === CONSENT_VERSION;
  } catch {
    return false;
  }
}

async function saveConsent(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const record: ConsentRecord = {
    accepted: true,
    accepted_at: new Date().toISOString(),
    version: CONSENT_VERSION,
  };
  await writeFile(CONSENT_FILE, JSON.stringify(record, null, 2), "utf-8");
}

export async function ensureConsent(): Promise<void> {
  if (await hasConsented()) return;

  console.log("");
  display.divider();
  console.log("");
  console.log("  " + "DATA COLLECTION NOTICE");
  console.log("");
  console.log("  When you submit a challenge, kodwai collects:");
  console.log("");
  console.log("    1. Code files from the challenge workspace ONLY");
  console.log("    2. Git history from the challenge workspace ONLY");
  console.log("    3. AI agent traces from THIS challenge session ONLY");
  console.log("       (scoped by workspace path and start time)");
  console.log("    4. Test results run locally on your machine");
  console.log("");
  console.log("  kodwai does NOT access:");
  console.log("");
  console.log("    - Files outside the challenge directory");
  console.log("    - AI conversations from other projects");
  console.log("    - Your API keys, passwords, or credentials");
  console.log("    - Any data from before the challenge started");
  console.log("");
  console.log("  Your data is encrypted in transit (TLS) and at rest.");
  console.log("  You can delete your submission data at any time.");
  console.log("  The CLI is open source: github.com/kodwai/cli");
  console.log("");
  display.divider();
  console.log("");

  const answer = await promptConfirm("  I understand, continue (y/n): ");
  if (!answer) {
    console.log("");
    display.info("You can review the CLI source code at github.com/kodwai/cli");
    display.info("Run the command again when you're ready.");
    process.exit(0);
  }

  await saveConsent();
  console.log("");
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}
