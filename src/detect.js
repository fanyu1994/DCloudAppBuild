const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');

/** 安全解压 ZIP(防 zip-slip) */
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zip = await unzipper.Open.file(zipPath);
  for (const entry of zip.files) {
    const rel = path.normalize(entry.path);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const target = path.join(destDir, rel);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) continue;
    if (entry.type === 'Directory') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await new Promise((resolve, reject) => {
      entry
        .stream()
        .pipe(fs.createWriteStream(target))
        .on('finish', resolve)
        .on('error', reject);
    });
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__MACOSX', '.idea']);
const UNIAPP_ID_RE = /^__UNI__[\w]+$/;

/** 在解压目录中查找 manifest.json(深度 <= 4) */
function findManifests(rootDir) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name === '.DS_Store') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase() === 'manifest.json') found.push(p);
    }
  })(rootDir, 0);
  // 优先取层级最浅的
  return found.sort(
    (a, b) => a.split(path.sep).length - b.split(path.sep).length
  );
}

/** 宽松解析 JSON(HBuilderX 的 manifest.json 可能带注释/尾逗号) */
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 继续走容错解析
  }
  let out = '';
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}

/**
 * 识别资源类型与 appid。
 * 返回 { type, appid, resourceRoot, manifestPath }
 *  type: 'hbx'    HBuilderX 本地打包 App 资源(__UNI__XXX 目录)
 *        'cli'    CLI 构建资源(dist/build/app-plus)
 *        'h5plus' HBuilderX 5+App 项目(manifest.json 在根目录)
 *  resourceRoot: 包含 manifest.json 的目录,其内容将被复制到 assets/apps/<appid>/www/
 */
function detectResource(extractDir, override) {
  const manifests = findManifests(extractDir);
  if (!manifests.length) {
    throw new Error('压缩包内未找到 manifest.json,无法识别资源格式');
  }
  const manifestPath = manifests[0];
  const resourceRoot = path.dirname(manifestPath);
  const rel = path.relative(extractDir, resourceRoot);
  const segments = rel ? rel.split(path.sep) : [];

  let manifest = {};
  try {
    manifest = parseJsonLoose(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error('manifest.json 解析失败: ' + e.message);
  }

  let type;
  if (override && override !== 'auto') {
    type = override;
  } else if (segments.some((s) => UNIAPP_ID_RE.test(s))) {
    type = 'hbx';
  } else if (segments.includes('app-plus')) {
    type = 'cli';
  } else if (segments.length >= 2 && segments[0] === 'dist') {
    type = 'cli';
  } else {
    type = 'h5plus';
  }

  let appid = null;
  const idSegment = segments.find((s) => UNIAPP_ID_RE.test(s));
  if (idSegment) appid = idSegment;
  else if (typeof manifest.appid === 'string' && manifest.appid) appid = manifest.appid;
  else if (typeof manifest.id === 'string' && manifest.id) appid = manifest.id;

  if (!appid) {
    throw new Error('未能确定 appid(manifest.json 缺少 appid/id 字段)');
  }
  if (!/^[\w.-]+$/.test(appid)) {
    throw new Error('appid 含有非法字符: ' + appid);
  }

  return { type, appid, resourceRoot, manifestPath };
}

module.exports = { extractZip, detectResource };
