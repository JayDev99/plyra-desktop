// Copies the Plyra web apps (the phone app and the School) from the website folder into dist/, which Tauri
// bundles into the desktop app. They run from the app itself: no web server, nothing to wait for.
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const site = resolve(process.env.PLYRA_WEBSITE || "../omniscient-chess/website");
const out = resolve("dist");
if (!existsSync(site)) throw new Error(`Plyra website folder not found: ${site} (set PLYRA_WEBSITE)`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(resolve(site, "app"), resolve(out, "app"), { recursive: true });
cpSync(resolve(site, "school-preview"), resolve(out, "school"), { recursive: true });
cpSync(resolve("shell"), out, { recursive: true });
console.log("web apps copied to", out);
