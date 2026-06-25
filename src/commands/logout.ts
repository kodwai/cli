import { display } from "../utils/display.js";
import { clearToken, getStoredToken } from "../utils/auth.js";

/** Sign out by removing the stored token. */
export async function logout(): Promise<void> {
  const had = await getStoredToken();
  await clearToken();
  console.log("");
  if (had) {
    display.success("Signed out. Run `kodwai login` to sign in again.");
  } else {
    display.info("  You're not signed in.");
  }
  console.log("");
}
