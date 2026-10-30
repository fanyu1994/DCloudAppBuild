const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { extractZip, detectResource } = require('./detect');
const { SDK_ANDROID_DIR, BUILD_TIMEOUT_MS } = require('./config');

const TYPE_NAMES = {
  hbx: 'HBuilderX 本地打包资源',
  cli: 'CLI 构建资源',
  h5plus: 'HBuilderX 5+App 项目',
};

const queue = [];
let running = false;

function enqueue(taskId) {
  queue.push(taskId);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await runTask(id);
    } catch (e) {
      store.update(id, { status: 'failed', message: '内部错误: ' + e.message, finishedAt: Date.now() });
    }
  }
  running = false;
}

function createLogger(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const line = (text) =>
    stream.write(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${text}\n`);
  return { stream, line, raw: (buf) => stream.write(buf) };
}

async function runTask(taskId) {
  const task = store.get(taskId);
  if (!task) return;
  const tdir = task.dir;
  const log = createLogger(task.logPath);
  try {
    // 1. 解压
    store.update(taskId, { status: 'preparing', message: '解压资源包...' });
    log.line(`任务 ${taskId} 开始,文件: ${task.originalName}`);
    const extractDir = path.join(tdir, 'src');
    await extractZip(path.join(tdir, 'src.zip'), extractDir);
    log.line('解压完成');

    // 2. 识别资源类型
    const detected = detectResource(extractDir, task.typeOverride);
    store.update(taskId, { type: detected.type, appid: detected.appid });
    log.line(`资源类型: ${TYPE_NAMES[detected.type] || detected.type}`);
    log.line(`appid: ${detected.appid}`);
    log.line(`资源目录: ${path.relative(extractDir, detected.resourceRoot) || '.'}`);

    // 3. 检查并复制离线 SDK 工程
    const gradlewName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    if (!fs.existsSync(path.join(SDK_ANDROID_DIR, gradlewName))) {
      throw new Error(
        `未找到 DCloud Android 离线 SDK 工程。请将 SDK 中的 Android 工程(含 gradlew)放到 ${SDK_ANDROID_DIR},或设置环境变量 DCLOUD_SDK_ANDROID 指向该目录。`
      );
    }
    store.update(taskId, { status: 'preparing', message: '复制 SDK 工程...' });
    const projDir = path.join(tdir, 'project');
    log.line(`复制 SDK 工程: ${SDK_ANDROID_DIR} -> ${projDir}`);
    fs.cpSync(SDK_ANDROID_DIR, projDir, {
      recursive: true,
      filter: (src) => {
        const name = path.basename(src);
        // 跳过构建产物与缓存,保证任务目录干净、复制快速
        return !(
          name === 'build' ||
          name === '.gradle' ||
          name === '.idea' ||
          name === '.cxx' ||
          name === '.externalNativeBuild' ||
          name.endsWith('.iml')
        );
      },
    });

    // 4. 替换 App 资源: <module>/src/main/assets/apps/<appid>/www
    const moduleName = resolveAppModule(projDir);
    log.line(`App 模块: ${moduleName}`);
    const assetsDir = path.join(projDir, moduleName, 'src', 'main', 'assets');
    const appsDir = path.join(assetsDir, 'apps');
    fs.rmSync(appsDir, { recursive: true, force: true });
    const wwwDir = path.join(appsDir, detected.appid, 'www');
    fs.mkdirSync(wwwDir, { recursive: true });
    fs.cpSync(detected.resourceRoot, wwwDir, { recursive: true });
    log.line(`资源已写入 ${moduleName}/src/main/assets/apps/${detected.appid}/www`);

    // 5. 同步 dcloud_control.xml 中的 appid
    const controlFile = path.join(assetsDir, 'data', 'dcloud_control.xml');
    if (fs.existsSync(controlFile)) {
      let xml = fs.readFileSync(controlFile, 'utf8');
      xml = xml.replace(/appid="[^"]*"/g, `appid="${detected.appid}"`);
      fs.writeFileSync(controlFile, xml);
      log.line('已更新 dcloud_control.xml 中的 appid');
    } else {
      log.line('警告: 未找到 dcloud_control.xml,跳过 appid 同步');
    }

    // 6. Gradle 打包
    const gradleTask = task.buildType === 'release' ? 'assembleRelease' : 'assembleDebug';
    store.update(taskId, { status: 'building', message: `执行 gradlew ${gradleTask} ...` });
    log.line(`开始 Gradle 构建: ${gradleTask}`);
    const result = await runGradle(projDir, gradlewName, gradleTask, log);
    if (result.error) throw new Error('Gradle 启动失败: ' + result.error);
    if (result.code !== 0) throw new Error(`Gradle 构建失败(exit ${result.code}),详见构建日志`);

    // 7. 收集 APK
    const apk = findApk(projDir, moduleName);
    if (!apk) throw new Error('构建成功但未找到 APK 产物');
    const artifactDir = path.join(tdir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });
    const apkPath = path.join(artifactDir, path.basename(apk));
    fs.copyFileSync(apk, apkPath);
    log.line(`APK 产出: ${path.basename(apk)} (${(fs.statSync(apkPath).size / 1024 / 1024).toFixed(1)} MB)`);

    store.update(taskId, {
      status: 'success',
      message: '构建成功',
      apkPath,
      apkName: path.basename(apk),
      finishedAt: Date.now(),
    });
    log.line('任务完成');
  } catch (e) {
    log.line('失败: ' + e.message);
    store.update(taskId, { status: 'failed', message: e.message, finishedAt: Date.now() });
  } finally {
    cleanupIntermediates(tdir, log);
    log.line('已清理中间产物,仅保留构建结果与日志');
    log.stream.end();
  }
}

/** 删除任务目录中的中间产物(解压资源、上传原包、SDK 工程副本),只保留 artifact 与 build.log */
function cleanupIntermediates(tdir, log) {
  for (const name of ['src', 'src.zip', 'project']) {
    const target = path.join(tdir, name);
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (e) {
      log.line(`警告: 清理 ${name} 失败: ${e.message}`);
    }
  }
}

function runGradle(projDir, gradlewName, gradleTask, log) {
  return new Promise((resolve) => {
    const gradlew = path.join(projDir, gradlewName);
    const isWin = process.platform === 'win32';
    if (!isWin) {
      try {
        fs.chmodSync(gradlew, 0o755);
      } catch {
        /* 忽略 */
      }
    }
    const child = isWin
      ? spawn('cmd.exe', ['/c', gradlew, gradleTask], { cwd: projDir })
      : spawn(gradlew, [gradleTask], { cwd: projDir, env: process.env });
    const timer = setTimeout(() => {
      log.line('构建超时,强制终止');
      child.kill('SIGKILL');
    }, BUILD_TIMEOUT_MS);
    child.stdout.on('data', (d) => log.raw(d));
    child.stderr.on('data', (d) => log.raw(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

/** 在 <module>/build/outputs/apk 下查找最新生成的 APK */
function findApk(projDir, moduleName) {
  const outDir = path.join(projDir, moduleName, 'build', 'outputs', 'apk');
  const found = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.apk')) {
        found.push({ path: p, mtime: fs.statSync(p).mtimeMs });
      }
    }
  })(outDir);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].path : null;
}

/**
 * 确定 SDK 工程中的 App 模块名(含 src/main/assets 的模块)。
 * 优先环境变量 DCLOUD_SDK_APP_MODULE,否则解析 settings.gradle 的 include 列表自动识别。
 */
function resolveAppModule(projDir) {
  const forced = process.env.DCLOUD_SDK_APP_MODULE;
  if (forced) {
    if (fs.existsSync(path.join(projDir, forced, 'src', 'main'))) return forced;
    throw new Error(`DCLOUD_SDK_APP_MODULE 指定的模块不存在: ${forced}`);
  }
  const candidates = [];
  for (const name of ['settings.gradle', 'settings.gradle.kts']) {
    const file = path.join(projDir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/include\s*\(?\s*([^\n)]*)/g)) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().replace(/^['"]|['"]$/g, '').replace(/^:/, '');
        if (mod) candidates.push(mod);
      }
    }
  }
  candidates.push('app');
  for (const name of candidates) {
    if (fs.existsSync(path.join(projDir, name, 'src', 'main', 'assets'))) return name;
  }
  throw new Error(
    `无法确定 App 模块目录(已尝试: ${candidates.join(', ')}),请设置环境变量 DCLOUD_SDK_APP_MODULE,例如 simpleDemo`
  );
}

module.exports = { enqueue };
