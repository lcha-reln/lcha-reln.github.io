---
title: Aeron 概述
date: 2026-03-07 20:06:49
tags:
  - 高性能
  - 高可用
  - Aeron
categories:
  - Aeron
---
# 1.性能特征
- 超低延迟表现：单机环境下可达微秒级
- 高吞吐量：微秒级延迟下依然能处理100W+/秒
- 延迟可预测：提供单位数微妙的可预测延迟，确保系统行为稳定

# 2.核心能力
- 高可用性保障：为关键任务提供高可用和容错架构，确保系统稳定运行，减少服务中断的风险
- 卓越的可扩展性：无缝扩展，满足现代分布式系统的增长需求
- 多语言支持：支持 Java，C++等多种语言

# 3.架构设计
## 3.1.三层架构概述
- ClientAPI：应用程序通过 ClientAPI 与 Aeron 交互，提供统一的编程接口，屏蔽底层的传输细节
- Media Driver：作为中央消息路由和处理引擎，管理所有网络和IPC通信，处理消息的发送、接收、路由、缓冲，可嵌入应用或者独立运行
- Transport Layer：传输层 

![[Aeron架构.png]](/images/Aeron/Aeron架构.png)

## 3.2.Channel、Stream、Session
- Channel：代表一个传输通道，如UDP端口或者IPC连接，通过URI标识，是消息传输的物理路径，一个 Channel 可以承载多个逻辑流
- Stream：是 Channel 内部的有序消息流，由 streamId 标识，同一个 Stream 内的消息保证有序传递，不同应用可创建不同 Session向此 Stream 发布数据
- Session：用于区分同一个 Stream 上的不同 Pub，由 Session ID 标识，用于区分同一 Stream 上的不同数据源，每个 Pub 都有唯一的 Channel+Stream+Session 组合
**这里怎么去理解 Session 比较好：**
- 每个 SessionId 都对应一个 Pub 发送端
- 多个 pub 可以共同使用一个 Stream 来发送消息
- 所以 SessionId 其实是 Pub 的唯一标识，因此 Channel+Stream+Session 能够最小纬度的标识一个消息流

## 3.3 Pub，Media Driver，Sub
![[Pub，Media Driver，Sub.png]](/images/Aeron/Pub，Media Driver，Sub.png)

Publication
pub.offer是用来发送消息的，app 调用 publication.offer(Buffer, Offset, Length)发消息
数据被写到 term buffer，环形队列缓冲区，非阻塞的发送方式
**有几种发送响应**
- 0:成功发送，返回新的位置值
- BACK_PRESSURES：背压状态，需要稍后重试
- NOT_CONNECTED：Pub 未连接到任何的 Sub
- ADMIN_ACTION：正在进行管理操作，请稍后重试
- CLOSED：Pub 关闭

Media driver
sender线程：从 term buffer读取消息数据，对消息进行封装，添加 aeron 消息协议头
消息路由：通过 channel + StreamId 确定消息的发送目标
流控：监控网络状态，对数据发送进行背压控制
消息重传：基于 nak 否定确认机制，对丢失的消息进行重传（参考：[[Aeron通信模式及NAK机制与流控]]）

Subscription
sub.poll是用来接收消息的，app调用 subscription.poll(framenthandler)实现
涉及到对数据的重组：他可以对网络数据包重组为完整的消息
保序：确保消息按照正确的顺序传递给应用
回调：通过framenthandler回调，将消息传递给应用
返回值：代表轮询处理的消息片段数量
状态反馈机制：
- pos 更新：media driver 会向 pub 报告消息的传输进度
- 背压：如果接收端处理不过来，会向发送端发送背压信号