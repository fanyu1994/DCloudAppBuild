const fs = require('fs');
const os = require('os');
const express = require('express');
const store = require('./store');
const routes = require('./routes');
const { PORT, HOST, PUBLIC_DIR, UPLOAD_DIR, TASK_DIR, SDK_ANDROID_DIR } = require('./config');

for (const dir of [PUBLIC_DIR, UPLOAD_DIR, TASK_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
store.load();

const app = express();
app.use(express.json());
app.use('/api', routes);
app.use(express.static(PUBLIC_DIR));

// 统一错误处理(multer 超限等)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件超出大小限制' });
  }
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log(`dcloud-build-pro 已启动:`);
  console.log(`  本机访问   http://localhost:${PORT}`);
  for (const ip of addrs) {
    console.log(`  局域网访问 http://${ip}:${PORT}`);
  }
  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  if (!fs.existsSync(require('path').join(SDK_ANDROID_DIR, gradlew))) {
    console.log(`\n[提示] 未检测到 DCloud Android 离线 SDK 工程。`);
    console.log(`       请将 SDK 中的 Android 工程(含 gradlew)放到: ${SDK_ANDROID_DIR}`);
    console.log(`       或设置环境变量 DCLOUD_SDK_ANDROID 指向该目录。\n`);
  }
});
