---
title: Aeron Channel、Stream 和 Session 深度解析
tags:
  - 高性能
  - 分布式
  - Aeron
categories:
  - 高性能组件
  - Aeron
abbrlink: 43d5f152
date: 2026-03-10 20:00:00
---

在 Aeron 中，**Channel、Stream 和 Session** 是三个核心概念，共同构成消息路由和身份识别的完整体系。正确理解这三个概念，是构建高性能 Aeron 应用的前提。

<!-- more -->

## 一、概念层次结构

三者形成自顶向下的嵌套层级：

```
Channel（通道层）—— 传输媒体和网络寻址
    │
    ├─── Stream 1（流层）—— 逻辑数据流/业务分类
    │       ├─── Session A（会话层）—— 发布者实例 A
    │       ├─── Session B
    │       └─── Session C
    │
    ├─── Stream 2
    │       ├─── Session D
    │       └─── Session E
    │
    └─── Stream N
            └─── Session N
```

| 层级 | 作用 | 类比 |
|------|------|------|
| **Channel** | 定义传输媒体和网络地址 | TCP 的 IP + Port |
| **Stream** | Channel 内的逻辑数据流，按业务分类 | 同一端口上的不同应用协议 |
| **Session** | 区分同一 Stream 上的不同发布者 | 同一频道的不同发言人 |

---

## 二、Channel（通道）

### 2.1 定义

Channel 表示 **传输媒体**，通过 URI 指定传输协议、网络地址和可选参数。

```
URI 格式：
aeron:<transport>?<param1>=<value1>|<param2>=<value2>...
```

> 注意：Aeron URI 参数分隔符使用 `|` 而非 `&`。

### 2.2 三种传输类型

```
Aeron 传输类型

  UDP Unicast  ──►  aeron:udp?endpoint=host:port
  （点对点，最常用）

  UDP Multicast ──► aeron:udp?endpoint=224.x.x.x:port|interface=eth0
  （一对多组播，需硬件/网络支持）

  IPC ──────────►  aeron:ipc
  （同机进程间共享内存，延迟最低）
```

**性能对比：**

| 传输类型 | 典型延迟 | 适用场景 |
|----------|----------|----------|
| IPC | 亚微秒 ~ 数微秒 | 同机服务间高频通信 |
| UDP Unicast | 数微秒 ~ 数十微秒 | 跨机点对点，绝大多数生产场景 |
| UDP Multicast | 数微秒 ~ 数十微秒 | 一对多广播，需网络设备支持组播 |

### 2.3 Channel URI 参数详解

| 参数 | 说明 | 示例值 |
|------|------|--------|
| `endpoint` | 目标地址和端口 | `192.168.1.10:40123` |
| `interface` | 绑定的本地网卡 | `192.168.1.5` 或 `eth0` |
| `ttl` | 组播生存时间（跳数） | `16` |
| `mtu` | 最大传输单元（字节） | `1408`（默认） |
| `reliable` | 是否启用 NAK 重传 | `true`（默认）/ `false` |
| `term-length` | Log Buffer 单个 Term 大小 | `67108864`（64MB） |
| `sparse` | 是否启用稀疏 Term（节省内存） | `true` / `false` |
| `control` | MDC 控制地址（多播专用） | `10.1.0.2:20121` |
| `control-mode` | MDC 模式 | `dynamic` / `manual` |
| `fc` | 流控策略 | `max` / `min` / `tagged` |

### 2.4 常用 Channel 示例

```java
// UDP 单播（最基础用法）
String channel = "aeron:udp?endpoint=192.168.1.10:40123";

// UDP 单播，指定本地出口网卡
String channel = "aeron:udp?endpoint=192.168.1.10:40123|interface=192.168.1.5";

// UDP 组播，设置 TTL=16（最多跨 16 个路由器）
String channel = "aeron:udp?endpoint=224.10.9.8:40123|interface=192.168.1.5|ttl=16";

// IPC（同机进程间通信）
String channel = "aeron:ipc";

// MDC 动态多播（Publisher 端）
String channel = "aeron:udp?control-mode=dynamic|control=10.1.0.2:20121";

// 自定义 MTU 和 Term 长度
String channel = "aeron:udp?endpoint=192.168.1.10:40123|mtu=4096|term-length=134217728";
```

