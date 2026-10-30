const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const store = require('./store');
const builder = require('./builder');
const { UPLOAD_DIR, SDK_ANDROID_DIR, MAX_UPLOAD_MB, LOG_TAIL_BYTES } = require('./config');

const router = express.Router();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const VALID_TYPES = new Set(['auto', 'hbx', 'cli', 'h5plus']);

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
    message: '排队等待构建...',
  });
  fs.renameSync(req.file.path, path.join(task.dir, 'src.zip'));
  builder.enqueue(task.id);
  res.status(201).json(publicView(store.get(task.id)));
});

// 任务列表
router.get('/tasks', (req, res) => {
  res.json(store.all().map(publicView));
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
  res.download(t.apkPath, t.apkName || 'app.apk');
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
