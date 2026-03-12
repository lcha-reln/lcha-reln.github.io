---
title: Aeron 概述
date: 2026-03-07 20:06:49
tags:
  - 高性能
  - 高可用
  - Aeron
categories:
  - 高性能组件
  - Aeron
---
# 1. 性能特征
- **超低延迟**：单机环境下可达微秒级延迟
- **高吞吐量**：在微秒级延迟下依然能处理 100W+/秒的消息
- **延迟可预测**：提供个位数微秒的可预测延迟，确保系统行为稳定

# 2. 核心能力
- **高可用性**：为关键任务提供高可用和容错架构，减少服务中断风险
- **可扩展性**：支持水平扩展，满足现代分布式系统的增长需求
- **多语言支持**：原生支持 Java 和 C++，并提供对应的客户端库

# 3. 架构设计
## 3.1 三层架构概述
Aeron 采用三层架构设计，各层职责清晰：
- **Client API**：应用程序与 Aeron 交互的入口，提供统一的编程接口，屏蔽底层传输细节
- **Media Driver**：核心引擎，负责管理所有网络和 IPC 通信，处理消息的发送、接收、路由与缓冲；支持嵌入式（与应用同进程）和独立进程两种部署模式
- **Transport Layer**：底层传输层，支持 UDP 单播、UDP 组播、IPC 等多种传输方式

![[Aeron架构.png]](/images/Aeron/Aeron架构.png)

## 3.2 Channel、Stream、Session
这三个概念构成了 Aeron 消息寻址的层次体系：
| 概念 | 标识方式 | 说明 |
|------|----------|------|
| Channel | URI（如 `aeron:udp?endpoint=localhost:20121`） | 物理传输通道，对应一个 UDP 端口或 IPC 连接，一个 Channel 可承载多个 Stream |
| Stream | streamId（整数） | Channel 内部的有序逻辑消息流，同一 Stream 内的消息保证有序传递 |
| Session | sessionId（整数） | 区分同一 Stream 上的不同 Publisher，每个 Publisher 拥有唯一的 sessionId |

**如何理解 Session：**
- 每个 sessionId 唯一对应一个 Publisher 实例
- 多个 Publisher 可以向同一个 Stream 发布消息，通过 sessionId 加以区分
- 因此 `Channel + StreamId + SessionId` 是标识一条消息流的最小粒度

## 3.3 Publisher、Media Driver、Subscriber

![三大将](/images/Aeron/三大将.png)

### Publication
应用通过 `publication.offer(buffer, offset, length)` 发送消息。数据写入 **Term Buffer**（环形缓冲区），整个过程非阻塞。
`offer()` 的返回值含义如下：
| 返回值 | 含义 |
|--------|------|
| `> 0` | 发送成功，返回新的流位置值 |
| `BACK_PRESSURED` | 背压状态，下游处理不过来，需稍后重试 |
| `NOT_CONNECTED` | 当前没有任何 Subscriber 连接 |
| `ADMIN_ACTION` | 正在执行管理操作（如日志轮转），需稍后重试 |
| `CLOSED` | Publication 已关闭 |

### Media Driver
Media Driver 在后台运行多个职责线程：
- **Sender 线程**：从 Term Buffer 读取数据，封装 Aeron 协议头，发往网络或 IPC
- **消息路由**：根据 `Channel + StreamId` 确定目标地址
- **流量控制**：持续监控网络状态，在检测到拥塞时向 Publisher 施加背压
- **消息重传**：基于 NAK（否定确认）机制，对 Subscriber 报告丢失的消息进行选择性重传（详见：Aeron 通信模式及 NAK 机制与流控）

### Subscription
应用通过 `subscription.poll(fragmentHandler, fragmentLimit)` 接收消息，返回值为本次轮询处理的消息片段数量。
核心处理过程：
- **重组**：将网络层分片的数据包重新拼装为完整消息
- **保序**：确保消息按发布顺序交付给应用
- **回调**：通过 `FragmentHandler` 回调将消息传递给业务层

**状态反馈机制：**
- **Position 更新**：Subscriber 持续向 Media Driver 上报消费位置，Driver 再转发给 Publisher，用于流量控制
- **背压信号**：当 Subscriber 消费速度跟不上发布速度时，背压信号沿链路反向传播，Publisher 的 `offer()` 将返回 `BACK_PRESSURED`，以此实现端到端的流量自适应