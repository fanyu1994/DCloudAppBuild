const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 加载环境变量:.env.<NODE_ENV>(默认 development)优先,.env 兜底;均不覆盖已有系统环境变量
require('dotenv').config({ path: path.join(ROOT, `.env.${process.env.NODE_ENV || 'development'}`), quiet: true });
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

module.exports = {
  ROOT,
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  PUBLIC_DIR: path.join(ROOT, 'public'),
  UPLOAD_DIR: path.join(ROOT, 'uploads'),
  TASK_DIR: path.join(ROOT, 'tasks'),
  // DCloud Android 离线 SDK 工程目录(需包含 gradlew),可用环境变量覆盖
  SDK_ANDROID_DIR: process.env.DCLOUD_SDK_ANDROID || path.join(ROOT, 'sdk', 'android'),
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 2048),
  BUILD_TIMEOUT_MS: Number(process.env.BUILD_TIMEOUT_MIN || 40) * 60 * 1000,
  LOG_TAIL_BYTES: 200 * 1024,
};
