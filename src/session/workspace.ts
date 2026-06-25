import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfig } from "./config.js";

export async function createWorkspace(config: SessionConfig): Promise<string> {
  // Create workspace directory named after the project
  const safeName = config.project_title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const dirName = `kodwai-${safeName}-${config.session_id.slice(0, 8)}`;
  const workspacePath = join(process.cwd(), dirName);

  await mkdir(workspacePath, { recursive: true });

  // Write problem statement as README
  await writeFile(
    join(workspacePath, "PROBLEM.md"),
    `# ${config.project_title}\n\n${config.problem_statement_md}\n`,
    "utf-8",
  );

  // TODO: Download and extract starter files when starter_files URL is available

  return workspacePath;
}
