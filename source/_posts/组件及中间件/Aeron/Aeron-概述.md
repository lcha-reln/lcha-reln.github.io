---
title: Aeron 概述
tags:
  - 高性能
  - 高可用
  - 分布式
  - Aeron
categories:
  - 高性能组件
  - Aeron
abbrlink: fdcdfbb5
date: 2026-03-07 20:06:49
---

> **Aeron** 是由 Real Logic 开发、Adaptive Financial Consulting 维护的高性能消息传输框架，专为金融交易、游戏服务器、低延迟分布式系统等对延迟极度敏感的场景设计。其核心目标：**可预测的超低延迟 + 极高吞吐**。
>
> 本文是 Aeron 系列的总览与导航，先建立整体心智模型，再按主题分篇深入。文末附**阅读路线**。

<!-- more -->

# 1. 性能特征
- **超低延迟**：单机环境下可达微秒级延迟
- **高吞吐量**：在微秒级延迟下依然能处理 100W+/秒的消息
- **延迟可预测**：提供个位数微秒的可预测延迟，确保系统行为稳定

# 2. 核心能力
- **高可用性**：为关键任务提供高可用和容错架构，减少服务中断风险
- **可扩展性**：支持水平扩展，满足现代分布式系统的增长需求
- **多语言支持**：原生支持 Java 和 C++，并提供对应的客户端库

> 与 Kafka、RabbitMQ 等传统消息中间件不同，Aeron **不是一个消息 Broker**，而是一个传输层框架——它的设计思路是「将 ordered log buffer 跨进程/跨网络高效复制，并提供可预测的延迟」。

# 3. 三大顶层组件

Aeron 生态自底向上分为三层，上层依赖下层：

<div class="mermaid">
graph TD
  subgraph L3["Aeron Cluster (RAFT容错集群)"]
    C1["多节点复制"]
    C2["故障自恢复"]
    C3["有序日志"]
    C4["注: RAFT 共识、定时器"]
  end
  subgraph L2["Aeron Archive (持久化录制/回放)"]
    B1["流录制到磁盘"]
    B2["任意位置回放"]
    B3["流复制"]
    B4["注: 日志持久化、Snapshot"]
  end
  subgraph L1["Aeron Transport (核心传输层)"]
    A1["UDP / IPC"]
    A2["发布/订阅模型"]
    A3["零拷贝传输"]
    A4["注: 节点/客户端通信"]
  end
  L3 -->|"上层依赖下层"| L2
  L2 -->|"上层依赖下层"| L1
</div>

| 组件 | 定位 | 何时需要 |
|------|------|----------|
| **Aeron Transport** | 核心传输层，提供发布/订阅、零拷贝、可靠 UDP/IPC | 任何 Aeron 应用都直接或间接用它 |
| **Aeron Archive** | 在 Transport 之上增加流的录制与回放（持久化） | 需要历史回放、A/B 测试、断线追赶、磁盘缓冲 |
| **Aeron Cluster** | 在 Archive 之上实现 RAFT 共识，构建确定性高可用服务 | 需要「故障容错 + 高性能 + 有序状态」的有状态服务（如撮合引擎） |

# 4. 架构设计

## 4.1 三层架构概述
Aeron 采用三层架构设计，各层职责清晰：
- **Client API**：应用程序与 Aeron 交互的入口，提供统一的编程接口，屏蔽底层传输细节
- **Media Driver**：核心引擎，负责管理所有网络和 IPC 通信，处理消息的发送、接收、路由与缓冲；支持嵌入式（与应用同进程）和独立进程两种部署模式
- **Transport Layer**：底层传输层，支持 UDP 单播、UDP 组播、IPC 等多种传输方式

<div class="mermaid">
graph LR
  subgraph C["客户端 api (Client api)"]
    C1["publication"]
    C2["subscription"]
  end
  subgraph M["通信媒体驱动器 (media driver)"]
    M1["media driver 节点1"]
    M2["media driver 节点2"]
    M3["media driver 节点3"]
    M4["media driver 节点4"]
  end
  subgraph T["传输层 (transport layer)"]
    T1["transport 节点1"]
    T2["transport 节点2"]
  end
  C1 -->|"publication的offer"| M1
  M2 -->|"subscription的poll"| C2
  M3 -->|"网络传输 ipc"| T1
  M4 -->|"udp 广播 multicast"| T2
