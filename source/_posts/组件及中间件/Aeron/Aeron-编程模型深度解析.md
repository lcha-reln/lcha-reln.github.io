---
title: Aeron 编程模型深度解析
tags:
  - 高性能
  - 分布式
  - Aeron
categories:
  - 高性能组件
  - Aeron
abbrlink: 406b47f8
date: 2026-03-12 10:00:00
---

本文聚焦 Aeron **应用面向的编程模型**：发布端 `Publication` 与订阅端 `Subscription` 的 API 语义、底层的 Log Buffer / Image 内存模型、Position 位置体系，以及一对多分发的 MDC（Multi-Destination-Cast）。读完即可写出正确、高效的 Aeron 收发代码。

> 前置概念见 [Aeron Channel、Stream、Session 深度解析](/posts/43d5f152/)；引擎内部见 [Aeron Media Driver 深度解析](/posts/bc5589ca/)；传输与流控见 [传输模式与 NAK 流控深度解析](/posts/fbf83150/)。

<!-- more -->

## 一、Publication 发布端

Publication 是应用程序发送数据的主要接口，提供**非阻塞**的发送 API。

### 1.1 两种 Publication 类型

| 类型 | 创建方式 | 线程安全 | Session ID | 性能 |
|------|----------|----------|------------|------|
| `ConcurrentPublication` | `aeron.addPublication()` | 是（内部加锁） | 共享 | 略低 |
| `ExclusivePublication` | `aeron.addExclusivePublication()` | 否 | 独立 | 更高 |

> **最佳实践**：单线程发送用 `ExclusivePublication`，多线程共享发送用 `ConcurrentPublication`。

### 1.2 `offer` 方法

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

### 1.3 `tryClaim` 方法（零拷贝发送）

`tryClaim` 是性能更高的方式：**直接在 Log Buffer 上申请写入空间，无需额外复制**。

<div class="mermaid">
graph TD
    A["1. tryClaim(length, bufferClaim)"]
    B["成功: 在 Log Buffer 中预留 length 字节空间"]
    C["2. 直接向 bufferClaim.buffer() 写入数据 (使用 bufferClaim.offset() 作为起始偏移)"]
    D{"3. 提交或中止"}
    E["bufferClaim.commit(): 提交, Media Driver 随即发送"]
    F["bufferClaim.abort(): 中止, 释放预留空间"]
    A --> B
    B --> C
    C --> D
    D -->|提交| E
    D -->|中止| F
</div>

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

### 1.4 消息分片机制

<div class="mermaid">
graph TD
  A["Application Message (200KB)"]
  A -->|"offer 数据超过 maxPayloadLength() 时, Aeron 自动分片"| B
  subgraph B["分片 (每片 ≤ MTU - 32字节头)"]
    F1["Frag 1 (BEGIN)"]
    F2["Frag 2"]
    F3["Frag 3"]
    F4["Frag 4 (END)"]
  end
  B -->|"网络传输 (可能乱序到达)"| C["接收端: FragmentAssembler 重新组装"]
  C --> D["FragmentHandler.onFragment() 收到完整消息"]
</div>

> **注意**：`tryClaim` 不支持超过 `maxPayloadLength()` 的消息，因此不需要 `FragmentAssembler`。

### 1.5 异步构建 Publication（Aeron 1.35.0+）

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

## 二、Subscription 订阅端

Subscription 用于接收消息流，必须在单线程内使用（非线程安全）。

### 2.1 基本轮询模式

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

### 2.2 FragmentHandler 注意事项

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

### 2.3 大消息重组（FragmentAssembler）

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

### 2.4 受控轮询（ControlledFragmentHandler）

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

## 三、Log Buffer 与 Image 内存模型

Log Buffer 是 Aeron 零拷贝、低延迟的核心数据结构。发布端写入它，Media Driver 的 Sender 从中读取发送，接收端则在 Image 的 Log Buffer 中重建有序流。

