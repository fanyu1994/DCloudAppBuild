const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TASK_DIR } = require('./config');

const DB_FILE = path.join(TASK_DIR, 'tasks.json');
let tasks = [];

function load() {
  try {
    tasks = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(tasks)) tasks = [];
  } catch {
    tasks = [];
  }
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
}

function create(fields) {
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
  return tasks.find((t) => t.id === id) || null;
}

function update(id, fields) {
  const t = get(id);
  if (!t) return null;
  Object.assign(t, fields, { updatedAt: Date.now() });
  save();
  return t;
}

function all() {
  return tasks;
}

module.exports = { load, create, get, update, all };
