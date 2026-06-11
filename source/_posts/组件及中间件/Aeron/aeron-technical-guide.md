---
title: Aeron 硬核技术深度解析
tags:
  - 高性能
  - 高可用
  - Aeron
categories:
  - 高性能组件
  - Aeron
abbrlink: 3879a72a
date: 2026-03-10 20:27:25
---

> **Aeron** 是由 Real Logic 开发、Adaptive Financial Consulting 维护的高性能消息传输框架，专为金融交易、游戏服务器、低延迟分布式系统等对延迟极度敏感的场景设计。其核心目标：**可预测的超低延迟 + 极高吞吐**。

## 1. 整体架构概览

Aeron 的核心设计思路是：**将 ordered log buffer 跨进程/跨网络高效复制，并提供可预测的延迟**。与传统消息中间件（Kafka、RabbitMQ）不同，Aeron 不是一个消息 broker，而是一个传输层框架。

### 1.1 三大顶层组件

```
┌─────────────────────────────────────────────────────────────────┐
│                         Aeron 生态系统                           │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │  Aeron Transport  │  │  Aeron Archive   │  │Aeron Cluster │ │
│  │  (核心传输层)     │  │  (持久化录制/回放)│  │(RAFT容错集群)│ │
│  │                  │  │                  │  │              │ │
│  │  • UDP / IPC     │  │  • 流录制到磁盘   │  │ • 多节点复制 │ │
│  │  • 发布/订阅模型  │  │  • 任意位置回放   │  │ • 故障自恢复 │ │
│  │  • 零拷贝传输     │  │  • 流复制        │  │ • 有序日志   │ │
│  └──────────────────┘  └──────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 核心架构图

```
 ┌────────────────────────────────────────────────────────────────┐
 │                      Client Application                        │
 │                                                                │
 │   ┌──────────────┐              ┌──────────────────┐          │
 │   │  Publication  │              │   Subscription   │          │
 │   └──────┬───────┘              └────────┬─────────┘          │
 │          │ write to log buffer            │ poll fragments     │
 │   ┌──────▼───────────────────────────────▼─────────────────┐  │
 │   │                   Client Conductor                      │  │
 │   │           (volatile fields + ring/broadcast buffers)    │  │
 │   └──────────────────────────┬──────────────────────────────┘  │
 └─────────────────────────────│──────────────────────────────────┘
                                │ IPC (cnc.dat / command-n-control)
 ┌─────────────────────────────▼──────────────────────────────────┐
 │                        Media Driver                             │
 │                                                                │
 │  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────┐  │
 │  │ Driver Conductor│  │    Sender    │  │    Receiver      │  │
 │  │  (命令调度中心) │  │  (数据发送)  │  │  (数据接收+NAK)  │  │
 │  └─────────────────┘  └──────┬───────┘  └────────┬─────────┘  │
 │                               │                   │            │
 │                       ┌───────▼───────────────────▼────────┐  │
 │                       │         Log Buffer (mmap file)      │  │
 │                       │  Term0 | Term1 | Term2 | Metadata   │  │
 │                       └─────────────────────────────────────┘  │
 └──────────────────────────────────────────────────────────────┬─┘
                                                                │
                                                     UDP / IPC  │
```

---

## 2. Media Driver 深度剖析

Media Driver 是 Aeron 的核心引擎，负责所有实际的数据收发与管理。

### 2.1 四大内部组件

| 组件 | 职责 | 线程名（Dedicated 模式） |
|------|------|--------------------------|
| **Driver Conductor** | 接收 Client 命令、协调 Sender/Receiver、名称解析 | `driver-conductor` |
| **Sender** | 从 Log Buffer 读取数据，经由 UDP/IPC 发送 | `sender` |
| **Receiver** | 接收 UDP 数据，写入本地 Log Buffer，发送 NAK/Status 消息 | `receiver` |
| **Client Conductor** | 客户端侧，与 Driver Conductor 通信 | （嵌入客户端） |

### 2.2 Media Driver 工作目录结构

生产环境推荐将 Media Driver 目录挂载在 `/dev/shm`（内存文件系统）。

```
/dev/shm/aeron-<user>/
├── blank.template          # 空 Log Buffer 模板，用于快速复制创建新 Publication
├── cnc.dat                 # Command-n-Control 内存映射文件（Client <-> Driver IPC）
│                           # 也是 Aeron Counters 的存储位置（AeronStat 读取此文件）
├── loss-report.dat         # 记录所有 UDP 丢包事件（LossStat 工具读取）
├── publications/
│   ├── 1.logbuffer         # Publication 1 的 Log Buffer（3 个 Term + Metadata）
│   └── 2.logbuffer         # Publication 2 的 Log Buffer
└── images/
    └── <sessionId>.logbuffer  # 远端 Publication 的本地镜像（Image）
```

> **注意**：每个 Publication 的 Log Buffer 大小 = **3 × termBufferLength + metadata**。若 termBufferLength = 128MB，则单个 Publication 约占 **~384MB**。需提前规划 `/dev/shm` 的空间。

### 2.3 四种线程模式

```
模式对比：线程数 vs 性能 vs 适用场景

DEDICATED (默认)        3 线程：Conductor + Sender + Receiver
  ├── 最高性能
  ├── 可绑定到独立 CPU 核心（CPU Affinity）
  └── 适合：生产环境、高性能要求

SHARED_NETWORK          2 线程：[Sender+Receiver] + Conductor
  ├── 中等性能
  └── 适合：资源受限但仍需网络传输

SHARED                  1 线程：[Sender+Receiver+Conductor]
  ├── 最低资源占用
  └── 适合：开发环境、测试环境

INVOKER                 0 线程（调用方负责 duty cycle）
  ├── 无独立线程启动
  └── 适合：需要嵌入到现有线程模型的场景