### 3.1 Log Buffer 物理结构

<div class="mermaid">
graph TD
  subgraph FILE["Log Buffer File (内存映射, 通常在 /dev/shm)"]
    direction TB
    T0["Term 0 (termLength) | offset 0 | 状态: clean / active / dirty"]
    T1["Term 1 (termLength) | offset: termLength"]
    T2["Term 2 (termLength) | offset: 2 × termLength"]
    META["Metadata | offset: 3 × termLength | Term 状态、Term ID、位置信息等"]
    T0 --> T1 --> T2 --> META
  end
  subgraph TERM["每个 Term 内部"]
    direction LR
    H1["Header (32byte)"] --> M1["Message 1"] --> H2["Header (32byte)"] --> M2["Message 2"] --> DOTS["..."]
  end
  FILE -.-> TERM
</div>

### 3.2 Term 状态轮转

<div class="mermaid">
stateDiagram-v2
direction LR
[*] --> clean
clean --> active: 开始写入
active --> dirty: 写满
dirty --> clean: 被重置后
note right of dirty
三个 Term 轮转过程:
时刻1: Term0=active Term1=clean Term2=clean
时刻2: Term0=dirty Term1=active Term2=clean (Term0 写满,切换)
时刻3: Term0=clean Term1=dirty Term2=active (Term1 写满,切换)
时刻4: Term0=active Term1=clean Term2=dirty (循环)
Publication.offer() 返回 ADMIN_ACTION(-3)
= Term 轮转的瞬间,应用层应立即重试
end note
</div>

### 3.3 Term Buffer 大小约束

| 约束条件 | 值 |
|----------|----|
| 最小值 | 65,536 bytes（64KB） |
| 最大值 | 1,073,741,824 bytes（1GB） |
| 必须是 | 2 的幂次 |
| 单条消息最大长度 | min(16MB, termLength / 8) |
| 整个流的最大位置 | termLength × 2³¹ |

> Term Buffer 大小如何影响吞吐与背压（结合 BDP 计算），详见 [传输模式与 NAK 流控深度解析](/posts/fbf83150/) 的流控章节。

### 3.4 乱序重建与 Watermark

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

### 3.5 Image

Image 是 Subscription 端对某个 Publication 流的本地副本：
- 每个 `channel + streamId + sessionId` 组合对应一个 Image
- 存储在 Media Driver 的 `images/` 目录
- 通常不需要直接操作 Image，Aeron Cluster 的 snapshot 加载除外

---

## 四、Position 位置追踪体系

Position 是 Aeron 中唯一标识流中某个字节的全局指针，贯穿发送和接收的全链路，是流控与背压的数学基础。

### 4.1 完整的 Position 流转链

<div class="mermaid">
flowchart TD
  subgraph PUB["Publisher Application"]
    PP["pub-pos (pub限流点)"]
    PL["pub-lmt (背压控制)"]
    LB["Log Buf"]
    SND["Sender"]
    SP["snd-pos (已发位置)"]
    SL["snd-lmt (发送窗口)"]
  end
  subgraph SUB["Subscriber Application"]
    SUBP["sub-pos (subscription 已消费位置)"]
    HWM["rcv-hwm (最远收到位置)"]
    RP["rcv-pos (连续完成位置)"]
  end
  PP -->|write| LB
  LB -->|"Sender reads"| SND
  SND --> SP
  SND -.->|背压反馈| PL
  SP -->|"UDP/IPC"| RP
</div>

### 4.2 Position 计算方式

```
position = (termId - initialTermId) × termLength + termOffset

其中：
  termOffset  = 消息在当前 Term 中的字节偏移
  termId      = 当前 Term 的 ID（递增）
  initialTermId = Publication 创建时的初始 Term ID

注意：Position 包含 Aeron 头部(32字节)和填充字节，
      不只是应用数据大小！MTU 大小会影响 Position 增量。
```

