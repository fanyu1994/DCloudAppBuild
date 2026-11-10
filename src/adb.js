const { execFile } = require('child_process');

// USB 在宿主机上,容器无法直接访问;容器内的 adb 客户端通过 TCP 连接宿主机的 adb 服务。
// 宿主机需执行: adb kill-server && adb -a -P 5037 nodaemon server
const ADB_SOCKET = process.env.ADB_SERVER_SOCKET || 'tcp:host.docker.internal:5037';

function runAdb(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      'adb',
      args,
      { timeout, env: { ...process.env, ADB_SERVER_SOCKET: ADB_SOCKET } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || 'adb 执行失败').trim()));
        resolve(stdout.trim());
      }
    );
  });
}

/** 已授权设备列表:[{ serial, model }] */
async function listDevices() {
  const out = await runAdb(['devices'], 15000);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*') && /\tdevice$/.test(l))
    .map((l) => l.split('\t')[0]);
}

/** 安装 APK 到指定设备(不指定则取唯一在线设备) */
async function installApk(apkPath, serial) {
  const args = [];
  if (serial) args.push('-s', serial);
  args.push('install', '-r', '-d', apkPath);
  return runAdb(args, 300000);
}

/** 无线调试配对(Android 11+:adb pair ip:port 配对码) */
async function pairDevice(addr, code) {
  return runAdb(['pair', addr, String(code).trim()], 60000);
}

/** 配对后连接设备(端口与配对端口不同,以手机「无线调试」首页显示为准) */
async function connectDevice(addr) {
  return runAdb(['connect', addr], 30000);
}

module.exports = { listDevices, installApk, pairDevice, connectDevice };