```

**Dedicated 模式线程配置示例：**

```java
MediaDriver.Context ctx = new MediaDriver.Context()
    .threadingMode(ThreadingMode.DEDICATED)
    .senderIdleStrategy(new BusySpinIdleStrategy())       // Sender：忙等
    .receiverIdleStrategy(new BusySpinIdleStrategy())     // Receiver：忙等
    .conductorIdleStrategy(new BackoffIdleStrategy());    // Conductor：退避等待
```

### 2.4 关键配置项

| 配置项 | 作用 | 注意事项 |
|--------|------|----------|
| `errorHandler` | 捕获 Media Driver 错误 | **必须设置**，否则错误静默丢失 |
| `aeronDirectoryName` | Driver 工作目录（Client 共享路径） | 多个 Client 可共享同一个 Driver |
| `deleteDirOnStart` | 启动时删除旧目录 | `true` 时若有运行中的 Driver 会导致其崩溃 |
| `deleteDirOnShutdown` | 退出时清理目录 | 生产环境建议 `false` |
| `publicationTermBufferLength` | UDP Publication Term 大小 | 必须是 2 的幂次，范围 64KB~1GB |
| `ipcTermBufferLength` | IPC Publication Term 大小 | 同上 |

### 2.5 C Media Driver

Real Logic 提供了 C 语言实现的 Media Driver，将性能敏感部分完全移出 JVM 与 GC 管辖范围：

```
优势：
  • 完全绕过 JVM GC stop-the-world 暂停
  • 更低的系统调用开销
  • 支持 kernel bypass（配合 OpenOnload / DPDK）

使用方式：
  • Java 客户端只需将 aeronDirectoryName 指向 C Driver 的目录
  • 对应用代码完全透明

C Driver 配置方式（两者等价）：
  命令行：-Daeron.driver.timeout=30000
  环境变量：AERON_DRIVER_TIMEOUT=30000
```

---

## 3. Channel / Stream / Session 三层寻址模型

Aeron 采用三级寻址体系，理解这个模型是使用 Aeron 的基础。

### 3.1 三层概念

```
┌─────────────────────────────────────────────────────────┐
│  Channel（通道）                                         │
│  • 类似 TCP/IP 的地址+端口，定义物理传输路径             │
│  • 示例：aeron:udp?endpoint=server1:6868               │
│           aeron:ipc                                      │
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Stream ID（流 ID）                                │  │
│  │  • 在同一 Channel 上多路复用不同数据流              │  │
│  │  • 整数类型，由开发者定义语义                       │  │
│  │                                                    │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Session ID（会话 ID）                       │  │  │
│  │  │  • 唯一标识一个发送方                         │  │  │
│  │  │  • 随机整数（可为负数）                       │  │  │
│  │  │  • ExclusivePublication 每个实例独立 Session  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 3.2 多 Client 多 Stream 场景

```
Channel: server1:6868
                     ┌─────────────────────────────────────┐
Client Process 1 ───►│                                     │
(Stream 1)           │         Server Process 1            │
                     │                                     │
Client Process 2 ───►│  Subscription 1 (Stream 1)         │
(Stream 1)           │    ├── Image: Session 213897        │
                     │    └── Image: Session -421387       │
Client Process 3 ───►│                                     │
(Stream 2)           │  Subscription 2 (Stream 2)         │
                     │    └── Image: Session 2378636       │
                     └─────────────────────────────────────┘
```

**在 FragmentHandler 中识别来源：**

```java
void onFragment(DirectBuffer buffer, int offset, int length, Header header) {
    int streamId  = header.streamId();   // 区分不同业务流
    int sessionId = header.sessionId();  // 区分同一 Stream 上的不同发送方
    // 用 sessionId 作为 key 管理客户端状态
    ClientState state = clientStates.get(sessionId);
}
```

### 3.3 顺序性保证范围

> **关键规则**：Aeron 仅保证同一个 `Image`（即同一 channel/streamId/sessionId）内的消息顺序。
>
> **不保证**：跨 Session 的全局顺序。

---

## 4. Publication 发布端详解

Publication 是应用程序发送数据的主要接口，提供**非阻塞**的发送 API。

### 4.1 两种 Publication 类型

| 类型 | 创建方式 | 线程安全 | Session ID | 性能 |
|------|----------|----------|------------|------|
| `ConcurrentPublication` | `aeron.addPublication()` | 是（内部加锁） | 共享 | 略低 |
| `ExclusivePublication` | `aeron.addExclusivePublication()` | 否 | 独立 | 更高 |

> **最佳实践**：单线程发送用 `ExclusivePublication`，多线程共享发送用 `ConcurrentPublication`。

### 4.2 `offer` 方法

`offer` 是最常用的发送方式，**会将数据复制到 Log Buffer**。

```
offer() 返回值语义：

返回值 > 0   ✓  发送成功，值为新的流位置（stream position）
返回值 = -1  ✗  无订阅者连接（NOT_CONNECTED），非错误，可重试
返回值 = -2  ✗  被背压（BACK_PRESSURED），日志缓冲区满，需等待
返回值 = -3  ✗  管理员动作中（ADMIN_ACTION），Term 轮转，立即重试
返回值 = -4  ✗  Publication 已关闭（CLOSED），不可恢复
返回值 = -5  ✗  流已达最大位置（MAX_POSITION_EXCEEDED），需增大 Term 缓冲
```

**offer 的多个重载变体：**

```java
// 基础版本
long pos = pub.offer(buffer, offset, length);

// 双 Buffer 版本（header + body，零拷贝组合）
long pos = pub.offer(headerBuffer, hOffset, hLen, bodyBuffer, bOffset, bLen);

// 带 ReservedValueSupplier（注入 checksum 或 timestamp）
long pos = pub.offer(buffer, offset, length,
    (termBuffer, termOffset, frameLength) -> System.currentTimeMillis());

// DirectBufferVector 数组版本
long pos = pub.offer(new DirectBufferVector[]{vec1, vec2});
```

### 4.3 `tryClaim` 方法（零拷贝发送）

`tryClaim` 是性能更高的方式：**直接在 Log Buffer 上申请写入空间，无需额外复制**。

