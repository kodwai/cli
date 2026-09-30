import { createInterface } from "node:readline";

/** True when we can ask the user something (stdin and stdout are a terminal). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask one question and return the trimmed answer. Resolves "" if stdin closes (Ctrl+D, piped input). */
export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("close", () => {
      if (!answered) resolve("");
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Yes/no question. Enter takes the default. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const answer = (await ask(question)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/**
 * Numbered menu. Accepts the number or (a prefix of) the option's label/alias.
 * Re-asks on anything else instead of silently picking the first option.
 */
export async function choose(question: string, options: { label: string; aliases?: string[] }[]): Promise<number> {
  console.log(`\n  ${question}\n`);
  options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
  console.log("");
  for (let tries = 0; tries < 5; tries++) {
    const raw = (await ask("  Choice: ")).toLowerCase();
    const idx = matchChoice(raw, options);
    if (idx !== null) return idx;
    if (!raw && !isInteractive()) break;
    console.log(`  Type a number from 1 to ${options.length}.`);
  }
  throw new Error("No choice made.");
}

/** Resolve a typed answer to an option index, or null. Exported for tests. */
export function matchChoice(raw: string, options: { label: string; aliases?: string[] }[]): number | null {
  const answer = raw.trim().toLowerCase();
  if (!answer) return null;
  const n = Number.parseInt(answer, 10);
  if (String(n) === answer) return n >= 1 && n <= options.length ? n - 1 : null;
  const hits = options
    .map((o, i) => ({ i, names: [o.label, ...(o.aliases ?? [])].map((s) => s.toLowerCase()) }))
    .filter(({ names }) => names.some((name) => name === answer || name.startsWith(answer)));
  return hits.length === 1 ? hits[0].i : null;
}

/**
 * Ask for a secret without echoing it (API keys). Terminal only: the caller
 * checks isInteractive() first. Resolves "" on Ctrl+D / closed input.
 */
export function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(question);
    out._writeToOutput = (s: string) => {
      // Keep line breaks, hide everything typed.
      if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
    };
    rl.on("close", () => {
      if (!answered) resolve("");
    });
    rl.question("", (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}
