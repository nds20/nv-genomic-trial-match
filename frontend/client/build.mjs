// Compatibility entry point for anyone who used the original hosted-runtime
// build command. The standalone production build is Vite; this wrapper just
// runs the package's canonical build script and never loads @hatch/space-sdk.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("npm", ["run", "build"], { cwd: frontendRoot, stdio: "inherit" });
process.exit(result.status ?? 1);
