import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { makeTempDir } from './support/tmp.mjs';

const require = createRequire(import.meta.url);

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('Static request timed out')));
    req.end();
  });
}

test('text MIME and gzip variants preserve exact bodies, HEAD and strong validators', async (t) => {
  const root = makeTempDir('claudeville-server-static-');
  const originalHome = process.env.HOME;
  const originalGit = process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT;
  process.env.HOME = root;
  process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = '1';
  const runtime = require('../../claudeville/server.js');
  const realRoot = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    runtime._staticTest.serveContainedFile(req, res, new URL(req.url, 'http://fixture'), { root, realRoot });
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    assert.notEqual(port, 4000);
    for (const [extension, mime, body] of [
      ['html', 'text/html; charset=utf-8', '<html><body>fixture</body></html>'],
      ['yaml', 'text/yaml; charset=utf-8', 'name: fixture\nvalue: 1\n'],
      ['yml', 'text/yaml; charset=utf-8', 'name: fixture\nvalue: 2\n'],
      ['svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'],
      ['webmanifest', 'application/manifest+json; charset=utf-8', '{"name":"fixture","start_url":"/"}'],
      ['js', 'application/javascript; charset=utf-8', 'export const fixture = true;\n'],
      ['mjs', 'application/javascript; charset=utf-8', 'export const module = true;\n'],
      ['css', 'text/css; charset=utf-8', 'body { color: red; }\n'],
      ['json', 'application/json; charset=utf-8', '{"value":1}'],
    ]) {
      await t.test(extension, async () => {
        const file = path.join(root, `fixture.${extension}`);
        const source = Buffer.from(body);
        fs.writeFileSync(file, source);
        const identity = await request(port, `/fixture.${extension}`);
        const gzip = await request(port, `/fixture.${extension}`, { headers: { 'Accept-Encoding': 'gzip' } });
        assert.equal(identity.status, 200);
        assert.equal(gzip.status, 200);
        assert.equal(identity.headers['content-type'], mime);
        assert.equal(gzip.headers['content-type'], mime);
        assert.equal(identity.headers.vary, 'Accept-Encoding');
        assert.equal(gzip.headers.vary, 'Accept-Encoding');
        assert.equal(identity.headers['content-encoding'], undefined);
        assert.equal(gzip.headers['content-encoding'], 'gzip');
        assert.deepEqual(identity.body, source);
        assert.deepEqual(zlib.gunzipSync(gzip.body), source);
        assert.equal(Number(identity.headers['content-length']), source.length);
        assert.equal(Number(gzip.headers['content-length']), gzip.body.length);
        assert.notEqual(identity.headers.etag, gzip.headers.etag);
        assert.equal(identity.headers['cache-control'], 'no-cache');
        for (const compressed of [false, true]) {
          const response = compressed ? gzip : identity;
          const encodingHeaders = compressed ? { 'Accept-Encoding': 'gzip' } : {};
          const conditional = await request(port, `/fixture.${extension}`, { headers: { ...encodingHeaders, 'If-None-Match': response.headers.etag } });
          assert.equal(conditional.status, 304);
          assert.equal(conditional.body.length, 0);
          assert.equal(conditional.headers.etag, response.headers.etag);
          assert.equal(conditional.headers.vary, 'Accept-Encoding');
          const head = await request(port, `/fixture.${extension}`, { method: 'HEAD', headers: encodingHeaders });
          assert.equal(head.status, 200);
          assert.equal(head.body.length, 0);
          assert.equal(head.headers.etag, response.headers.etag);
          assert.equal(head.headers['content-length'], response.headers['content-length']);
        }
        const wrongVariant = await request(port, `/fixture.${extension}`, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': identity.headers.etag } });
        assert.equal(wrongVariant.status, 200);
        const refused = await request(port, `/fixture.${extension}`, { headers: { 'Accept-Encoding': 'gzip;q=0, *;q=1' } });
        assert.equal(refused.headers['content-encoding'], undefined);
        assert.deepEqual(refused.body, source);

        const stat = fs.statSync(file);
        const replacement = Buffer.from(source);
        replacement[replacement.length - 1] ^= 1;
        fs.writeFileSync(file, replacement);
        fs.utimesSync(file, stat.atime, stat.mtime);
        const rewritten = await request(port, `/fixture.${extension}`, { headers: { 'If-None-Match': identity.headers.etag } });
        assert.equal(rewritten.status, 200, 'Same-size, same-mtime rewrites must not reuse stale strong validators');
        assert.notEqual(rewritten.headers.etag, identity.headers.etag);
        assert.deepEqual(rewritten.body, replacement);
      });
    }
    await t.test('binary PNG stays uncompressed and versioned fonts remain immutable', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(path.join(root, 'fixture.png'), png);
      fs.writeFileSync(path.join(root, 'fixture.woff2'), Buffer.from('font fixture'));
      const response = await request(port, '/fixture.png?v=test', { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(response.headers['content-type'], 'image/png');
      assert.equal(response.headers['content-encoding'], undefined);
      assert.equal(response.headers.vary, undefined);
      assert.deepEqual(response.body, png);
      const font = await request(port, '/fixture.woff2?v=test');
      assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');
      const unversioned = await request(port, '/fixture.woff2');
      assert.equal(unversioned.headers['cache-control'], 'no-cache');
    });
    await t.test('/m and /m/ serve the root index.html; other /m paths stay contained', async () => {
      const shell = Buffer.from('<!DOCTYPE html><title>shell</title>');
      fs.writeFileSync(path.join(root, 'index.html'), shell);
      for (const pathname of ['/', '/m', '/m/', '/m/?sim=1']) {
        const response = await request(port, pathname);
        assert.equal(response.status, 200, pathname);
        assert.equal(response.headers['content-type'].split(';')[0], 'text/html', pathname);
        assert.deepEqual(response.body, shell, pathname);
      }
      assert.equal((await request(port, '/m/index.html')).status, 404);
    });
    await t.test('SV-11: the production root serves the client and nothing else', async () => {
      const production = http.createServer((req, res) => {
        runtime._staticTest.handleStaticFile(req, res, new URL(req.url, 'http://fixture'));
      });
      await new Promise(resolve => production.listen(0, '127.0.0.1', resolve));
      try {
        const productionPort = production.address().port;
        assert.notEqual(productionPort, 4000);
        for (const pathname of [
          '/', '/m', '/m/', '/src/presentation/App.js', '/css/reset.css', '/assets/sprites/manifest.yaml',
          '/vendor/js-yaml.min.js', '/tools/model-roster.html', '/favicon.svg', '/favicon-alert.svg',
          '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/m.webmanifest',
        ]) {
          assert.equal((await request(productionPort, pathname)).status, 200, pathname);
        }
        for (const pathname of [
          '/server.js', '/CLAUDE.md', '/adapters/claude.js', '/adapters/', '/services/usageQuota.js',
          '/%73erver.js', '/src/%2e%2e/server.js', '/src', '/assets',
        ]) {
          const response = await request(productionPort, pathname);
          assert.equal(response.status, 404, pathname);
          assert.equal(response.body.includes('require('), false, `${pathname} leaked source`);
        }
      } finally {
        await new Promise(resolve => production.close(resolve));
      }
      const allowed = runtime._staticTest.isClientStaticPath;
      assert.equal(allowed('index.html'), true);
      assert.equal(allowed('src/a.js'), true);
      for (const blocked of ['', 'server.js', 'CLAUDE.md', 'notes.html', 'services/usageQuota.js', '../package.json', 'src']) {
        assert.equal(allowed(blocked), false, blocked);
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    runtime.shutdownRuntime({ reason: 'static-test', exitProcess: false });
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalGit === undefined) delete process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT; else process.env.CLAUDEVILLE_DISABLE_GIT_ENRICHMENT = originalGit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
