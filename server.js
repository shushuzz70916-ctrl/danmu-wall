const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const os = require('os');

// ─── Config ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const RATE_LIMIT_MS = 10_000;
const HISTORY_LIMIT = 100;

// ─── Local IP ──────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}
const LOCAL_IP = getLocalIP();

// ─── Sensitive Words ───────────────────────────────────────
const SENSITIVE = [
  '自杀','自尽','自残','跳楼','上吊','割腕','服毒','安乐死',
  '去死','你妈死了','你妈逼','操你妈','操你','草泥马','卧槽尼玛',
  '傻逼','他妈','他妈的','日你','日你妈','滚蛋','废物','垃圾',
  '杀人','放火','贩毒','吸毒','强奸','卖淫','嫖娼',
  '傻b','sb','SB','nmsl','cnm','wcnm',
];

function hasSensitive(text) {
  const t = text.toLowerCase();
  return SENSITIVE.some(w => t.includes(w));
}

// ─── Database ──────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at)`);

const insertStmt = db.prepare('INSERT INTO messages (text, ip) VALUES (?, ?)');
const queryStmt = db.prepare('SELECT id, text, created_at FROM messages ORDER BY created_at DESC LIMIT ?');

function getHistory(limit = HISTORY_LIMIT) {
  return queryStmt.all(limit).reverse();
}

function saveMessage(text, ip) {
  const r = insertStmt.run(text, ip);
  const count = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  if (count > HISTORY_LIMIT * 2) {
    db.prepare(`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY created_at DESC LIMIT ?)`).run(HISTORY_LIMIT);
  }
  return { id: r.lastInsertRowid, text, created_at: new Date().toISOString() };
}

// ─── Express ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// QR code endpoint
app.get('/qrcode.png', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const sendUrl = `${proto}://${host}/send/`;
  QRCode.toBuffer(sendUrl, { width: 320, margin: 1, color: { dark: '#000', light: '#fff' } })
    .then(buf => { res.type('png').send(buf); })
    .catch(() => { res.status(500).end(); });
});

app.get('/api/info', (req, res) => {
  res.json({ localIP: LOCAL_IP, port: PORT });
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Socket.IO ─────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const ipLimiter = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of ipLimiter) {
    if (now - ts > RATE_LIMIT_MS * 2) ipLimiter.delete(ip);
  }
}, 30_000);

io.on('connection', (socket) => {
  const clientIP = socket.handshake.address;
  console.log(`[连接] ${clientIP}`);

  socket.emit('history', getHistory());

  socket.on('send_danmu', (text, ack) => {
    if (!text || typeof text !== 'string') {
      return ack?.({ ok: false, msg: '内容无效' });
    }
    text = text.trim().slice(0, 200);
    if (!text) return ack?.({ ok: false, msg: '内容不能为空' });

    if (hasSensitive(text)) {
      return ack?.({ ok: false, msg: '内容包含敏感词，请修改' });
    }

    const now = Date.now();
    const last = ipLimiter.get(clientIP);
    if (last && now - last < RATE_LIMIT_MS) {
      const remain = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
      return ack?.({ ok: false, msg: `操作太频繁，请 ${remain} 秒后再试` });
    }
    ipLimiter.set(clientIP, now);

    const msg = saveMessage(text, clientIP);
    io.emit('new_danmu', msg);
    ack?.({ ok: true });
    console.log(`[消息] ${clientIP}: ${text}`);
  });

  socket.on('disconnect', () => {
    console.log(`[断开] ${clientIP}`);
  });
});

// ─── Start ─────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║       弹幕背景板已启动           ║');
  console.log('  ╠══════════════════════════════════╣');
  console.log(`  ║  大屏: http://${LOCAL_IP}:${PORT}     ║`);
  console.log(`  ║  发送: http://${LOCAL_IP}:${PORT}/send/ ║`);
  console.log('  ╚══════════════════════════════════╝');
  console.log('');
});
