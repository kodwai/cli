import { spawn } from "node:child_process";

/**
 * Open a URL in the user's default browser, cross-platform.
 * Best-effort: failures are swallowed (the caller always prints the URL too).
 */
export function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      // `start` is a cmd builtin; the empty "" is the (required) window title arg.
      cmd = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the URL is printed for manual opening
  }
}