```
tryClaim 工作流程：

1. tryClaim(length, bufferClaim)
       │
       ▼
   [成功] 在 Log Buffer 中预留 length 字节空间
       │
       ▼
2. 直接向 bufferClaim.buffer() 写入数据
   (使用 bufferClaim.offset() 作为起始偏移！)
       │
       ▼
3. bufferClaim.commit()   ─── 提交，Media Driver 随即发送
   或
   bufferClaim.abort()    ─── 中止，释放预留空间
```

> **重要警告**：
> - 最大 claim 长度 = `maxPayloadLength()`（默认 MTU 1376 字节）
> - 必须在 unblock 超时（默认 15 秒）内 `commit()` 或 `abort()`，否则 Media Driver 强制 unblock
> - 使用 `bufferClaim.offset()` 而非 `0` 作为写入偏移，否则会损坏数据

```java
// tryClaim 标准使用模式
final BufferClaim bufferClaim = new BufferClaim(); // 每线程一个（ThreadLocal）

long result = publication.tryClaim(messageLength, bufferClaim);
if (result > 0) {
    try {
        MutableDirectBuffer buf = bufferClaim.buffer();
        int offset = bufferClaim.offset();
        // 直接写入，无拷贝
        buf.putInt(offset, myValue);
        buf.putBytes(offset + 4, myData, 0, myData.length);
        bufferClaim.commit();
    } catch (Exception e) {
        bufferClaim.abort();
    }
}
```

### 4.4 消息分片机制

```
当 offer 数据超过 maxPayloadLength() 时，Aeron 自动分片：

Application Message (200KB)
         │
         ▼
┌────────┬────────┬────────┬────────┐
│ Frag 1 │ Frag 2 │ Frag 3 │ Frag 4 │  ← 每片 ≤ MTU - 32字节头
│ BEGIN  │        │        │  END   │
└────────┴────────┴────────┴────────┘
         │ 网络传输（可能乱序到达）
         ▼
  接收端：FragmentAssembler 重新组装
         │
         ▼
  FragmentHandler.onFragment() 收到完整消息
```

> **注意**：`tryClaim` 不支持超过 `maxPayloadLength()` 的消息，因此不需要 `FragmentAssembler`。

### 4.5 异步构建 Publication（Aeron 1.35.0+）

```java
// 传统同步方式（会阻塞几毫秒）
Publication pub = aeron.addExclusivePublication(channel, streamId);

// 新的异步方式（适合对暂停敏感的 duty cycle）
long regId = aeron.asyncAddExclusivePublication(channel, streamId);
Publication pub = null;
while ((pub = aeron.getExclusivePublication(regId)) == null) {
    aeron.context().idleStrategy().idle();
    // 此处可以做其他事情
}
```

---

## 5. Subscription 订阅端详解

Subscription 用于接收消息流，必须在单线程内使用（非线程安全）。

### 5.1 基本轮询模式

Subscription 的核心设计是**主动轮询（polling）**而非事件回调，天然适配 Agrona Agent 的 duty cycle 模型。

```java
// 创建 Subscription（阻塞直到 Media Driver 响应）
Subscription sub = aeron.addSubscription(channel, streamId);

// 在 duty cycle 中轮询
@Override
public int doWork() throws Exception {
    // poll 返回值 = 消费的 fragment 数量（注意：不是消息数量）
    return subscription.poll(fragmentHandler, FRAGMENT_LIMIT);
}
```

### 5.2 FragmentHandler 注意事项

```java
// ⚠️ 关键约束：FragmentHandler 中收到的 buffer 只在本次 doWork 期间有效
// 不要持有 buffer 引用超过一个 duty cycle！

void onFragment(DirectBuffer buffer, int offset, int length, Header header) {
    // ✅ 正确：立即解码数据
    int value = buffer.getInt(offset);
    String msg = buffer.getStringAscii(offset + 4);
    process(value, msg);  // 传递值而非 buffer 引用

    // ❌ 错误：持有 buffer 引用
    // this.lastBuffer = buffer;  // 危险！Aeron 可能清除底层数据
}
```

### 5.3 大消息重组（FragmentAssembler）

```java
class MyService {
    // FragmentAssembler 维护内部状态用于重组分片消息
    private final FragmentAssembler assembler = new FragmentAssembler(this::onMessage);

    public int doWork() {
        // 将 assembler 作为 fragmentHandler 传入，而非 this
        return subscription.poll(assembler, FRAGMENT_LIMIT);
    }

    // 只有完整消息才会到达这里
    private void onMessage(DirectBuffer buffer, int offset, int length, Header header) {
        // 处理完整的重组消息
    }
}
```

### 5.4 受控轮询（ControlledFragmentHandler）

当需要精细控制消费进度时（例如消息处理失败需要重试），使用 `controlledPoll`：

```java
// 实现 ControlledFragmentHandler 接口
Action onFragment(DirectBuffer buffer, int offset, int length, Header header) {
    boolean success = processMessage(buffer, offset, length);
    if (!success) {
        return Action.ABORT;    // 取消本轮，下次重新消费（位置不推进）
    }
    return Action.CONTINUE;     // 继续处理下一个 fragment
}

// 可用的 Action 类型
// ABORT   - 回滚本轮所有位置，下次 poll 重新消费
// BREAK   - 停止继续 poll，提交当前已消费位置
// COMMIT  - 提交当前位置并继续 poll
// CONTINUE - 正常继续（等同于标准 poll 行为）
```

---

## 6. Log Buffer 与 Image 内存模型

Log Buffer 是 Aeron 零拷贝、低延迟的核心数据结构。

### 6.1 Log Buffer 物理结构

