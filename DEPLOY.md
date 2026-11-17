# dcloud-build-pro 部署文档

面向局域网 Android 打包服务的服务器部署说明。服务接收 HBuilderX 本地打包资源 / CLI 构建资源 ZIP，调用 DCloud Android 离线 SDK 执行 Gradle 构建，输出 APK 并提供下载页面。

## 1. 服务概览

```
浏览器(同事)
   │  HTTP :8848
   ▼
[Docker 容器 dcloud-build-pro]  Node 20 + JDK 17 + Android SDK 35
   │  ├─ /app/public  前端页面(宿主机 ./public 只读挂载)
   │  ├─ /app/tasks   任务数据与 APK(宿主机 ./tasks,持久化)
   │  └─ /app/sdk/android  DCloud 离线 SDK(宿主机 ./sdk/android,只读挂载)
   ▼
Gradle 8.11.1 → assembleDebug / assembleRelease → APK
```

构建任务**串行排队**执行，避免并发构建把内存打满。

主要接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | 上传资源 ZIP（multipart，字段名 `file`，可选 `buildType=release`、`remark=构建说明`，资源类型始终自动识别） |
| GET | `/api/tasks?page=1&size=20` | 任务列表（分页） |
| DELETE | `/api/tasks` | 批量删除，body `{"ids":["..."]}`；同时删除日志与 APK，构建中的任务拒绝删除 |
| GET | `/api/tasks/:id/log` | 构建日志 |
| GET | `/api/tasks/:id/download` | 下载 APK |
| POST | `/api/tasks/:id/install` | 通过 adb 安装到设备 |
| GET | `/api/meta` | 服务与构建机信息 |

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Linux x86_64（推荐 Ubuntu 22.04 / Debian 12） |
| CPU / 内存 | 4 核 / 8 GB 起（Gradle 构建是内存大户） |
| 磁盘 | 20 GB 以上（镜像约 3 GB + Gradle 缓存 + APK 产物） |
| Docker | 24+，含 `docker compose` v2 插件 |
| 网络 | 开放 8848；构建机需能访问 `dl.google.com`（镜像构建装 Android SDK）与 Gradle/Maven 仓库 |
| 本地素材 | DCloud Android 离线 SDK 工程 `HBuilder-Integrate-AS`（含 `gradlew`、keystore） |

> 注意：compose 固定 `platform: linux/amd64`，因为 Android `build-tools` 只提供 linux-x86_64。ARM 服务器需 qemu 模拟，构建会非常慢，不建议。
> 构建时 Gradle + R8 峰值内存约 3~4 GB，服务器 8 GB 内存不要同时跑其他重负载服务。

## 3. 仓库侧已完成的准备

| 文件 | 内容 |
|---|---|
| `compose.yaml` | SDK 挂载改为项目内相对路径 `${DCLOUD_SDK_ANDROID:-./sdk/android}:/app/sdk/android:ro` |
| `.gitignore` | 保留 `package-lock.json`；忽略 `sdk/`、`public/HBuilder-Integrate-AS/`、`.env*`、`tasks/`、`uploads/` |
| `.dockerignore` | 排除 `sdk`、`public/HBuilder-Integrate-AS`、`.env*`、`tasks`、`uploads` |
| `sdk/android/simpleDemo/build.gradle` | release 改为 `minifyEnabled false` / `shrinkResources false`，规避 R8 缺失类报错 |
| `package-lock.json` | 已生成并入库，`Dockerfile` 的 `npm ci` 依赖它 |
| `sdk/android/` | SDK 已从 `public/` 移出，并清理了 `.gradle/`、`simpleDemo/build/`、`local.properties` |

**关键约束：SDK 工程绝对不能放在 `public/` 下。** 该目录由 `express.static` 直接对外提供，里面有 `*.keystore` 和含明文签名密码的 `build.gradle`。

## 4. 部署步骤

### 4.1 安装 Docker

按发行版官方文档安装，示例（Debian/Ubuntu）：

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
docker version && docker compose version
```

### 4.2 获取代码

方式 A：从 Git 仓库拉取

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone <仓库地址> dcloud-build-pro
cd dcloud-build-pro
```

方式 B：无 Git 仓库时，从开发机打包上传（排除依赖与产物）

```bash
# 开发机执行
rsync -av --exclude node_modules --exclude tasks --exclude uploads \
  /Users/fanyu/code/HBuilderX/dcloud-build-pro/ user@server:/opt/dcloud-build-pro/
```

