// Read-only static server for the listening harness.
//   /                → <repo>/claudeville/ (the shipped app files, same URL layout as server.js),
//                      or `appDir` (an exported earlier revision: the probe's reference renders)
//   /__har/          → scripts/audio/page/ (harness page + runtime)
//   /__snippet/<id>  → a snippet file registered by the CLI
// Binds 127.0.0.1 on an ephemeral port (never 4000). Never writes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AUDIO_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(AUDIO_DIR, '../..');
const APP_DIR = path.join(REPO_ROOT, 'claudeville');
const PAGE_DIR = path.join(AUDIO_DIR, 'page');

const TYPES = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function safeJoin(root, rel) {
    const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    return full.startsWith(root) ? full : null;
}

export async function startStaticServer({ appDir = APP_DIR } = {}) {
    const root = path.resolve(appDir);
    const snippets = new Map();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let file = null;
        if (url.pathname.startsWith('/__har/')) file = safeJoin(PAGE_DIR, url.pathname.slice(6));
        else if (url.pathname.startsWith('/__snippet/')) file = snippets.get(url.pathname.slice(11)) || null;
        else file = safeJoin(root, url.pathname === '/' ? '/index.html' : url.pathname);
        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    if (port === 4000) throw new Error('refusing port 4000');
    let snippetSeq = 0;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        registerSnippet(filePath) {
            const id = `s${++snippetSeq}-${path.basename(filePath)}`;
            snippets.set(id, path.resolve(filePath));
            return `/__snippet/${id}`;
        },
        close: () => new Promise(r => server.close(r)),
    };
}
