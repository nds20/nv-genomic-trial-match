import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'cloudflare', 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

// The React production build is the primary app at /.
await cp(path.join(root, 'frontend', 'dist'), output, { recursive: true });
// Hand-authored static HTML5 fallback/public pages live under /static/.
await cp(path.join(root, 'static'), path.join(output, 'static'), { recursive: true });
// The original dependency-free prototype remains available for comparison.
await cp(path.join(root, 'public'), path.join(output, 'legacy'), { recursive: true });

console.log(`Prepared Cloudflare assets in ${output}`);