```
Log Buffer 文件结构（内存映射，通常在 /dev/shm）：

┌─────────────────────────────────────────────────────┐
│                    Log Buffer File                   │
│                                                      │
│  ┌────────────────┐ ← offset 0                      │
│  │     Term 0     │                                  │
│  │  (termLength)  │  状态: clean / active / dirty    │
│  ├────────────────┤ ← offset: termLength             │
│  │     Term 1     │                                  │
│  │  (termLength)  │                                  │
│  ├────────────────┤ ← offset: 2 × termLength         │
│  │     Term 2     │                                  │
│  │  (termLength)  │                                  │
│  ├────────────────┤ ← offset: 3 × termLength         │
│  │    Metadata    │  Term 状态、Term ID、位置信息等   │
│  └────────────────┘                                  │
└─────────────────────────────────────────────────────┘

每个 Term 内部：
┌────────┬──────────────┬────────┬──────────────┬─────┐
│ Header │   Message 1  │ Header │   Message 2  │ ... │
│ 32byte │              │ 32byte │              │     │
└────────┴──────────────┴────────┴──────────────┴─────┘
```

### 6.2 Term 状态轮转

```
Term 生命周期：

  clean ──► active ──► dirty ──► clean（被重置后）
    ↑                              │
    └──────────────────────────────┘

三个 Term 的轮转过程：
时刻 1: [Term0:active] [Term1:clean ] [Term2:clean ]
时刻 2: [Term0:dirty ] [Term1:active] [Term2:clean ]  ← Term0 写满，切换
时刻 3: [Term0:clean ] [Term1:dirty ] [Term2:active]  ← Term1 写满，切换
时刻 4: [Term0:active] [Term1:clean ] [Term2:dirty ]  ← 循环

Publication.offer() 返回 ADMIN_ACTION(-3)
  = Term 轮转的瞬间，应用层应立即重试
```

### 6.3 Term Buffer 大小约束

| 约束条件 | 值 |
|----------|----|
| 最小值 | 65,536 bytes（64KB） |
| 最大值 | 1,073,741,824 bytes（1GB） |
| 必须是 | 2 的幂次 |
| 单条消息最大长度 | min(16MB, termLength / 8) |
| 整个流的最大位置 | termLength × 2³¹ |

### 6.4 乱序重建与 Watermark

UDP 报文可能乱序到达，Aeron 通过 Log Buffer 正确重建有序流：

```
数据包到达顺序（乱序）：Msg3, Msg1, Msg4, Msg2

rcv-hwm（High Water Mark）= 已接收的最远位置
rcv-pos（Receiver Position）= 连续已完成的位置

时刻1: 收到 Msg3 → hwm=3, pos=0（Msg1/2 缺失，不能推进 pos）
时刻2: 收到 Msg1 → hwm=3, pos=1（Msg2 仍缺失）
时刻3: 收到 Msg4 → hwm=4, pos=1（Msg2 仍缺失）
时刻4: 发送 NAK（请求重传 Msg2）
时刻5: 收到 Msg2 → hwm=4, pos=4（连续，sub-pos 可推进到 4）

订阅端只在 rcv-pos 推进时收到新消息！
```

### 6.5 Image

Image 是 Subscription 端对某个 Publication 流的本地副本：
- 每个 `channel + streamId + sessionId` 组合对应一个 Image
- 存储在 Media Driver 的 `images/` 目录
- 通常不需要直接操作 Image，Aeron Cluster 的 snapshot 加载除外

---

## 7. Position 位置追踪体系

Position 是 Aeron 中唯一标识流中某个字节的全局指针，贯穿发送和接收的全链路。

### 7.1 完整的 Position 流转链

```
Publisher Application                    Subscriber Application
        │                                        │
        ▼                                        ▼
  ┌───────────┐  write   ┌──────────┐           ┌──────────────┐
  │  pub-pos  │─────────►│ Log Buf  │           │   sub-pos    │
  │(pub限流点)│          │          │           │(subscription │
  └───────────┘          └──────────┘           │   已消费位置)│
  ┌───────────┐             │ Sender             └──────────────┘
  │  pub-lmt  │◄────────────┤                    ┌──────────────┐
  │(背压控制) │             │ reads              │   rcv-hwm    │
  └───────────┘             ▼                    │(最远收到位置)│
                     ┌──────────┐  UDP/IPC        └──────────────┘
                     │  snd-pos │─────────────►  ┌──────────────┐
                     │(已发位置)│                │   rcv-pos    │
                     └──────────┘                │(连续完成位置)│
                     ┌──────────┐                └──────────────┘
                     │  snd-lmt │
                     │(发送窗口)│
                     └──────────┘
                     ┌──────────┐
                     │  snd-bpe │
                     │(背压计数)│
                     └──────────┘
```

### 7.2 Position 计算方式

```
position = (termId - initialTermId) × termLength + termOffset

其中：
  termOffset  = 消息在当前 Term 中的字节偏移
  termId      = 当前 Term 的 ID（递增）
  initialTermId = Publication 创建时的初始 Term ID

注意：Position 包含 Aeron 头部(32字节)和填充字节，
      不只是应用数据大小！MTU 大小会影响 Position 增量。
```

### 7.3 AeronStat Position 输出解读

```
28:    8,388,896 - pub-pos (sampled): 1 1985493803 1 aeron:udp?endpoint=localhost:2000
       ─────────   ───────────────────  ───────────  ─────────────────────────────────
       当前位置值    计数器类型            stream  session  channel
                                         Id      Id

发布方关键指标：
  pub-pos: 8,388,896    ← Publication 已写入位置
  pub-lmt: 8,388,896    ← 背压限制（snd-pos + 发送窗口）
  snd-pos:        64    ← Sender 已发送位置（若远小于 pub-pos，说明积压）
  snd-lmt:   131,360    ← Sender 窗口上限
  snd-bpe:         0    ← 背压事件次数（应始终为 0）

订阅方关键指标：
  rcv-hwm:        64    ← 接收到的最远位置
  rcv-pos:        64    ← 连续接收完成位置
  sub-pos:        64    ← 应用层已消费位置

健康检查：
  snd-pos ≈ pub-pos  → 无积压
  rcv-pos ≈ rcv-hwm  → 无乱序/丢包
  sub-pos ≈ rcv-pos  → 应用消费正常
```

---

## 8. Multi-Destination-Cast (MDC)

