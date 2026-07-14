import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (process.platform !== 'linux') {
  console.log(`watcher footprint skipped: ${process.platform} does not expose Linux fdinfo`);
  process.exit(0);
}

const args = process.argv.slice(2);
const valueAfter = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const pid = Number(valueAfter('--pid', process.pid));
const max = Number(valueAfter('--max', 1000));
const url = valueAfter('--url', 'http://localhost:4000/api/perf');

function readProcWatchers(targetPid) {
  const fdInfoDir = `/proc/${targetPid}/fdinfo`;
  let inotifyFds = 0;
  let watchEntries = 0;
  for (const fd of fs.readdirSync(fdInfoDir)) {
    let content;
    try {
      content = fs.readFileSync(path.join(fdInfoDir, fd), 'utf8');
    } catch {
      continue;
    }
    const entries = content.match(/^inotify wd:/gm)?.length || 0;
    if (entries > 0) inotifyFds++;
    watchEntries += entries;
  }
  return { pid: targetPid, inotifyFds, watchEntries };
}

function getJson(targetUrl) {
  return new Promise((resolve, reject) => {
    http.get(targetUrl, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

const direct = readProcWatchers(pid);
let api = null;
try {
  const perf = await getJson(url);
  api = {
    websocketClients: perf.websocketClients,
    topology: perf.watchers,
  };
} catch (err) {
  api = { unavailable: err.message };
}

console.log(JSON.stringify({ direct, api }, null, 2));
if (Number.isFinite(max) && direct.watchEntries > max) {
  throw new Error(`watch entry count ${direct.watchEntries} exceeds limit ${max}`);
}