### 2.5 Publication 与 Subscription 的地址方向

Aeron 是**推模式（Push）**，这是初学者最容易搞混的地方：

```
✅ 正确理解：

  Publication（发送方）的 channel 填写 Subscription（接收方）的地址
  ─────────────────────────────────────────────────────────────────
  Publisher                              Subscriber
  channel="aeron:udp?endpoint=          channel="aeron:udp?endpoint=
           192.168.1.10:40123"  ──────►          192.168.1.10:40123"
  （我要推送数据到这个地址）             （我监听这个端口）

❌ 错误理解（不要写 Subscriber 的本机地址到 Publisher 的 channel）
```

---

## 三、Stream（流）

### 3.1 定义

Stream 是 Channel 内的**有序逻辑数据流**，用 32 位整数 `streamId` 标识。  
同一个 Channel（即同一 UDP 端口）可以承载多个互相独立的 Stream。

### 3.2 多 Stream 复用同一端口

```
UDP Channel: 192.168.1.10:40123
         │
         ├─── streamId=10 ──► 订单管理流（Order Management）
         │
         ├─── streamId=20 ──► 市场行情流（Market Data）
         │
         └─── streamId=30 ──► 风控指令流（Risk Control）

优点：
  • 一个 UDP 端口承载多条业务流
  • 减少端口占用，简化防火墙配置
  • 不同业务流完全隔离，互不干扰
```

### 3.3 Stream ID 设计规范

| 特性 | 说明 |
|------|------|
| 类型 | 32 位有符号整数 |
| 保留值 | `0` 不可用 |
| 作用域 | 在同一 Channel 内唯一 |
| 分配方式 | 应用层自行约定，无强制规范 |

**推荐的 Stream ID 分配策略（以金融系统为例）：**

```java
public class StreamIds {
    // 按业务模块划分区间（预留扩展空间）
    public static final int ORDER_MANAGEMENT_BASE = 1000;
    public static final int MARKET_DATA_BASE      = 2000;
    public static final int RISK_CONTROL_BASE     = 3000;
    public static final int SETTLEMENT_BASE       = 4000;

    // 按资产类别细分
    public static final int EQUITY_ORDERS  = ORDER_MANAGEMENT_BASE + 1;  // 1001
    public static final int FOREX_ORDERS   = ORDER_MANAGEMENT_BASE + 2;  // 1002
    public static final int FUTURES_ORDERS = ORDER_MANAGEMENT_BASE + 3;  // 1003

    // 市场行情细分
    public static final int EQUITY_QUOTES  = MARKET_DATA_BASE + 1;       // 2001
    public static final int FOREX_QUOTES   = MARKET_DATA_BASE + 2;       // 2002
}
```

### 3.4 创建多 Stream

```java
String channel = "aeron:udp?endpoint=192.168.1.10:40123";

// 同一个 Channel，不同的 Stream
Publication orderPub      = aeron.addPublication(channel, StreamIds.EQUITY_ORDERS);
Publication marketDataPub = aeron.addPublication(channel, StreamIds.EQUITY_QUOTES);
Publication riskPub       = aeron.addPublication(channel, StreamIds.RISK_CONTROL_BASE);

// Subscription 只需指定感兴趣的 streamId
Subscription orderSub  = aeron.addSubscription(channel, StreamIds.EQUITY_ORDERS);
Subscription quoteSub  = aeron.addSubscription(channel, StreamIds.EQUITY_QUOTES);
```

---

## 四、Session（会话）

### 4.1 定义

Session 用于**区分同一 Channel + Stream 上的不同 Publication 实例**。  
每个 Publication 持有一个唯一的 `sessionId`，由 Aeron 自动随机生成。

### 4.2 Session ID 特性

