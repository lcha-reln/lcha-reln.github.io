---
title: Aeron 传输模式与 NAK 流控深度解析
date: 2026-03-11 14:00:00
tags:
  - 高性能
  - 分布式
  - Aeron
categories:
  - 高性能组件
  - Aeron
---

Aeron 提供三种传输模式（UDP 单播、UDP 多播、IPC），并在 UDP 层之上实现了基于 NAK（Negative Acknowledgment）的可靠传输机制与精细化流控体系。本文系统梳理各传输模式的工作原理与适用边界，深入剖析 NAK 协议的设计动机与实现细节，并分析滑动窗口流控的位置追踪模型。

<!-- more -->

## 一、传输模式概览

Aeron 的三种传输模式共享同一套可靠传输层（NAK 协议、流控窗口、重传机制），差异仅在于底层的数据投递手段：

```
┌─────────────────────────────────────────────────────────────┐
│                    Aeron 传输协议体系                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│   │  UDP 单播     │   │  UDP 多播     │   │     IPC      │  │
│   │  (Unicast)   │   │  (Multicast) │   │  (共享内存)   │  │
│   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘  │
│          │                  │                  │           │
│   ┌──────▼──────────────────▼──────────────────▼────────┐  │
│   │              Aeron 可靠传输层                        │  │
│   │   NAK 重传协议  ·  滑动窗口流控  ·  位置计数器体系   │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

| 传输方式 | 延迟（P50） | 吞吐量 | 适用场景 |
|----------|------------|--------|---------|
| IPC | 200 ns 级 | 极高 | 同机进程通信 |
| UDP 单播 | 10 ~ 50 μs | 高 | 点对点跨主机通信 |
| UDP 多播 | 10 ~ 50 μs | 极高（单次发送，多端接收）| 一对多广播分发 |

## 二、为何不使用 TCP

TCP 在数据中心低延迟场景下存在三个结构性缺陷：

### 2.1 队头阻塞（Head-of-Line Blocking）

TCP 是严格有序的字节流协议，接收方的内核缓冲区必须按序向应用层交付数据。当中间某个 segment 丢失时，后续已到达的数据全部阻塞在内核缓冲区，应用层无法感知，也无法处理：

```
TCP 接收端内核缓冲区：

已交付应用层     阻塞等待 segment 3      已到达但无法交付
  ┌───┬───┐    ┌─────────────────────┐  ┌───┬───┐
  │ 1 │ 2 │    │  等待 segment 3 ...  │  │ 4 │ 5 │
  └───┴───┘    └─────────────────────┘  └───┴───┘
```

Aeron 基于 UDP，接收到的数据包直接写入 Log Buffer 的对应 term offset，后续连续帧可立即交付消费端处理，丢失的帧通过异步 NAK 请求重传，两者并行进行，消除了队头阻塞：

```
Aeron Receiver 的 Log Buffer：

已处理         可立即处理（无论 seq=3 是否到达）
  ┌───┬───┐   ┌───┬───┐
  │ 1 │ 2 │   │ 4 │ 5 │   ← 后台异步 NAK 请求 seq=3 重传
  └───┴───┘   └───┴───┘
                 ↑
         offset 已写入，可消费
