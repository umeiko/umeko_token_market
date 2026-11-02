---
layout: home
hero:
  name: Umeko Token Relay
  text: 让闲置算力，<br>成为可调用的模型服务。
  tagline: 家中自托管模型，云端统一分发。无需公网 IP，也能提供 OpenAI 兼容 API。
  image:
    src: /logo.svg
    alt: Umeko Token Relay
  actions:
    - theme: brand
      text: 五分钟上手
      link: /start/quick-start
    - theme: alt
      text: 查看架构设计
      link: /reference/architecture
features:
  - title: 从这里开始
    details: 部署云端、构建 utoken，把已有 llama.cpp、vLLM 或 SGLang 服务接入云端。
    link: /start/quick-start
    linkText: 完成第一次调用
  - title: 三种本地入口
    details: Docker 风格 CLI 为核心，本机 Web 与 Qt/QML 只是同一个服务的管理界面。
    link: /guide/local
    linkText: 了解 utoken
  - title: 分发、计费与并发
    details: 独立 API Key、模型价格、Token 与费用额度、RPM 和双层并发控制。
    link: /guide/billing
    linkText: 查看运营能力
  - title: 面向开发者
    details: 阅读组件边界、数据模型、公开与管理 API，以及反向隧道消息协议。
    link: /reference/api
    linkText: 浏览技术参考
---

<div class="home-note">
Umeko Token Relay 不启动或管理推理进程。你的模型继续运行在原来的 llama.cpp、vLLM 或 SGLang 中，本地 utoken 只通过主动建立的反向隧道完成转发；云端统一处理鉴权、限额、计费与审计。
</div>
