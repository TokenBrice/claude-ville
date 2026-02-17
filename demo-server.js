// Moltcraft Demo Server - 가짜 API로 UI 구경용
const http = require('http');
const fs = require('fs');
const path = require('path');

const MOLTCRAFT_DIR = '/Users/honorstudio/.npm/_npx/50b3f5da95228046/node_modules/@ask-mojo/moltcraft';
const PORT = 8080;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 데모용 가짜 세션 데이터
const DEMO_SESSIONS = [
  {
    sessionId: 'agent-leader-001',
    label: 'Team Leader',
    status: 'working',
    model: 'claude-opus-4-6',
    created: Date.now() - 300000,
    lastActive: Date.now() - 5000,
    tokenUsage: { input: 45000, output: 12000 },
    messages: [{ role: 'assistant', content: 'PR 리뷰 진행 중입니다. 3개 파일 검토 완료.' }]
  },
  {
    sessionId: 'agent-researcher-002',
    label: 'Researcher',
    status: 'working',
    model: 'claude-sonnet-4-5',
    created: Date.now() - 250000,
    lastActive: Date.now() - 2000,
    tokenUsage: { input: 32000, output: 8500 },
    messages: [{ role: 'assistant', content: 'API 문서 분석 중... Supabase Auth 패턴 조사' }]
  },
  {
    sessionId: 'agent-coder-003',
    label: 'Frontend Dev',
    status: 'working',
    model: 'claude-opus-4-6',
    created: Date.now() - 200000,
    lastActive: Date.now() - 1000,
    tokenUsage: { input: 67000, output: 23000 },
    messages: [{ role: 'assistant', content: 'React 컴포넌트 작성 중 - LoginForm.tsx 완료' }]
  },
  {
    sessionId: 'agent-tester-004',
    label: 'Test Runner',
    status: 'idle',
    model: 'claude-haiku-4-5',
    created: Date.now() - 180000,
    lastActive: Date.now() - 60000,
    tokenUsage: { input: 15000, output: 4200 },
    messages: [{ role: 'assistant', content: '테스트 대기 중 - Frontend Dev 작업 완료 대기' }]
  },
  {
    sessionId: 'agent-reviewer-005',
    label: 'Code Reviewer',
    status: 'idle',
    model: 'claude-sonnet-4-5',
    created: Date.now() - 150000,
    lastActive: Date.now() - 30000,
    tokenUsage: { input: 22000, output: 6800 },
    messages: [{ role: 'assistant', content: '코드 리뷰 대기 중' }]
  }
];

const server = http.createServer((req, res) => {
  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // 가짜 API 응답
  if (req.url.startsWith('/api/')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });

    // tools/invoke 엔드포인트
    if (req.url.includes('/api/tools/invoke')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch(e) {}

        const tool = parsed.tool || parsed.name || '';

        if (tool === 'sessions_list') {
          res.end(JSON.stringify({
            result: {
              details: {
                sessions: DEMO_SESSIONS
              }
            }
          }));
        } else if (tool === 'session_messages') {
          res.end(JSON.stringify({
            result: {
              content: [{ text: JSON.stringify({ messages: DEMO_SESSIONS[0].messages }) }]
            }
          }));
        } else {
          res.end(JSON.stringify({ result: { content: [{ text: '{}' }] } }));
        }
      });
      return;
    }

    // cron/list
    if (req.url.includes('/api/cron/list')) {
      res.end(JSON.stringify({
        jobs: [
          { name: 'health-check', schedule: '*/5 * * * *', lastRun: Date.now() - 60000 },
          { name: 'token-report', schedule: '0 * * * *', lastRun: Date.now() - 1800000 },
        ]
      }));
      return;
    }

    // channels
    if (req.url.includes('/api/channels') || req.url.includes('/api/config')) {
      res.end(JSON.stringify({
        channels: { slack: { connected: true }, telegram: { connected: false } },
        config: { version: 'demo-1.0' }
      }));
      return;
    }

    // 기타 API
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 정적 파일 서빙 (Moltcraft 소스에서)
  const cleanUrl = req.url.split('?')[0];
  let filePath = cleanUrl === '/' ? '/index.html' : cleanUrl;
  filePath = path.join(MOLTCRAFT_DIR, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⛏️  MOLTCRAFT Demo Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   5개 데모 에이전트 로드됨\n`);
});