```

### 2.2 慢启动与拥塞控制

TCP 的慢启动（Slow Start）和拥塞控制（CWND）算法面向广域网设计，其拥塞窗口从 1 MSS 起步，指数增长至 ssthresh 后线性增长。在数据中心 RTT 通常低于 100 μs 的环境下，TCP 的拥塞窗口收敛极慢，初始阶段的带宽利用率极低。

Aeron 的流控基于接收端显式回报的 receiver window（通过 STATUS_MESSAGE 帧携带），发送端直接按接收端的实际消费能力推进，无需拥塞推断算法，带宽利用率从连接建立的第一帧起即可达到上限。

### 2.3 内核协议栈开销

TCP 数据路径需要经过操作系统内核的完整协议栈处理，涉及：系统调用上下文切换、内核缓冲区到用户空间的内存拷贝、TCP 状态机的锁竞争。

Aeron 的数据路径在用户态完成：Publication 直接写入 mmap 映射的 Log Buffer（堆外内存），Sender 通过 `sendmmsg` 系统调用批量发送，Receiver 写入 Image 的 Log Buffer 后由 Subscriber 直接 poll，全程无内核态数据拷贝。

## 三、UDP 单播

UDP 单播是点对点的传输模式，每个 Subscriber 对应一条独立的 UDP 数据流：

```
 发布端进程                             订阅端进程
 ┌──────────┐                          ┌──────────┐
 │ App A    │                          │ App B    │
 │ offer()  │                          │ poll()   │
 └────┬─────┘                          └────▲─────┘
      │                                     │
      ▼                                     │
 ┌──────────────┐    UDP Packet        ┌──────────────┐
 │ Media Driver │ ──────────────────→  │ Media Driver │
 │     A        │  src: 10.0.0.1:9000  │      B       │
 └──────────────┘  dst: 10.0.0.2:9000  └──────────────┘
```

**Channel URI 示例**：
```
aeron:udp?endpoint=10.0.0.2:9000
```

**适用场景**：
- 点对点服务间通信（request/response 或单向推送）
- 订阅方数量较少（通常 < 10），独立流不会显著放大发送端带宽

**注意**：当 Subscriber 数量增加时，Sender 需要为每个 Subscriber 独立发送数据副本，发送端带宽消耗与订阅方数量线性增长。此时应切换为 UDP 多播。

## 四、UDP 多播

UDP 多播利用 IP 组播协议（组播地址范围 `224.0.0.0 ~ 239.255.255.255`），网络设备（交换机/路由器）负责将数据包复制并转发给所有加入该组播组的成员，发送端仅需发送一次：

```
 发布端                         订阅端 1        订阅端 2        订阅端 3
 ┌──────────────┐              ┌────────┐      ┌────────┐      ┌────────┐
 │ Media Driver │  组播数据包   │ App B  │      │ App C  │      │ App D  │
 │  单次发送     │ ─────────────┴────────┴──────┴────────┴──────┴────────┘
 └──────────────┘  239.1.1.1:9000
                   （交换机复制转发至所有组成员）
```

**Channel URI 示例**：
```
# 发布端
aeron:udp?control=10.0.0.1:9001|control-mode=dynamic

# 订阅端
aeron:udp?control=10.0.0.1:9001
```

**核心优势**：

网络层的一次发送对应多端接收，发送端的带宽消耗与接收端数量无关。在行情广播、配置下发、状态同步等一对多场景下，多播相比单播的带宽效率提升与接收端数量成正比。

**部署约束**：

- 组播需要网络设备支持 IGMP（Internet Group Management Protocol）Snooping，确保组播流量只转发给组成员，不泛洪到全网端口
- 跨路由器的组播需要 PIM（Protocol Independent Multicast）等组播路由协议支持
- 在部分云环境和 overlay 网络中，组播支持受限，此时需退化为单播

## 五、IPC 进程间通信

IPC 模式完全绕过网络栈，通过操作系统的共享内存（`mmap`）在同机进程间直接传递数据：

```
┌─────────────────────────────────────────────────────────────┐
│                        同一台主机                            │
│                                                             │
│  ┌────────────┐                      ┌────────────┐        │
│  │ Process A  │                      │ Process B  │        │
│  │  offer()   │                      │  poll()    │        │
│  └─────┬──────┘                      └─────▲──────┘        │
│        │ write（无系统调用）                │ read          │
│        ▼                                   │               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │          Shared Memory（mmap / /dev/shm）           │   │
│  │          Log Buffer（Term Buffer × 3）              │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Channel URI**：
```
aeron:ipc
```