MDC 允许单个 Publication 同时发送数据到多个 Subscription，适合替代 UDP 多播（在不支持多播的环境中）。

### 8.1 MDC vs 标准 Publication

```
标准 Publication：
  Publication.channel → 指向 Subscription 的地址
  Subscription.channel → 本机监听地址

动态 MDC（地址方向反转）：
  Publication.channel → 本机地址（订阅方来连接我）
  Subscription.channel → 指向 Publication 的控制地址
```

### 8.2 动态 MDC 拓扑图

```
┌─────────────────────────────────────────────────────────────────┐
│                    MDC Publisher Process                         │
│                                                                  │
│  Publication Channel:                                            │
│  aeron:udp?control-mode=dynamic|control=10.1.0.2:20121         │
│                          │                                       │
│                          │ 控制平面（Subscriptions 动态注册）    │
└──────────────────────────┼───────────────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
            ▼              ▼              ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │  Subscriber 1 │ │  Subscriber 2 │ │  Subscriber 3 │
   │ 10.1.0.3:0   │ │ 10.1.0.4:0   │ │ 10.1.0.5:0   │
   │              │ │              │ │              │
   │ channel:     │ │ channel:     │ │ channel:     │
   │ aeron:udp?   │ │ aeron:udp?   │ │ aeron:udp?   │
   │ endpoint=    │ │ endpoint=    │ │ endpoint=    │
   │ 10.1.0.3:0|  │ │ 10.1.0.4:0|  │ │ 10.1.0.5:0|  │
   │ control=     │ │ control=     │ │ control=     │
   │ 10.1.0.2:    │ │ 10.1.0.2:   │ │ 10.1.0.2:   │
   │ 20121|       │ │ 20121|       │ │ 20121|       │
   │ control-mode │ │ control-mode │ │ control-mode │
   │ =dynamic     │ │ =dynamic     │ │ =dynamic     │
   └──────────────┘ └──────────────┘ └──────────────┘
```

### 8.3 MDC 流控策略

```
三种流控策略（当慢消费者拖累快消费者时的处理方式）：

┌──────────────────────────────────────────────────────────────┐
│  max（默认）：以最快订阅者为准                                │
│    • 快消费者不受慢消费者影响                                 │
│    • 慢消费者可能丢包                                         │
│    • 配置：fc=max                                             │
├──────────────────────────────────────────────────────────────┤
│  min：以最慢订阅者为准                                        │
│    • 所有订阅者保证无丢包                                     │
│    • Publication 速度受最慢订阅者限制                         │
│    • 配置：fc=min                                             │
│    • 支持 group size：fc=min,g:/5（至少5个订阅者才算connected）│
├──────────────────────────────────────────────────────────────┤
│  tagged：精细分组控制                                         │
│    • 部分订阅者加入流控组（tagged），其余不参与              │
│    • Publication 速度受 tagged 订阅者中最慢的限制             │
│    • 非 tagged 订阅者可能丢包但不影响 tagged 组               │
│    • 配置：Publication: fc=tagged,g:101                      │
│             Subscriber（受控）: gtag=101                      │
│             Subscriber（不受控）: 不设 gtag                   │
└──────────────────────────────────────────────────────────────┘
```

**代码配置示例：**

```java
// Publication：动态 MDC + Tagged 流控 + 组大小5
String pubChannel = "aeron:udp?control-mode=dynamic"
    + "|control=10.1.0.2:20121"
    + "|fc=tagged,g:101/5";   // tag=101, 至少5个tagged订阅者

// Subscription（参与流控）：
String subChannel = "aeron:udp?endpoint=10.1.0.3:0"
    + "|control=10.1.0.2:20121"
    + "|control-mode=dynamic"
    + "|gtag=101";

// Subscription（不参与流控，可能丢包）：
String subChannelNoCtrl = "aeron:udp?endpoint=10.1.0.4:0"
    + "|control=10.1.0.2:20121"
    + "|control-mode=dynamic";
    // 无 gtag
```

---

## 9. Aeron Archive：持久化录制与回放

Aeron Archive 在 Aeron Transport 基础上增加了**流录制与回放**能力，将 log buffer 的数据持久化到磁盘，支持历史数据重放。

### 9.1 Archive 整体架构

```
┌──────────────────────┐         ┌──────────────────────────────┐
│    Sending Host       │         │       Receiving Host          │
│                       │         │                               │
│  ┌────────────────┐  │         │  ┌─────────────────────────┐ │
│  │ Application    │  │         │  │   Application            │ │
│  │   Publication  │  │         │  │   Subscription           │ │
│  └───────┬────────┘  │         │  └──────────┬──────────────┘ │
│          │ 录制      │         │             │ 回放            │
│  ┌───────▼────────┐  │         │  ┌──────────▼──────────────┐ │
│  │  Aeron Archive │◄─┼─────────┼──┤  Aeron Archive Client   │ │
│  │                │  │ Control │  │                          │ │
│  │  ┌──────────┐  │  │ Request │  │  控制请求频道            │ │
│  │  │File I/O  │  │  │─────────┼─►│  控制响应频道            │ │
│  │  │          │  │  │ Control │  │  回放频道                │ │
│  │  │recordings│  │  │Response │  └──────────────────────────┘ │
│  │  └──────────┘  │  │◄────────┤                               │
│  └────────────────┘  │         │                               │
│                       │ Replay  │                               │
│                       │ Data    │                               │
│                       │─────────┼──────────────────────────────►
└──────────────────────┘         └──────────────────────────────┘
```

### 9.2 核心功能特性

| 特性 | 说明 |
|------|------|
| **模拟订阅** | 可在没有 Subscription 的情况下录制 Publication（Publication 先启动，订阅者后连接） |
| **扩展录制** | 重启后可追加到已有录制，不丢失历史数据 |
| **任意位置回放** | 从录制的任意字节位置开始回放 |
| **实时合并** | Archive 回放 + 实时流 merge，切换后继续跟随实时流 |
| **录制查询** | 查询可用录制列表（recordingId、起始位置、终止位置等） |
| **截断 & 清除** | truncate（删除某位置之后的数据）、purge（删除某位置之前的数据） |
| **跨版本迁移** | 支持 Archive 数据从旧版本迁移到新版本 |
| **Archive 复制** | 从 Source Archive 实时复制到 Destination Archive（近实时备份） |