| 特性 | 说明 |
|------|------|
| 生成方式 | Aeron 自动随机分配 |
| 类型 | 32 位有符号整数（可为负数） |
| 唯一性范围 | Channel + Stream 组合内唯一 |
| `ConcurrentPublication` | 同一 channel+streamId 下多次 `addPublication` 返回同一 sessionId |
| `ExclusivePublication` | 每次 `addExclusivePublication` 分配独立 sessionId |

### 4.3 多 Session 示例

```java
String channel = "aeron:udp?endpoint=192.168.1.10:40123";
int streamId = 10;

// ExclusivePublication：每个实例有独立的 sessionId
ExclusivePublication pub1 = aeron.addExclusivePublication(channel, streamId);
ExclusivePublication pub2 = aeron.addExclusivePublication(channel, streamId);
ExclusivePublication pub3 = aeron.addExclusivePublication(channel, streamId);

System.out.println("pub1 sessionId: " + pub1.sessionId()); // 如：213897
System.out.println("pub2 sessionId: " + pub2.sessionId()); // 如：-421387
System.out.println("pub3 sessionId: " + pub3.sessionId()); // 如：2378636

// 一个 Subscription 接收来自所有 Session 的数据
Subscription sub = aeron.addSubscription(channel, streamId);
```

### 4.4 在 FragmentHandler 中识别来源

```java
// 使用 Map 维护 session 到业务状态的映射
private final Map<Integer, ClientState> clientStates = new HashMap<>();

FragmentHandler handler = (buffer, offset, length, header) -> {
    int sessionId = header.sessionId();
    int streamId  = header.streamId();

    // 查找或创建该 session 对应的业务状态
    ClientState state = clientStates.computeIfAbsent(
        sessionId, id -> new ClientState(id)
    );

    // 根据消息类型处理
    byte msgType = buffer.getByte(offset);
    switch (msgType) {
        case MSG_CONNECT:
            state.onConnect(buffer, offset, length);
            break;
        case MSG_ORDER:
            state.onOrder(buffer, offset, length);
            break;
        case MSG_CANCEL:
            state.onCancel(buffer, offset, length);
            break;
    }
};
```

### 4.5 监听 Session 上下线事件

Aeron 提供 `availableImageHandler` 和 `unavailableImageHandler` 回调，可以感知 Session 连接和断开：

```java
Subscription sub = aeron.addSubscription(
    channel,
    streamId,
    // 新 Session 上线（新的 Image 可用）
    image -> {
        System.out.println("New publisher connected: sessionId=" + image.sessionId()
            + ", source=" + image.sourceIdentity());
        clientStates.put(image.sessionId(), new ClientState(image.sessionId()));
    },
    // Session 下线（Image 不可用）
    image -> {
        System.out.println("Publisher disconnected: sessionId=" + image.sessionId());
        clientStates.remove(image.sessionId());
    }
);
```

---

## 五、三者关系与完整标识体系

### 5.1 完整标识

```
Publication 完整标识 = Channel URI + Stream ID + Session ID
                       （唯一确定一个数据发布源）

Subscription 标识   = Channel URI + Stream ID
                       （订阅某频道上某条流的所有来源）

Image 标识          = Channel URI + Stream ID + Session ID
                       （Subscription 端对某 Publication 的本地视图）
```

### 5.2 标识关系图

```
aeron:udp?endpoint=192.168.1.10:40123    ← Channel（物理通道）
         │
         ├── streamId=10                 ← Stream（逻辑数据流）
         │       │
         │       ├── sessionId=213897    ← Session / Image（发布者A）
         │       ├── sessionId=-421387   ← Session / Image（发布者B）
         │       └── sessionId=2378636   ← Session / Image（发布者C）
         │
         └── streamId=20
                 │
                 └── sessionId=7654321   ← Session / Image（发布者D）
```

### 5.3 AeronStat 中的三元组展示

通过 AeronStat 工具，可以实时看到每个 Channel/Stream/Session 的位置信息：

```
# 格式：counter-value - counter-type: streamId sessionId termId channel

28:    8,388,896 - pub-pos (sampled): 1  1985493803  1  aeron:udp?endpoint=localhost:2000
                                      ↑  ──────────  ↑
                                   streamId  sessionId  termId
```

---

## 六、消息顺序保证

### 6.1 顺序规则