> 这些位置计数器在运行时如何通过 `AeronStat` 观测，以及健康检查口径（`snd-pos ≈ pub-pos`、`rcv-pos ≈ rcv-hwm`、`sub-pos ≈ rcv-pos`），详见 [Aeron Cluster 与运维工具](/posts/fed0dafe/)。

---

## 五、Multi-Destination-Cast (MDC)

MDC 允许单个 Publication 同时发送数据到多个 Subscription，适合替代 UDP 多播（在不支持多播的环境中）。

### 5.1 MDC vs 标准 Publication

```
标准 Publication：
  Publication.channel → 指向 Subscription 的地址
  Subscription.channel → 本机监听地址

动态 MDC（地址方向反转）：
  Publication.channel → 本机地址（订阅方来连接我）
  Subscription.channel → 指向 Publication 的控制地址
```

### 5.2 动态 MDC 拓扑

<div class="mermaid">
graph TD
  subgraph PUB["MDC Publisher Process"]
    PC["Publication Channel: aeron:udp?control-mode=dynamic|control=10.1.0.2:20121"]
  end
  S1["Subscriber 1 (10.1.0.3:0) control=10.1.0.2:20121|control-mode=dynamic"]
  S2["Subscriber 2 (10.1.0.4:0) control=10.1.0.2:20121|control-mode=dynamic"]
  S3["Subscriber 3 (10.1.0.5:0) control=10.1.0.2:20121|control-mode=dynamic"]
  PC -->|"控制平面(Subscriptions 动态注册)"| S1
  PC -->|"控制平面(Subscriptions 动态注册)"| S2
  PC -->|"控制平面(Subscriptions 动态注册)"| S3
</div>

### 5.3 MDC 流控策略

当慢消费者拖累快消费者时，有三种流控策略：

| 流控策略 | 行为特征 | 配置 |
| --- | --- | --- |
| max（默认）：以最快订阅者为准 | 快消费者不受慢消费者影响；慢消费者可能丢包 | `fc=max` |
| min：以最慢订阅者为准 | 所有订阅者保证无丢包；Publication 速度受最慢订阅者限制 | `fc=min`；支持 group size：`fc=min,g:/5`（至少 5 个订阅者才算 connected） |
| tagged：精细分组控制 | 部分订阅者加入流控组（tagged），其余不参与；Publication 速度受 tagged 订阅者中最慢的限制；非 tagged 订阅者可能丢包但不影响 tagged 组 | Publication：`fc=tagged,g:101`；Subscriber（受控）：`gtag=101`；Subscriber（不受控）：不设 gtag |

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

## 六、背压（Back Pressure）的处理决策

`offer()` 的返回值即是端到端背压信号。应用层需要根据返回值选择合适的处理策略：

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

> 背压的成因分析、容量层面的缓解方案（增大 Term / 压缩 / 接入 Archive / Conflation / 扩容）详见 [Aeron Cluster 与运维工具](/posts/fed0dafe/)。

---

## 七、快速入门示例

### 7.1 最简 IPC 示例

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

### 7.2 UDP 示例（跨进程/跨机器）

```java
// 发布方（Publication）使用订阅方的地址
String publisherChannel = "aeron:udp?endpoint=localhost:2000";

// 订阅方（Subscription）监听本机端口
String subscriberChannel = "aeron:udp?endpoint=localhost:2000";

// 注意：Publication 的 channel 指向 Subscription 的地址（推模式）
```

### 7.3 MDC 示例（一对多）

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

## Aeron 系列

- [Aeron 概述](/posts/fdcdfbb5/)
- [Channel、Stream、Session 深度解析](/posts/43d5f152/)
- [Media Driver 深度解析](/posts/bc5589ca/)
- [传输模式与 NAK 流控深度解析](/posts/fbf83150/)
- **编程模型深度解析**（本文）
- [Aeron Archive 深度解析](/posts/987bb85b/)
- [Aeron Cluster 与运维工具](/posts/fed0dafe/)