### 9.3 关键 Channel 配置

**Archive 侧配置（Sending Host）：**

| 配置项 | 用途 |
|--------|------|
| Control Channel/Stream ID | Archive 监听的控制端点，Archive Client 向此发送请求 |
| Recording Events Channel/Stream ID | 录制事件发布端点（使用 MDC 支持多订阅者） |

**Archive Client 侧配置（Receiving Host）：**

| 配置项 | 用途 |
|--------|------|
| Control Request Channel/Stream ID | 指向远端 Archive 的控制端点 |
| Control Response Channel/Stream ID | 本机响应订阅端点，Archive 将响应发至此处 |
| Replay Channel/Stream ID | 本机回放订阅端点，Archive 将录制数据推至此处 |
| Recording Events Channel/Stream ID | 接收录制事件通知 |

### 9.4 Archive 与背压处理

```
数据管道：External Source → [Connector] → [Archive] → [Router] → [DB]

当 DB 写入缓慢时的降级策略：

方案1：直接用 Log Buffer
  [Connector]─Aeron→[Router]─Aeron→[DB]
  • 优点：简单
  • 缺点：Log Buffer 满了之后 Connector 被背压，有丢数据风险

方案2：使用 Aeron Archive（推荐）
  [Connector]─Archive→[磁盘]←[Router reads]─Aeron→[DB]
  • 优点：磁盘缓冲（几十GB），吸收 DB 的临时慢速
  • 缺点：磁盘同样有上限，需监控磁盘使用率
```

---

## 10. Aeron Cluster：RAFT 共识与高可用服务

Aeron Cluster 在 Aeron Archive 基础上实现了 RAFT 共识协议，用于构建高可用的、确定性的分布式服务。

### 10.1 核心能力

```
┌────────────────────────────────────────────────────────────────────┐
│                        Aeron Cluster                                │
│                                                                     │
│  客户端连接          ┌──────────────────────────────────────────┐  │
│  ─────────────────► │           RAFT 复制日志                   │  │
│                     │                                            │  │
│                     │  Node 0 (Leader) ◄─── 接受客户端写入       │  │
│                     │     │                                      │  │
│                     │     ├──► Node 1 (Follower)                 │  │
│                     │     └──► Node 2 (Follower)                 │  │
│                     │                                            │  │
│                     │  • 多个客户端连接序列化为单一有序日志        │  │
│                     │  • 2N+1 节点容忍 N 个节点故障               │  │
│                     │  • 快照（Snapshot）加速恢复                 │  │
│                     │  • 可靠的定时器（Cluster Timers）           │  │
│                     └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 10.2 典型应用场景

- **中央限价订单簿（CLOB）**：撮合引擎必须确定性、全序处理所有订单
- **RFQ / IOI 协商逻辑**：多客户端并发报价，需全局一致性
- **消息序列器**：为多来源消息赋予全局唯一序号
- **多人游戏状态**：游戏状态需在多服务器间一致
- **任何需要：故障容错 + 高性能 + 有序状态的场景**

### 10.3 与 Aeron Archive 的关系

```
Aeron Cluster 底层依赖：

  Aeron Transport  ← 节点间通信、Client 通信
       ↑
  Aeron Archive    ← 日志持久化、Snapshot 读写
       ↑
  Aeron Cluster    ← RAFT 共识、Service 接口、定时器
       ↑
  Your Service     ← 实现 ClusteredService 接口
```

---

## 11. 运维工具箱

Aeron 提供一套完整的运维诊断工具，全部通过读取 `cnc.dat` 或 Log Buffer 文件工作。

### 11.1 AeronStat

实时查看所有 Aeron Counters，是最常用的诊断工具。

```bash
java --add-opens java.base/jdk.internal.misc=ALL-UNNAMED \
     -cp aeron-all-*.jar \
     -Daeron.dir=/dev/shm/md \
     io.aeron.samples.AeronStat
```

**AeronStat 关键指标速查：**

```
Row  指标名                           健康值      异常时含义
─────────────────────────────────────────────────────────────────
0    Bytes sent                        持续增加    不增加=数据未发出
1    Bytes received                    持续增加    不增加=数据未收到
5    NAKs sent                         接近0       大量NAK=网络丢包严重
6    NAKs received                     接近0       被要求重传过多
11   Retransmits sent                  接近0       网络丢包导致重传
15   Errors                            0           >0 需查 ErrorStat
16   Short sends                       接近0       网络缓冲配置问题
18   Back-pressure events              0           >0 需排查慢消费者
19   Unblocked Publications            0           >0 有 Publication 阻塞超时
26   Conductor max cycle time (ns)     <1ms        >1ms 表示 GC 或调度问题
28   Sender max cycle time (ns)        <1ms        >1ms 发送性能下降
30   Receiver max cycle time (ns)      <1ms        >1ms 接收性能下降

pub-pos ≈ snd-pos → 数据及时发出（无发送积压）
rcv-hwm ≈ rcv-pos → 数据有序到达（无乱序或丢包待重传）
sub-pos ≈ rcv-pos → 应用层及时消费（无消费积压）
```

**AeronStat 过滤参数：**

```bash
# 只看特定 stream
AeronStat stream=101

# 只看特定 channel
AeronStat channel=localhost:4000

# 单次运行（不自动刷新）
AeronStat watch=false

# 每5秒刷新
AeronStat delay=5
```

### 11.2 ErrorStat

查看 Media Driver 内部错误详情：

```bash
java --add-opens java.base/jdk.internal.misc=ALL-UNNAMED \
     -cp aeron-all-*.jar \
     -Daeron.dir=/dev/shm/md \
     io.aeron.samples.ErrorStat