```
顺序保证范围：同一 Image（= 同一 Channel + Stream + Session）内严格有序

跨 Image 无全局顺序保证：
  pub1.offer(msgA)   ─┐
                       ├─► Subscription：msgA 与 msgB 到达顺序不确定
  pub2.offer(msgB)   ─┘
```

### 6.2 代码示例

```java
// ✅ 单 Publication：严格保序
Publication pub = aeron.addPublication(channel, streamId);
pub.offer(msg1);  // 一定先到
pub.offer(msg2);  // 一定后到

// ⚠️ 多 ExclusivePublication（不同 Session）：无全局顺序
ExclusivePublication pub1 = aeron.addExclusivePublication(channel, streamId);
ExclusivePublication pub2 = aeron.addExclusivePublication(channel, streamId);
pub1.offer(msgA);  // 可能先到，也可能后到
pub2.offer(msgB);  // 取决于网络和调度

// ✅ 需要跨 Session 全局有序：使用单一 Publication 或经由 Aeron Cluster 排序
```

### 6.3 Image 级别的独立消费位置

每个 Image 维护独立的 `sub-pos`，Subscription 的消费进度是每个 Image 分别追踪的：

```
Subscription poll() 的工作方式：
  Round-robin 遍历所有活跃 Image，依次消费各自的 fragment
  每个 Image 的 sub-pos 独立推进
  同一 Image 内严格有序，不同 Image 间顺序取决于 poll 时机
```

---

## 七、实战：金融交易系统完整示例

### 7.1 架构设计

```
                    市场数据组播频道（224.10.9.10:40123）
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         streamId=10    streamId=20    streamId=30
          (股票行情)     (外汇行情)     (期货行情)
              │
    ┌─────────┴─────────┐
    │                   │
 sessionId=AAA       sessionId=BBB
 (交易所 Feed A)     (交易所 Feed B)
```

### 7.2 完整实现

```java
public class TradingSystem {

    // Channel 定义
    private static final String MARKET_DATA_CHANNEL =
        "aeron:udp?endpoint=224.10.9.10:40123|interface=eth0";
    private static final String ORDER_CHANNEL =
        "aeron:udp?endpoint=192.168.1.20:40124";
    private static final String INTERNAL_CHANNEL = "aeron:ipc";

    // Stream ID 分配（按业务模块分区间）
    private static final int EQUITY_STREAM   = 10;
    private static final int FOREX_STREAM    = 20;
    private static final int FUTURES_STREAM  = 30;
    private static final int ORDER_STREAM    = 1000;
    private static final int CONTROL_STREAM  = 9000;

    // Session 状态管理
    private final Map<Integer, FeedState> feedStateMap = new ConcurrentHashMap<>();

    public void run() throws Exception {
        try (MediaDriver driver = MediaDriver.launchEmbedded();
             Aeron aeron = Aeron.connect(new Aeron.Context()
                 .aeronDirectoryName(driver.aeronDirectoryName()))) {

            setupMarketDataSubscriptions(aeron);
            setupOrderPublications(aeron);
            runEventLoop(aeron);
        }
    }

    private void setupMarketDataSubscriptions(Aeron aeron) {
        // 订阅股票行情，监听 Session 上下线
        Subscription equitySub = aeron.addSubscription(
            MARKET_DATA_CHANNEL, EQUITY_STREAM,
            image -> {
                System.out.println("[EQUITY] Feed connected: " + image.sourceIdentity()
                    + " sessionId=" + image.sessionId());
                feedStateMap.put(image.sessionId(), new FeedState(image.sessionId()));
            },
            image -> {
                System.out.println("[EQUITY] Feed disconnected: sessionId=" + image.sessionId());
                feedStateMap.remove(image.sessionId());
            }
        );

        // 外汇和期货行情（同 Channel，不同 Stream）
        Subscription forexSub   = aeron.addSubscription(MARKET_DATA_CHANNEL, FOREX_STREAM);
        Subscription futuresSub = aeron.addSubscription(MARKET_DATA_CHANNEL, FUTURES_STREAM);
    }

    private void setupOrderPublications(Aeron aeron) {
        // ExclusivePublication：单线程独占，性能更高
        ExclusivePublication orderPub =
            aeron.addExclusivePublication(ORDER_CHANNEL, ORDER_STREAM);

        System.out.println("Order publication sessionId: " + orderPub.sessionId());
    }

    private void runEventLoop(Aeron aeron) {
        // ...在 Agrona Agent duty cycle 中轮询 Subscription
    }
}
```