IPC 的延迟优势来源于三个层面：

1. **零网络开销**：数据不经过任何网络协议栈，消除了网卡驱动、内核网络子系统的处理延迟
2. **零拷贝**：Publication 写入共享内存后，Subscriber 直接从相同的物理页读取，无任何数据复制
3. **缓存亲和性**：同一台机器上的两个进程访问同一块物理内存，L3 Cache 命中率高；若进一步将两个进程绑定到同一 NUMA 节点的不同核心，可完全消除跨 NUMA 的内存访问延迟

**典型延迟**：P50 约 200 ns，P99 约 500 ns（`DEDICATED` 线程模式 + `BusySpinIdleStrategy`）。

## 六、NAK 协议

### 6.1 设计动机：NAK vs ACK

传统可靠传输协议（TCP）使用 ACK（Positive Acknowledgment）机制：接收方确认每一个（或每批）成功收到的数据包。在低丢包率网络中，ACK 的成本远高于其提供的价值——绝大多数数据包都能成功投递，为每个成功投递的包发送 ACK 是巨大的带宽和处理浪费。

Aeron 采用 **NAK（Negative Acknowledgment）**：接收方仅在检测到数据缺失时发送 NAK 帧，请求重传指定范围的数据。在数据中心环境（丢包率通常 < 0.01%）下，NAK 的发送频率极低，接近于零，从而将确认流量的开销降低至接近零。

```
ACK 模式（TCP）：

发送端: [1]  [2]  [3]  [4]  [5]
接收端:  ↑    ↑    ↑    ↑    ↑
        ACK ACK ACK ACK ACK   ← 5 条确认，100% 额外流量

─────────────────────────────────────────────────

NAK 模式（Aeron）：

发送端: [1]  [2]  [X]  [4]  [5]
接收端:  ✓    ✓        ✓    ✓
                  ↑
              NAK(3)           ← 仅 1 条 NAK，丢包才触发
```

**适用前提**：NAK 模式假设网络丢包率低（< 0.1%）。在高丢包率网络中，大量 NAK 请求可能引发 NAK 风暴（NAK Implosion），导致发送端被重传请求淹没，此时应考虑引入 NAK 抑制（NAK Suppression）或切换为基于 ACK 的可靠传输。

### 6.2 NAK 完整工作流程

```
时间轴 ──────────────────────────────────────────────────────────────→

阶段 1：正常传输
  Sender:   ──[1]──[2]──[3]──[4]──[5]──────────────────────────────→
  Receiver:   ✓    ✓    ✓    ✓    ✓

阶段 2：丢包发生
  Sender:   ──[1]──[2]──[X]──[4]──[5]──────────────────────────────→
  Receiver:   ✓    ✓         ✓    ✓
                        ↑
              Receiver 检测到 seq gap（term offset 不连续）

阶段 3：NAK 延迟等待（默认 20 μs）
  目的：等待乱序帧可能在延迟后到达，避免对乱序帧误发 NAK

阶段 4：NAK 发送
  Receiver: ───────────────────────────── NAK(termId=X, offset=Y) →
  Sender:   ← 接收 NAK

阶段 5：重传
  Sender:   ──────────────────────────────────[3]重传──────────────→
  Receiver:   ✓  gap 填充，恢复连续性

阶段 6：正常传输继续
  Sender:   ─────────────────────────────────────────[6]──[7]──────→
  Receiver:   ✓    ✓
```

### 6.3 NAK 帧结构

Aeron 的 NAK 帧是标准的 Aeron 数据帧，帧类型字段为 `NAK`（`0x08`），携带以下关键字段：

| 字段 | 说明 |
|------|------|
| `sessionId` | 标识发布者会话 |
| `streamId` | 标识逻辑数据流 |
| `termId` | 请求重传的 Term 编号 |
| `termOffset` | 请求重传的 Term 内偏移量（字节） |
| `length` | 请求重传的数据长度（字节） |