### 4.3 放置 Android 离线 SDK

SDK 被 `.gitignore` 忽略，不会随代码仓库传输，需要单独拷贝：

```bash
# 开发机执行(sdk/android 已清理干净)
rsync -av /Users/fanyu/code/HBuilderX/dcloud-build-pro/sdk/android/ \
  user@server:/opt/dcloud-build-pro/sdk/android/
```

目录必须包含 `gradlew`、`settings.gradle`、`simpleDemo/` 及 keystore：

```bash
ls /opt/dcloud-build-pro/sdk/android/gradlew
```

如果 SDK 想放在别处，用环境变量覆盖挂载源（注意这是**宿主机路径**）：

```bash
DCLOUD_SDK_ANDROID=/data/dcloud-sdk docker compose up -d
```

或在 `compose.yaml` 同目录建 `.env`（该文件已被 git 忽略）：

```dotenv
DCLOUD_SDK_ANDROID=/data/dcloud-sdk
```

### 4.4 构建并启动

```bash
cd /opt/dcloud-build-pro
docker compose up -d --build
docker compose logs -f node-service
```

启动日志应打印：

```
dcloud-build-pro 已启动:
  本机访问   http://localhost:3000
  局域网访问 http://<容器IP>:3000
```

若出现 `[提示] 未检测到 DCloud Android 离线 SDK 工程`，说明 4.3 的路径不对，容器内 `/app/sdk/android/gradlew` 不存在。

### 4.5 开放端口

```bash
sudo ufw allow 8848/tcp        # 或按公司防火墙/安全组放行
```

访问 `http://<服务器IP>:8848`。

### 4.6 部署验证清单

1. 页面正常打开，favicon 显示正常；
2. 上传一个 Debug 资源 ZIP → 状态从 `排队` 变为 `构建中` 再到 `成功`；
3. 点“下载 APK”，文件名为原名（下载保存名不变），磁盘上的 APK 名带时间戳；
4. 上传 Release 资源 ZIP，确认不再出现 `lintVitalAnalyzeRelease` 报错；
5. 任务列表分页可翻页；
6. 日志弹窗能实时看到 Gradle 输出；
7. `tasks/` 下每个任务只保留 `artifact/` 与 `build.log`，没有完整 Android 工程副本。

## 5. 配置说明

### 5.1 容器环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 容器内监听端口（宿主机映射为 8848） |
| `NODE_ENV` | `production` | 生产环境，不加载 `.env.development` |
| `DCLOUD_SDK_ANDROID` | `/app/sdk/android` | 容器内 SDK 路径，与挂载目标一致 |
| `TZ` | `Asia/Shanghai` | 影响 APK 文件名时间戳与日志时间 |
| `MAX_UPLOAD_MB` | `2048` | 上传 ZIP 大小上限（MB），超限返回 413 |
| `BUILD_TIMEOUT_MIN` | `40` | 单次构建超时（分钟） |
| `HOST` | `0.0.0.0` | 监听地址，容器内不要改 |

修改方式：直接改 `compose.yaml` 的 `environment`，然后 `docker compose up -d`。

### 5.2 端口与卷

| 类型 | 宿主机 | 容器 | 说明 |
|---|---|---|---|
| 端口 | `8848` | `3000` | 改宿主机端口只需改 compose 冒号左边 |
| 卷 | `./tasks` | `/app/tasks` | 任务记录 `tasks.json`、`build.log`、APK，**必须持久化** |
| 卷 | `./public` | `/app/public` | 只读挂载，改前端后 `restart` 即生效 |
| 卷 | `./sdk/android` | `/app/sdk/android` | 只读挂载，构建时复制到任务目录再改 |
| 卷 | `gradle-cache` | `/root/.gradle` | 命名卷，复用 Gradle 发行版与依赖缓存 |

## 6. 日常运维

```bash
cd /opt/dcloud-build-pro

# 查看状态与日志
docker compose ps
docker compose logs -f --tail=200 node-service

# 重启服务(改了前端页面时只需这一条)
docker compose restart

# 更新代码(后端/依赖变更需重新构建镜像)
git pull && docker compose up -d --build

# 更新 SDK:直接替换 sdk/android 内容,无需重启(下次构建自动读取)

# 进入容器排查
docker compose exec -T node-service sh
docker compose exec -T node-service ls /app/sdk/android

# 查看磁盘占用
du -sh tasks sdk/android
docker system df
```

### 备份

