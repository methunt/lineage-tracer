/**
 * Stage the viewer template as an asset of the web app.
 *
 * `vite build` (default mode) emits the single-file viewer at ui/dist/index.html.
 * The web app has to *ship* that file so the Export button can fetch it, so it
 * is copied into ui/public/ — Vite copies public/ into dist-web verbatim, and
 * the dev server serves it at the same path, which is what makes export work in
 * both `npm run dev:web` and the deployed site without a second code path.
 *
 * A copy rather than pointing the viewer build's outDir at public/: two builds
 * writing into a directory one of them also treats as a source is the kind of
 * arrangement that works until someone adds `emptyOutDir`.
 *
 *   node scripts/stage-viewer.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '..');
const BUILT = path.join(BRIDGE, 'ui', 'dist', 'index.html');
const STAGED = path.join(BRIDGE, 'ui', 'public', 'viewer.html');

if (!fs.existsSync(BUILT)) {
    console.error(`stage-viewer: no viewer build at ${BUILT}\n` +
        'Build it with:  npm --prefix ui run build');
    process.exit(1);
}

fs.mkdirSync(path.dirname(STAGED), { recursive: true });
fs.copyFileSync(BUILT, STAGED);
console.log(`stage-viewer: ${STAGED}  (${(fs.statSync(STAGED).size / 1048576).toFixed(1)} MB)`);