Receiver 将 NAK 帧发送回 Sender 端的 `control` 地址（UDP 单播回路），Sender 的重传逻辑从 Log Buffer 中定位对应的 term + offset，读取原始帧数据并重新发送。

### 6.4 NAK 延迟（nakDelay）

NAK 延迟是接收端在检测到 gap 后、实际发出 NAK 帧之前的等待时间（默认 20 μs）。其设计目的是抑制乱序帧触发的误 NAK：

- 若网络存在轻微乱序（帧到达顺序与发送顺序有微小偏差），等待期间乱序帧可能自然到达，gap 自然填补，无需触发重传
- 若等待期满仍未收到该 term offset 的数据，则确认为真实丢包，发送 NAK

NAK 延迟的取值应与网络的乱序程度相匹配：
- 数据中心内部单路径网络：`20 ~ 100 μs`
- 跨数据中心或存在 ECMP 多路径的网络：`500 μs ~ 1 ms`

配置方式：

```java
final MediaDriver.Context ctx = new MediaDriver.Context()
    .nakDelayNs(20_000L)              // NAK 延迟：20 μs
    .retransmitUnicastDelayNs(0L)     // 收到 NAK 后立即重传（单播）
    .retransmitUnicastLingerNs(60_000_000_000L); // 重传后保持 linger 状态 60s
```

### 6.5 NAK 抑制（Multicast 场景）

在 UDP 多播场景下，多个接收端可能同时检测到同一个 gap，若每个接收端都独立发送 NAK，Sender 将收到大量重复的 NAK 请求（NAK Implosion）。

Aeron 通过以下机制抑制多播 NAK 风暴：

1. **随机化 NAK 延迟**：每个接收端在 `[0, nakDelay]` 范围内随机选取等待时间再发送 NAK
2. **NAK 监听**：接收端在等待期间监听组播地址上是否已有其他接收端发出相同的 NAK；若收到相同 NAK，则取消自己的 NAK 发送
3. **Sender 批量重传**：Sender 在收到第一个 NAK 后等待 `retransmitMulticastDelay` 时间（默认 0），合并同一 gap 的多个 NAK 请求后执行单次重传

## 七、流控窗口与位置追踪

### 7.1 位置计数器体系

Aeron 的流控建立在一组共享内存中的 64 位原子位置计数器之上，记录数据流在各环节的处理进度：

```
Publication 写入位置
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│                       Log Buffer                           │
│                                                            │
│  [已消费] ─── consumerPosition                            │
│  [已处理] ─── subscriberPosition（每个 Subscriber 独立）  │
│  [已接收] ─── receiverHwm（High Water Mark）               │
│  [已发送] ─── senderPosition                              │
│  [可写上限]── publisherLimit（由 Conductor 更新）          │
│                                                            │
└────────────────────────────────────────────────────────────┘
         │
         ▼
      Network
```

各位置计数器的语义：

| 计数器 | 维护方 | 语义 |
|--------|--------|------|
| `publisherLimit` | Driver Conductor | Publication 可写入的最大 position 上限，由接收端 receiver window 决定 |
| `senderPosition` | Sender | 已通过网络发出的最大 position |
| `receiverHwm` | Receiver | 接收到的最高 position（不要求连续）|
| `subscriberPosition` | Subscriber | 应用层已消费的最大连续 position |

### 7.2 发送端滑动窗口

发送端的可发送范围由 `publisherLimit` 约束：

```
Publication 可写范围：

已发送确认区         飞行中数据区           未发送可写区
 ──────────────  ──────────────────────  ──────────────────
│              │ │                     │ │                 │
│   consumed   │ │     in-flight       │ │   can write     │
│              │ │                     │ │                 │
 ──────────────  ──────────────────────  ──────────────────
               ↑                        ↑                  ↑
        senderPosition           publisherLimit     termBufferEnd

飞行中数据量 = publisherLimit - senderPosition
             ≤ receiverWindow（接收端回报的窗口大小）
```