任务记录是单文件 JSON，APK 可按需保留：

```bash
cd /opt/dcloud-build-pro
tar czf /backup/tasks-$(date +%F).tar.gz tasks/tasks.json
```

### 清理

- 历史 APK 与日志：按需删除 `tasks/<taskId>/` 整个目录；服务会自动同步磁盘状态，无需重启；
- Gradle 缓存过大：`docker compose down` 后 `docker volume rm dcloud-build-pro_gradle-cache`（下次构建会重新下载）；
- 镜像清理：`docker builder prune`、`docker image prune`。

### 停止 / 卸载

```bash
docker compose down            # 停止并删除容器,保留 tasks 与缓存卷
docker compose down -v         # 连 gradle-cache 卷一起删除(APK 仍在宿主机 ./tasks)
```

## 7. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动日志提示“未检测到 SDK” | `sdk/android/gradlew` 缺失或挂载路径错 | `docker compose exec -T node-service ls /app/sdk/android/gradlew` |
| 镜像构建失败在 `npm ci` | 缺 `package-lock.json` 或与 `package.json` 不一致 | 本地 `npm install --package-lock-only` 后提交 |
| 上传报 `EXDEV: cross-device link` | `uploads` 与 `tasks` 跨设备 | 已改为复制+删除；不要把两者挂到不同分区 |
| 上传返回 413 | ZIP 超过 `MAX_UPLOAD_MB` | 调大该变量并 `docker compose up -d` |
| Release 报 `lintVitalAnalyzeRelease` 无法解析 `lint-gradle` | 离线/lint 依赖缺失 | 构建命令已追加 `-x lintVitalAnalyzeRelease -x lintVitalRelease`；同时 release 已关闭 R8 |
| R8 报大量 missing class（`java.awt.*` 等） | 混淆规则不完整 | 保持 `minifyEnabled false`（当前配置） |
| 构建卡在下载 Gradle/依赖 | 服务器无法访问网络或 DNS 异常 | 检查出网；wrapper 已用腾讯云镜像；必要时配置 Docker DNS |
| 构建一直“构建中”后失败 | 超过 `BUILD_TIMEOUT_MIN` | 看 `tasks/<id>/build.log` 末尾，或调大超时 |
| 页面样式/图标没更新 | 浏览器缓存 | 强制刷新；`public` 是挂载目录，`restart` 即可 |
| 点“安装 APK”提示无设备 | 服务器没启动 adb 服务或没插 USB 设备 | 见 8.3，服务器部署通常不可用 |
| 清空 `tasks/` 后列表仍有数据 | 旧版本内存缓存 | 当前版本已按文件指纹同步，刷新页面即可 |

## 8. 安全须知

### 8.1 无鉴权

服务默认**没有任何登录或鉴权**，能访问 8848 的人都可以上传资源、下载他人 APK、调用 adb 接口。仅在可信局域网内部署；若需公网访问，至少在 Nginx 层加 Basic Auth / IP 白名单，并在应用层加鉴权。

### 8.2 签名文件

`sdk/android/simpleDemo/build.gradle` 含明文 `keyPassword` / `storePassword`，同目录有 keystore。因此：

- `sdk/` 已加入 `.gitignore`，禁止入库；
- 禁止把 SDK 放进 `public/`（会被静态服务直接下载）；
- 服务器上建议限制目录权限：`chmod 600 sdk/android/simpleDemo/*.keystore`，并只允许部署账号读取。

### 8.3 adb 相关

“安装 APK / 无线调试”依赖宿主机 adb 服务：

```bash
# 宿主机执行,允许容器通过 TCP 连接
adb -a -P 5037 nodaemon server
```

容器通过 `host.docker.internal:5037` 访问。服务器通常没有 USB 调试设备，该功能会提示无设备，属预期行为；不需要时可从前端隐藏入口。

## 9. 已知限制

1. **串行构建**：任务按队列逐个执行，多人同时上传会排队等待；
2. **仅 linux/amd64**：ARM 服务器需模拟，性能不可接受；
3. **Release 关闭了混淆与资源压缩**：为规避 R8 报错，产物体积略大；如需混淆要补齐 keep 规则后再开启；
4. **videoplayer 模块缺失**：部分 App 打开视频会提示“打包时未添加 videoplayer 模块”，需在 SDK 的 `dcloud_properties.xml` / 模块配置中启用，与部署无关；
5. **任务数据为单文件 JSON**：适合中小团队并发量，不适合高并发写入。
