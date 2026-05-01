const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===================== 数据库 =====================
const db = new Database('danmu.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS danmu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    color TEXT DEFAULT '#ffffff',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ===================== 敏感词库 =====================
const bannedWords = [
  // 脏话
  '傻逼', 'sb', '傻b', '煞笔', '尼玛', '你妈', '操你', '草你', ' fuck ', 'shit',
  '妈逼', '贱人', '婊子', '骚货', '滚蛋', '去死', '脑残', '智障', '弱智',
  // 自杀倾向
  '自杀', '想死', '不想活', '跳楼', '割腕', '上吊', '安眠药', '结束生命',
  '活不下去', '死了算了', '我不想活了', '活着没意思',
  // 错误价值观引导
  '退学', '辍学', '离家出走', '吸毒', '嗑药', '约炮', '一夜情',
  '不用读书', '读书没用', '骗父母', '偷钱',
];
const filterRegex = new RegExp(
  bannedWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gi'
);

function filterText(text) {
  let filtered = text.replace(filterRegex, '***');
  return filtered.substring(0, 80);
}

// ===================== 频率限制（10秒1条） =====================
const ipLastSend = new Map();

function canSend(ip) {
  const last = ipLastSend.get(ip) || 0;
  return Date.now() - last > 10000; // 10秒
}

function recordSend(ip) {
  ipLastSend.set(ip, Date.now());
}

// ===================== 数据库操作 =====================
function saveDanmu(text, ip) {
  const stmt = db.prepare('INSERT INTO danmu (text, color) VALUES (?, ?)');
  return stmt.run(text, '#ffffff');
}

function getAllDanmu() {
  return db.prepare('SELECT text, color FROM danmu ORDER BY id ASC').all();
}

function getDanmuCount() {
  return db.prepare('SELECT COUNT(*) as count FROM danmu').get().count;
}

// ===================== 静态文件 =====================
app.use(express.static(path.join(__dirname, 'public')));

// 二维码接口
app.get('/qrcode', async (req, res) => {
  try {
    const domain = 'https://danmu-wall.onrender.com';
    const qrDataUrl = await QRCode.toDataURL(`${domain}/send`);
    res.json({ qrcode: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: '生成失败' });
  }
});

// 弹幕总数
app.get('/api/count', (req, res) => {
  res.json({ count: getDanmuCount() });
});

// ===================== WebSocket =====================
io.on('connection', (socket) => {
  const ip = socket.handshake.address;

  socket.emit('history', getAllDanmu());
  socket.emit('count', getDanmuCount());

  socket.on('danmu', (data) => {
    const text = filterText((data.text || '').trim());
    if (!text) {
      socket.emit('error_msg', '内容为空或包含违规信息');
      return;
    }

    if (!canSend(ip)) {
      socket.emit('error_msg', '已达到发送上限（3条）');
      return;
    }

    recordSend(ip);
    saveDanmu(text, ip);

    const danmuData = { text, color: '#ffffff', timestamp: Date.now() };
    io.emit('danmu', danmuData);
    io.emit('count', getDanmuCount());
  });
});

// ===================== 启动 =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 弹幕墙已启动: http://localhost:${PORT}`);
});