当 Publication 的 `offer()` 调用发现当前写入 position 已达到 `publisherLimit` 时，返回 `BACK_PRESSURED`（`-2`），发布端需要等待 `publisherLimit` 推进后重试。

### 7.3 接收端流控反馈

接收端通过定期发送 **STATUS_MESSAGE（SM）** 帧向发送端汇报当前消费状态：

```
STATUS_MESSAGE 帧关键字段：
  - consumptionTermId：当前消费位置的 term 编号
  - consumptionTermOffset：当前消费位置在 term 内的偏移量
  - receiverWindowLength：接收端愿意接收的数据量上限（字节）

发送端收到 SM 后：
  publisherLimit = consumptionTermPosition + receiverWindowLength
```

STATUS_MESSAGE 的发送频率受 `statusMessageTimeoutNs` 控制（默认 200 μs），即接收端至多每 200 μs 发送一次 SM。在高吞吐场景下，Receiver 还会在 position 推进超过 `receiverWindowLength / 4` 时立即发送 SM（Fast Feedback），避免发送端因 SM 间隔过长而被迫降速。

### 7.4 Term Buffer 大小对流控的影响

`publicationTermBufferLength`（默认 16 MB）决定了 Log Buffer 中单个 Term 的大小，进而影响最大允许的 in-flight 数据量：

- **较小的 Term Buffer**（如 1 MB）：in-flight 窗口小，高带宽长延迟（BDP 大）的链路上发送端容易触发 `BACK_PRESSURED`，吞吐受限
- **较大的 Term Buffer**（如 64 MB）：in-flight 窗口大，充分填充 BDP，吞吐提升，但内存占用增加（Log Buffer 由 3 个 Term 组成，实际占用 `3 × termBufferLength`），且重传代价增大

**Term Buffer 大小的经验选择**：

```
recommendedTermLength ≈ 2 × BDP
BDP（带宽时延积）= 带宽（bytes/s）× RTT（s）

示例：
  10 Gbps 网络，RTT = 100 μs
  BDP = (10 × 10^9 / 8) bytes/s × 100 × 10^-6 s = 125 KB
  → Term Buffer = 256 KB ~ 1 MB 即可满足需求

  100 Gbps 网络，RTT = 500 μs（跨数据中心）
  BDP = (100 × 10^9 / 8) × 500 × 10^-6 = 6.25 MB
  → Term Buffer = 16 MB ~ 32 MB
```

## 八、传输方式选型

```
                       ┌─────────────────────────┐
                       │      开始选择传输方式     │
                       └────────────┬────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │  通信双方是否在同一主机？  │
                       └──────┬──────────┬────────┘
                              │ 是        │ 否
                              ▼           ▼
                    ┌──────────────┐  ┌──────────────────────┐
                    │  使用 IPC    │  │ 订阅方是否 > 1 个？   │
                    │（最低延迟）   │  └────┬───────────┬──────┘
                    └──────────────┘       │ 是         │ 否
                                           ▼            ▼
                              ┌────────────────┐  ┌───────────────┐
                              │ 网络是否支持   │  │  UDP 单播      │
                              │  IP 组播？     │  └───────────────┘
                              └──────┬─────┬──┘
                                     │ 是  │ 否
                                     ▼     ▼
                            ┌──────────┐ ┌──────────────────┐
                            │ UDP 多播  │ │ UDP 单播（多份）  │
                            │（推荐）   │ │ 或代理广播        │
                            └──────────┘ └──────────────────┘
```

## 九、性能参考数据

以下数据来自基准测试环境（Intel Xeon E5-2680 v4，10 Gbps 以太网，Jumbo Frame MTU 9000，`DEDICATED` 线程模式，`BusySpinIdleStrategy`）：

