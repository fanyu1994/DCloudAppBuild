const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const store = require('./store');
const builder = require('./builder');
const adb = require('./adb');
const { UPLOAD_DIR, SDK_ANDROID_DIR, MAX_UPLOAD_MB, LOG_TAIL_BYTES } = require('./config');

const router = express.Router();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const VALID_TYPES = new Set(['auto', 'hbx', 'cli', 'h5plus']);

/** 从 User-Agent 粗略识别操作系统 */
function detectOs(ua = '') {
  if (/Windows NT 10/i.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/i.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/i.test(ua)) return 'Windows 7';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  if (/curl|wget|node|python/i.test(ua)) return '命令行';
  return '未知';
}

/** 取客户端 IP(兼容反向代理的 x-forwarded-for) */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = fwd ? String(fwd).split(',')[0].trim() : req.ip || '';
  return raw.replace(/^::ffff:/, '');
}

function publicView(t) {
  return {
    id: t.id,
    originalName: t.originalName,
    size: t.size,
    type: t.type,
    typeOverride: t.typeOverride,
    buildType: t.buildType,
    appid: t.appid,
    status: t.status,
    message: t.message,
    apkName: t.apkName,
    machine: t.machine,
    uploader: t.uploader,
    createdAt: t.createdAt,
    finishedAt: t.finishedAt,
  };
}

// 上传资源包并创建构建任务
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '缺少上传文件(字段名 file)' });
  const cleanup = () => fs.unlink(req.file.path, () => {});
  if (!/\.zip$/i.test(req.file.originalname || '')) {
    cleanup();
    return res.status(400).json({ error: '仅支持 .zip 压缩包' });
  }
  // multer 对中文文件名的 latin1 误码修正
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const typeOverride = VALID_TYPES.has(req.body.type) ? req.body.type : 'auto';
  const buildType = req.body.buildType === 'release' ? 'release' : 'debug';

  const task = store.create({
    originalName,
    size: req.file.size,
    typeOverride,
    buildType,
    uploader: {
      ip: clientIp(req),
      os: detectOs(req.headers['user-agent'] || ''),
      ua: req.headers['user-agent'] || '',
    },
    message: '排队等待构建...',
  });
  // 用复制+删除代替 rename:uploads 与 tasks 可能是不同挂载点(容器内跨设备时会 EXDEV)
  const target = path.join(task.dir, 'src.zip');
  try {
    fs.copyFileSync(req.file.path, target);
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    store.update(task.id, { status: 'failed', message: '保存资源包失败: ' + e.message });
    return res.status(500).json({ error: '保存资源包失败: ' + e.message });
  }
  cleanup();
  builder.enqueue(task.id);
  res.status(201).json(publicView(store.get(task.id)));
});

// 任务列表(按创建时间倒序,支持分页:?page=&size=)
router.get('/tasks', (req, res) => {
  const all = store.all().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(publicView);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const start = (page - 1) * size;
  res.json({ data: all.slice(start, start + size), total, page, size, totalPages });
});

// 任务详情
router.get('/tasks/:id', (req, res) => {
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(publicView(t));
});

// 构建日志(返回尾部,默认最近 200KB)
router.get('/tasks/:id/log', (req, res) => {
  const t = store.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  let text = '';
  try {
    const stat = fs.statSync(t.logPath);
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const fd = fs.openSync(t.logPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    text = '(暂无日志)';
  }
  res.type('text/plain; charset=utf-8').send(text);
});

// 下载 APK
router.get('/tasks/:id/download', (req, res) => {
  const t = store.get(req.params.id);
  if (!t || !t.apkPath || !fs.existsSync(t.apkPath)) {
    return res.status(404).json({ error: 'APK 不存在或尚未构建成功' });
  }
  res.download(t.apkPath, t.downloadName || t.apkName || 'app.apk');
});

// USB 调试设备列表(经宿主机 adb 服务)
router.get('/adb/devices', async (req, res) => {
  try {
    res.json({ devices: await adb.listDevices() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const ADDR_RE = /^[\w.-]+:\d{1,5}$/;

// 无线调试配对(Android 11+)
router.post('/adb/pair', async (req, res) => {
  const { addr, code } = req.body || {};
  if (!ADDR_RE.test(addr || '')) return res.status(400).json({ error: '配对地址格式应为 ip:端口' });
  if (!/^\d{6}$/.test(String(code || '').trim())) return res.status(400).json({ error: '配对码应为 6 位数字' });
  try {
    const out = await adb.pairDevice(addr, code);
    if (/success/i.test(out)) res.json({ ok: true, output: out });
    else res.status(500).json({ error: out || '配对失败' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 配对后连接设备
router.post('/adb/connect', async (req, res) => {
  const { addr } = req.body || {};
  if (!ADDR_RE.test(addr || '')) return res.status(400).json({ error: '连接地址格式应为 ip:端口' });
  try {
    const out = await adb.connectDevice(addr);
    if (/connected|already connected/i.test(out)) res.json({ ok: true, output: out });
    else res.status(500).json({ error: out || '连接失败' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 安装 APK 到 USB 调试设备
router.post('/tasks/:id/install', async (req, res) => {
  const t = store.get(req.params.id);
  if (!t || !t.apkPath || !fs.existsSync(t.apkPath)) {
    return res.status(404).json({ error: 'APK 不存在或尚未构建成功' });
  }
  try {
    const serial = req.body && req.body.serial;
    const out = await adb.installApk(t.apkPath, serial);
    res.json({ ok: true, output: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 服务信息(SDK 是否就绪)
router.get('/meta', (req, res) => {
  const gradlew = path.join(SDK_ANDROID_DIR, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  res.json({
    sdkReady: fs.existsSync(gradlew),
    sdkPath: SDK_ANDROID_DIR,
    maxUploadMb: MAX_UPLOAD_MB,
  });
});

module.exports = router;