</div>

## 4.2 Channel、Stream、Session
这三个概念构成了 Aeron 消息寻址的层次体系：

| 概念 | 标识方式 | 说明 |
|------|----------|------|
| Channel | URI（如 `aeron:udp?endpoint=localhost:20121`） | 物理传输通道，对应一个 UDP 端口或 IPC 连接，一个 Channel 可承载多个 Stream |
| Stream | streamId（整数） | Channel 内部的有序逻辑消息流，同一 Stream 内的消息保证有序传递 |
| Session | sessionId（整数） | 区分同一 Stream 上的不同 Publisher，每个 Publisher 拥有唯一的 sessionId |

因此 `Channel + StreamId + SessionId` 是标识一条消息流的最小粒度。Aeron 仅保证**同一 Session 内**的消息顺序，跨 Session 无全局顺序保证。

> 详见：[Aeron Channel、Stream 和 Session 深度解析](/posts/43d5f152/)

## 4.3 Publisher、Media Driver、Subscriber

<div class="mermaid">
sequenceDiagram
    participant P as publication
    participant M as media driver
    participant S as subscription
    P->>M: offer (buffer)
    M->>S: 处理 路由
    S->>M: poll (fragmenthandler)
    M->>P: 状态反馈
</div>

数据流向的三大角色：

- **Publication（发布端）**：应用通过 `publication.offer(buffer, offset, length)` 发送消息，数据写入 **Term Buffer**（环形缓冲区），整个过程非阻塞。`offer()` 返回值区分发送成功（`> 0`）、背压（`BACK_PRESSURED`）、无订阅者（`NOT_CONNECTED`）、管理操作（`ADMIN_ACTION`）、已关闭（`CLOSED`）等状态。
- **Media Driver（核心引擎）**：后台运行 Sender / Receiver / Conductor 线程，负责从 Term Buffer 读数据封帧发送、消息路由、流量控制、基于 NAK 的选择性重传。
- **Subscription（订阅端）**：应用通过 `subscription.poll(fragmentHandler, fragmentLimit)` 主动轮询接收，Media Driver 负责分片重组、保序、回调交付，并通过 Position 反向上报实现端到端背压。

> 编程细节详见：[Aeron 编程模型深度解析](/posts/406b47f8/)；引擎内部详见：[Aeron Media Driver 深度解析](/posts/bc5589ca/)

---

# 5. 阅读路线

本系列按「概念 → 引擎 → 传输 → 编程 → 持久化 → 集群/运维」的顺序组织，建议依次阅读，也可按需跳转：

| # | 主题 | 内容速览 |
|---|------|----------|
| 0 | **Aeron 概述**（本文） | 整体心智模型、三大顶层组件、阅读导航 |
| 1 | [Channel、Stream、Session 深度解析](/posts/43d5f152/) | 三级寻址模型、推模式地址方向、顺序性保证范围、Session 生命周期 |
| 2 | [Media Driver 深度解析](/posts/bc5589ca/) | Conductor/Sender/Receiver 三 Agent、线程模型、部署模式、Java vs C 实现 |
| 3 | [传输模式与 NAK 流控深度解析](/posts/fbf83150/) | UDP 单播/多播/IPC、为何不用 TCP、NAK 重传协议、滑动窗口流控 |
| 4 | [编程模型深度解析](/posts/406b47f8/) | Publication（offer/tryClaim/分片）、Subscription（poll/FragmentAssembler）、Log Buffer/Image、Position、MDC、快速入门 |
| 5 | [Aeron Archive 深度解析](/posts/987bb85b/) | 录制/回放、Catalog/Segment、Spy 订阅、扩展/截断/复制、ReplaySession 内部 |
| 6 | [Aeron Cluster 与运维工具](/posts/fed0dafe/) | RAFT 共识、运维工具箱（AeronStat 等）、背压缓解、性能调优、URI 速查表 |

---

## 参考资料

- [Aeron 官方文档](https://aeron.io/docs/)
- [Aeron GitHub 仓库](https://github.com/aeron-io/aeron)
- [Aeron Cookbook 示例代码](https://github.com/aeron-io/aeron-cookbook-code)

*Aeron® 是 Adaptive Financial Consulting Ltd 的注册商标。*