# 正常输出：
0 distinct errors observed.

# 异常输出示例：
1 distinct errors observed.
...
io.aeron.exceptions.RegistrationException: ...
```

### 11.3 BacklogStat

检测数据积压：

```bash
java -cp aeron-all-*.jar -Daeron.dir=/dev/shm/md \
     io.aeron.samples.BacklogStat

# 示例输出解读：
sessionId=1155221173 streamId=8 channel=aeron:udp?endpoint=10.1.1.1:4000 :
┌─publisher 77: 187392 (~0 bytes before back-pressure)   ← 快到背压点了
└─sender 77: 65373 bytes to send (2031779 remaining window)  ← 积压了 64KB
```

### 11.4 LossStat

UDP 丢包统计分析：

```bash
java -cp aeron-all-*.jar -Daeron.dir=/dev/shm/md \
     io.aeron.samples.LossStat

# 输出字段：
# OBSERVATION_COUNT,TOTAL_BYTES_LOST,FIRST_OBS,LAST_OBS,SESSION_ID,STREAM_ID,CHANNEL,SOURCE
688,4167028,2020-08-16 13:53:39,2020-08-16 13:53:41,1155221173,8,aeron:udp?...

# 解读：88 次丢包事件，共丢失 4MB 数据，发生在 13:53:39-41 的 2 秒内
```

### 11.5 StreamStat

按流聚合展示位置信息：

```bash
java -cp aeron-all-*.jar -Daeron.dir=/dev/shm/md \
     io.aeron.samples.StreamStat
```

### 11.6 LogInspector

直接检查 Log Buffer 文件内容（16进制 dump）：

```bash
java -cp aeron-all-*.jar \
     io.aeron.samples.LogInspector /dev/shm/aeron-user/publications/1.logbuffer
```

---

## 12. 背压 (Back Pressure) 处理策略

背压是分布式系统中常见的问题，Aeron 提供了透明的背压信号机制。

### 12.1 背压传递链

```
External Source
      │ 高速写入
      ▼
┌──────────────┐
│   Connector  │ ←─── offer() 返回 -2（BACK_PRESSURED）
└──────┬───────┘
       │ Aeron Publication（背压向上传递）
       ▼
┌──────────────┐
│    Router    │ ←─── 订阅端 poll 减慢，Log Buffer 积压
└──────┬───────┘
       │ Aeron Publication
       ▼
┌──────────────┐
│  Recipient   │ ←─── 数据库写入慢，无法及时 poll
└──────┬───────┘
       │ 慢速写入
       ▼
┌──────────────┐
│  Database    │ ← 瓶颈根源
└──────────────┘
```

### 12.2 背压处理决策

```java
long result = publication.offer(buffer, offset, length);

switch ((int) result) {
    case NOT_CONNECTED:      // -1
        // 订阅者不在线，可以等待或记录
        break;
    case BACK_PRESSURED:     // -2
        // 下游积压，有三种策略：
        // 策略1：丢弃消息（适合实时数据，如行情）
        // strategy1_drop(message);

        // 策略2：自旋重试（适合关键消息，注意 duty cycle 影响）
        // while (publication.offer(buffer) < 0) idle.idle();

        // 策略3：切换到 Archive 流（增加缓冲容量）
        // archiveProducer.record(message);
        break;
    case ADMIN_ACTION:       // -3
        // Term 轮转，立即重试
        result = publication.offer(buffer, offset, length);
        break;
    case CLOSED:             // -4
        throw new RuntimeException("Publication closed");
    default:                 // > 0
        // 成功，result 是新的流位置
        break;
}
```

### 12.3 背压缓解方案

| 方案 | 适用场景 | 代价 |
|------|----------|------|
| 增大 Term Buffer | 临时性波峰 | 内存占用增加（上限 1GB） |
| 消息压缩/精简 | 数据量过大 | CPU 开销 |
| 接入 Aeron Archive | 持续慢消费 | 磁盘 I/O、复杂度 |
| 数据冲减（Conflation） | 允许消息合并 | 部分数据丢失 |
| 扩容下游 | 根本原因 | 硬件/成本投入 |

---

## 13. 快速入门：最简 IPC 示例

```java
import io.aeron.*;
import io.aeron.driver.MediaDriver;
import io.aeron.logbuffer.FragmentHandler;
import org.agrona.DirectBuffer;
import org.agrona.concurrent.*;

public class AeronHelloWorld {
    public static void main(String[] args) throws Exception {

        // ① 定义传输通道和消息
        final String channel = "aeron:ipc";    // IPC 通道（同机内进程通信）
        final int    streamId = 42;             // 流 ID，开发者自定义
        final String message  = "Hello Aeron!";

        // ② 准备工具对象
        final IdleStrategy idle = new SleepingIdleStrategy(); // 1μs 睡眠
        final UnsafeBuffer  buf = new UnsafeBuffer(new byte[256]);  // 堆外 Buffer

        // ③ 启动 Media Driver + Aeron 客户端（try-with-resources 自动关闭）
        try (MediaDriver driver = MediaDriver.launch();         // 启动 Media Driver
             Aeron       aeron  = Aeron.connect();             // 连接到 Driver
             Subscription sub   = aeron.addSubscription(channel, streamId);
             Publication  pub   = aeron.addPublication(channel, streamId)) {

            // ④ 等待 Publication 连接到 Subscription
            while (!pub.isConnected()) idle.idle();

            // ⑤ 发送消息
            buf.putStringAscii(0, message);
            System.out.println(">> Sending: " + message);
            while (pub.offer(buf, 0, buf.capacity()) < 0) idle.idle();

            // ⑥ 接收消息
            FragmentHandler handler = (buffer, offset, length, header) ->
                System.out.println("<< Received: " + buffer.getStringAscii(offset));

            while (sub.poll(handler, 1) <= 0) idle.idle();
        }
    }
}
```

**输出：**
```
>> Sending: Hello Aeron!
<< Received: Hello Aeron!
```

### UDP 示例（跨进程/跨机器）

```java
// 发布方（Publication）使用订阅方的地址
String publisherChannel = "aeron:udp?endpoint=localhost:2000";

