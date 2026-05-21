import chalk from "chalk";

const rust = chalk.hex("#c23616");
const muted = chalk.hex("#9a948a");

export const display = {
  banner() {
    console.log("");
    console.log(rust.bold("  ╷ ╷        ╷           ╷"));
    console.log(rust.bold("  ├─┤  ╶─╴ ╶─┤ ╷╷╷ ╶─╴  │"));
    console.log(rust.bold("  ╵ ╵  ╶─╴ ╶─╵ ╶╶╶ ╶─╴  ╵"));
    console.log(muted("  kodwai — ai-agent coding platform"));
    console.log("");
  },

  info(msg: string) {
    console.log(muted(msg));
  },

  success(msg: string) {
    console.log(chalk.green("✓") + " " + msg);
  },

  warning(msg: string) {
    console.log(chalk.yellow("⚠") + " " + msg);
  },

  error(msg: string) {
    console.log(chalk.red("✗") + " " + msg);
  },

  divider() {
    console.log(muted("─".repeat(50)));
  },

  problemStatement(md: string) {
    console.log("");
    console.log(rust.bold("PROBLEM STATEMENT"));
    console.log("");
    // Simple markdown rendering — bold headers, preserve content
    const lines = md.split("\n");
    for (const line of lines) {
      if (line.startsWith("# ")) {
        console.log(chalk.bold(line.slice(2)));
      } else if (line.startsWith("## ")) {
        console.log(chalk.bold(line.slice(3)));
      } else if (line.startsWith("### ")) {
        console.log(chalk.bold(line.slice(4)));
      } else {
        console.log(line);
      }
    }
    console.log("");
  },
};