| 传输方式 | P50 延迟 | P99 延迟 | 吞吐量 | 备注 |
|----------|---------|---------|--------|------|
| IPC | 213 ns | 450 ns | 4.6M msg/s | 同机进程，无网络开销 |
| UDP 单播（本机回环） | 12 μs | 35 μs | 800K msg/s | |
| UDP 单播（跨主机） | 150 μs | 500 μs | 500K msg/s | 受网络 RTT 限制 |
| UDP 多播 | 15 μs | 40 μs | 1.2M msg/s | 多接收端场景优势明显 |

IPC 比 UDP 单播快约 10 ~ 20 倍，原因可以分解为：

1. **无系统调用**：UDP 发送需要 `sendmmsg` 系统调用（约 1 ~ 2 μs），IPC 为纯内存写入
2. **无序列化/反序列化**：UDP 需要在用户态和内核态之间拷贝数据（即便使用 `SO_ZEROCOPY`，仍有额外 completion 通知开销）；IPC 直接读写共享物理页，无任何拷贝
3. **缓存亲和性**：写端写入的数据行在读端 poll 时大概率仍在 L3 Cache 中（同一 NUMA 节点），避免了主存访问延迟（约 60 ~ 100 ns/access）

## 十、关键配置汇总

```java
final MediaDriver.Context ctx = new MediaDriver.Context()

    // ── 传输层通用 ──────────────────────────────────────────
    // Term Buffer 大小（3 个 Term 组成 Log Buffer，需为 2 的幂次）
    .publicationTermBufferLength(16 * 1024 * 1024)   // UDP，默认 16 MB
    .ipcTermBufferLength(64 * 1024 * 1024)           // IPC，默认 64 MB

    // ── NAK 相关 ────────────────────────────────────────────
    // 单播 NAK 延迟（检测到 gap 后等待乱序帧的时间）
    .nakDelayNs(20_000L)                             // 默认 20 μs
    // 多播 NAK 延迟（随机化区间上限）
    .nakMulticastMaxBackoffNs(60_000_000L)           // 默认 60 ms
    // 单播重传延迟（收到 NAK 后延迟重传的时间）
    .retransmitUnicastDelayNs(0L)                    // 立即重传
    // 重传 linger 时间（重传后保持重传状态的持续时间，防止重复 NAK）
    .retransmitUnicastLingerNs(60_000_000_000L)      // 60 s

    // ── 流控相关 ────────────────────────────────────────────
    // STATUS_MESSAGE 发送间隔
    .statusMessageTimeoutNs(200_000L)                // 默认 200 μs
    // 初始 receiver window（等于 Term Buffer 长度的 1/8）
    // 通过 FlowControl 策略动态调整，无需直接配置

    // ── Socket 缓冲区（需与 OS net.core.rmem_max 匹配）────
    .socketSndbufLength(2 * 1024 * 1024)
    .socketRcvbufLength(2 * 1024 * 1024);
```

## 十一、高丢包率场景的局限性

Aeron 的 NAK 机制在丢包率 < 0.1% 的数据中心网络下表现最佳。当丢包率上升时，需要关注以下退化行为：

**NAK 重传放大**：若同一 term 区间内多个数据帧丢失，接收端会为每个丢失的帧发送独立的 NAK。在丢包率 1% 的场景下，每 100 条消息触发 1 次 NAK + 重传，重传流量占总流量的比例与丢包率线性相关，额外开销仍可接受。

**重传链式触发**：若重传的数据帧本身也丢失（即重传数据包丢包），接收端将再次发送 NAK。NAK 最大重试次数无硬性上限，但若 `imageLivenessTimeoutNs` 内仍无法填补 gap，Image 将被主动关闭（`onUnavailableImage` 回调触发）。

**建议**：若网络环境丢包率持续 > 0.1%，应首先排查网络层问题（Socket 缓冲区溢出、NIC 队列满等），而非调整 Aeron 参数。Aeron 本身不是为高丢包率链路设计的传输框架。
