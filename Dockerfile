# 构建环境:Node 20 + JDK 17 + Android SDK(compileSdk 35 / build-tools 35.0.0)
# Android SDK 官方 build-tools 仅提供 linux-x86_64,故镜像固定为 linux/amd64
# 基础镜像默认走国内镜像源,Docker Hub 不可用时也能构建;可用 --build-arg BASE_IMAGE=... 覆盖
ARG BASE_IMAGE=docker.m.daocloud.io/library/node:20-bookworm-slim
FROM --platform=linux/amd64 ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH

# Debian 软件源换成国内镜像,避免 apt 拉取超时
RUN sed -i -e 's|deb.debian.org|mirrors.aliyun.com|g' \
           -e 's|security.debian.org|mirrors.aliyun.com|g' \
           /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless \
      curl \
      unzip \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
RUN mkdir -p /opt/android-sdk/cmdline-tools \
    && curl -fsSL -o /tmp/cmdline-tools.zip "$CMDLINE_TOOLS_URL" \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-tools \
    && mv /tmp/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm -rf /tmp/cmdline-tools.zip /tmp/cmdline-tools \
    && yes | sdkmanager --licenses > /dev/null \
    && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
    && rm -rf /opt/android-sdk/.temp /root/.android/cache

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 3000

CMD ["npm", "run", "start"]