### 7.3 Session 级别的消息重放（结合 Aeron Archive）

```java
// 重放时指定 sessionId，只回放特定发布者的历史数据
long replaySessionId = archiveClient.startReplay(
    recordingId,
    startPosition,
    Long.MAX_VALUE,           // 回放到最新位置
    replayChannel,
    replayStreamId
);

// 订阅回放流，sessionId 即为 replaySessionId
Subscription replaySub = aeron.addSubscription(replayChannel, replayStreamId);
```

---

## 八、常见问题与排查

### Q1：Publication 一直返回 NOT_CONNECTED（-1）？

```
原因：Subscription 尚未启动，或 Channel/Stream ID 不匹配。

排查步骤：
  1. 确认 Subscription 已启动并正在轮询
  2. 确认 Publication 的 channel 填写的是 Subscription 的地址（推模式）
  3. 确认 streamId 两端一致
  4. 使用 AeronStat 查看是否有对应的 rcv-channel 条目
```

### Q2：同一 Stream 收到乱序消息？

```
原因：消息来自不同的 Session（不同 ExclusivePublication），
      跨 Session 无全局顺序保证。

解决方案：
  • 方案1：使用单一 Publication（不使用 Exclusive）
  • 方案2：消息中携带业务序列号，接收方自行排序
  • 方案3：使用 Aeron Cluster 进行全局定序
```

### Q3：如何区分同一 Stream 上不同 Publisher 的消息？

```java
// 在 FragmentHandler 中通过 header.sessionId() 区分
void onFragment(DirectBuffer buffer, int offset, int length, Header header) {
    int sessionId = header.sessionId();
    // sessionId 即为 Publisher 的唯一标识
    ClientState state = sessionStateMap.get(sessionId);
    // ...
}
```

### Q4：Session ID 为什么会是负数？

```
Session ID 是 32 位有符号随机整数，取值范围为 [-2^31, 2^31-1]。
负数是完全正常的，不代表任何异常。
在代码中使用时，直接用 int 类型存储和比较即可，
避免错误地用 unsigned 语义处理。
```

---

## 九、总结

```
┌───────────────────────────────────────────────────────────────┐
│                    三层概念速查表                              │
├──────────┬──────────────────────────────┬────────────────────┤
│  概念    │         核心作用              │  标识符             │
├──────────┼──────────────────────────────┼────────────────────┤
│ Channel  │ 定义传输媒体和网络地址        │ URI 字符串          │
│          │ (UDP/IPC + 地址参数)          │                    │
├──────────┼──────────────────────────────┼────────────────────┤
│ Stream   │ Channel 内的有序逻辑数据流    │ 32位整数 streamId  │
│          │ 按业务分类，多路复用同一端口   │ (非0，应用层约定)  │
├──────────┼──────────────────────────────┼────────────────────┤
│ Session  │ 区分同一 Stream 上的          │ 32位整数 sessionId │
│          │ 不同 Publication 实例         │ (Aeron 随机生成)   │
├──────────┴──────────────────────────────┴────────────────────┤
│ 顺序保证：仅在同一 Image（同一 Channel+Stream+Session）内      │
│ 跨 Session 无全局顺序，需要全局有序请使用 Aeron Cluster        │
└───────────────────────────────────────────────────────────────┘
```

**设计建议：**
- Channel 按**网络隔离需求**划分（高频 vs 管理、IPC vs UDP）
- Stream ID 按**业务模块**划分，预留区间便于扩展
- 利用 `availableImageHandler` / `unavailableImageHandler` 感知 Session 生命周期
- 多 Session 场景下，用 `Map<Integer, State>` 以 sessionId 为 key 管理各客户端状态
