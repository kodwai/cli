import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const CONFIG_DIR = join(homedir(), ".kodwai");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface StoredConfig {
  token?: string;
  api_url?: string;
}

async function readConfig(): Promise<StoredConfig> {
  try {
    const data = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeConfig(config: StoredConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export async function getStoredToken(): Promise<string | null> {
  const config = await readConfig();
  return config.token || null;
}

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Simple hidden input — write question, read without echo
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);
      let input = "";
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r") {
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.close();
          resolve(input);
        } else if (c === "\u0003") {
          // Ctrl+C
          rl.close();
          process.exit(1);
        } else if (c === "\u007f" || c === "\b") {
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

export async function ensureAuth(baseUrl: string): Promise<string> {
  // Check stored token
  const stored = await getStoredToken();
  if (stored) {
    // Verify token is still valid
    try {
      const resp = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${stored}` },
      });
      if (resp.ok) return stored;
    } catch {
      // Token invalid or network error
    }
  }

  // Need to login
  console.log("\n  Please log in to your kodwai account:\n");
  const email = await prompt("  Email: ");
  const password = await prompt("  Password: ", true);

  const resp = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: "Login failed" }));
    throw new Error(err.detail || "Login failed");
  }

  const data = await resp.json();
  const token = data.access_token;

  await writeConfig({ token, api_url: baseUrl });
  console.log("  Logged in successfully!\n");

  return token;
}

export function promptChoice(question: string, choices: string[]): Promise<number> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n  ${question}\n`);
    choices.forEach((c, i) => console.log(`    ${i + 1}) ${c}`));
    console.log("");
    rl.question("  Choice: ", (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(idx);
      } else {
        resolve(0); // Default to first
      }
    });
  });
}
