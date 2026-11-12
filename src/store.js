const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TASK_DIR } = require('./config');

const DB_FILE = path.join(TASK_DIR, 'tasks.json');
let tasks = [];
// 记录最近一次同步后的文件标识(size:mtime),用于发现外部删除/清空任务目录
let diskStamp = null;

function fileStamp() {
  try {
    const s = fs.statSync(DB_FILE);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

function readFromDisk() {
  try {
    tasks = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(tasks)) tasks = [];
  } catch {
    tasks = [];
  }
  diskStamp = fileStamp();
}

// 磁盘上的任务记录被外部改动(如手动清空 tasks 目录)时重新加载,避免内存残留
function sync() {
  if (fileStamp() !== diskStamp) readFromDisk();
}

function load() {
  readFromDisk();
  // 服务重启后,进行中的任务标记为失败
  for (const t of tasks) {
    if (['queued', 'preparing', 'building'].includes(t.status)) {
      t.status = 'failed';
      t.message = '服务重启,构建被中断,请重新上传';
      t.updatedAt = Date.now();
    }
  }
  save();
}

function save() {
  fs.mkdirSync(TASK_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, DB_FILE);
  diskStamp = fileStamp();
}

function create(fields) {
  sync();
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const dir = path.join(TASK_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const task = {
    id,
    dir,
    status: 'queued',
    type: null,        // 识别结果: hbx | cli | h5plus
    appid: null,
    buildType: 'debug',
    message: '',
    logPath: path.join(dir, 'build.log'),
    apkPath: null,
    apkName: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...fields,
  };
  tasks.unshift(task);
  save();
  return task;
}

function get(id) {
  sync();
  return tasks.find((t) => t.id === id) || null;
}

function update(id, fields) {
  sync();
  const t = tasks.find((t) => t.id === id);
  if (!t) return null;
  Object.assign(t, fields, { updatedAt: Date.now() });
  save();
  return t;
}

function all() {
  sync();
  return tasks;
}

module.exports = { load, create, get, update, all };