// 订阅方（Subscription）监听本机端口
String subscriberChannel = "aeron:udp?endpoint=localhost:2000";

// 注意：Publication 的 channel 指向 Subscription 的地址（推模式）
```

### MDC 示例（一对多）

```java
// Publisher
String mdcChannel = "aeron:udp?control-mode=dynamic|control=10.1.0.2:20121";
Publication pub = aeron.addExclusivePublication(mdcChannel, 100);

// Subscriber（动态加入）
String subChannel = "aeron:udp?endpoint=10.1.0.3:0"
                  + "|control=10.1.0.2:20121"
                  + "|control-mode=dynamic";
Subscription sub = aeron.addSubscription(subChannel, 100);
```

---

## 14. 性能调优要点总结

### 14.1 线程模型调优

```
低延迟生产环境：
  1. 使用 ThreadingMode.DEDICATED（3 个独立线程）
  2. 所有 3 个线程使用 BusySpinIdleStrategy（忙等，零延迟）
  3. 使用 CPU Affinity 将线程绑定到专用核心
  4. 隔离核心，避免 OS 调度干扰

  示例：
  new MediaDriver.Context()
      .threadingMode(ThreadingMode.DEDICATED)
      .senderIdleStrategy(new BusySpinIdleStrategy())
      .receiverIdleStrategy(new BusySpinIdleStrategy())
      .conductorIdleStrategy(new BusySpinIdleStrategy());
```

### 14.2 内存模型调优

```
/dev/shm 是关键：
  • 必须挂载足够大的 tmpfs
  • 每个 Publication = 3 × termLength + metadata
  • 计算公式：所需空间 = (pub数量 × 3 × termLength) + image数量 × 3 × termLength

Term Buffer 大小选择：
  消息很小、延迟优先   → 小 Term（64KB-1MB）
  吞吐量优先           → 大 Term（64MB-128MB）
  有背压风险           → 大 Term（给下游更多缓冲时间）
  注意：最大消息 = min(16MB, termLength/8)
```

### 14.3 网络调优

```
关键参数对齐（必须一致）：
  Publication MTU == Subscription MTU == Archive MTU
  默认 MTU = 1408 bytes（1500 - IP头 - UDP头 - Aeron头）

大吞吐场景增大网络缓冲：
  -Daeron.socket.so_rcvbuf=2097152     # 接收缓冲 2MB
  -Daeron.socket.so_sndbuf=2097152     # 发送缓冲 2MB
  -Daeron.rcv.initial.window.length=2097152  # 必须 ≤ so_rcvbuf

OS 级别网络缓冲：
  sysctl -w net.core.rmem_max=4194304
  sysctl -w net.core.wmem_max=4194304
```

### 14.4 C Media Driver（终极性能）

```
何时使用 C Media Driver：
  ✓ 需要最低延迟（μs 级）
  ✓ 需要完全消除 GC 影响
  ✓ 配合 OpenOnload/DPDK 做 kernel bypass

配置方式：
  1. 编译 C Media Driver
  2. 启动：./aeronmd -Daeron.dir=/dev/shm/aeron
  3. Java 客户端指向同一目录：
     new Aeron.Context().aeronDirectoryName("/dev/shm/aeron")
```

### 14.5 监控指标 SLA

| 指标 | 正常阈值 | 告警阈值 | 行动 |
|------|----------|----------|------|
| `snd-bpe`（背压事件） | 0 | > 0 | 排查下游消费速度 |
| `NAKs sent` | 接近 0 | > 100/min | 排查网络丢包 |
| `Conductor max cycle` | < 1ms | > 10ms | 排查 GC / OS 调度 |
| `Unblocked Publications` | 0 | > 0 | 排查 tryClaim 未 commit |
| `rcv-pos` vs `rcv-hwm` | 相等 | 长期差距 | 排查乱序丢包 |
| `sub-pos` vs `rcv-pos` | 相等 | 长期差距 | 排查应用消费速度 |

---

## 附录：Channel URI 速查表

```
# IPC（同机进程间）
aeron:ipc

# UDP 单播
aeron:udp?endpoint=HOST:PORT

# UDP 单播（含 MTU 和 term 长度设置）
aeron:udp?endpoint=HOST:PORT|mtu=1408|term-length=67108864

# UDP 多播
aeron:udp?endpoint=224.0.1.1:4000|interface=eth0

# MDC 动态（Publisher 端）
aeron:udp?control-mode=dynamic|control=HOST:PORT

# MDC 动态（Subscriber 端）
aeron:udp?endpoint=LOCAL_HOST:0|control=PUB_HOST:PORT|control-mode=dynamic

# MDC 动态 + 流控
aeron:udp?control-mode=dynamic|control=HOST:PORT|fc=min,g:/3

# MDC 动态 + Tagged 流控
aeron:udp?control-mode=dynamic|control=HOST:PORT|fc=tagged,g:101/5

# 稀疏 Term（节省内存）
aeron:udp?endpoint=HOST:PORT|sparse=true
```

---

## 参考资料

- [Aeron 官方文档](https://aeron.io/docs/)
- [Aeron GitHub 仓库](https://github.com/aeron-io/aeron)
- [Aeron Cookbook 示例代码](https://github.com/aeron-io/aeron-cookbook-code)
- [Aeron Wiki：Channel Configuration](https://github.com/aeron-io/aeron/wiki/Channel-Configuration)
- [Aeron Wiki：Flow and Congestion Control](https://github.com/aeron-io/aeron/wiki/Flow-and-Congestion-Control)
- [Flow Control in Aeron - Michael Barker](https://bad-concurrency.blogspot.com/2020/03/flow-control-in-aeron.html)

---

*文档基于 Aeron 官方文档整理，版权归 Adaptive Financial Consulting Ltd 所有。*
*Aeron® 是 Adaptive Financial Consulting Ltd 的注册商标。*
