---
title: Aeron Archive 技术文档
date: 2026-03-11 16:31:24
tags:
  - 高性能
  - 分布式
  - Aeron
categories:
  - 高性能组件
  - Aeron
---
## 1. 简介

Aeron Archive 是 Aeron 生态系统的重要组成部分，提供对消息流进行**持久化存储、录制和回放**的能力。

**核心特性：**

- **高性能设计**：在配备足够快速存储的情况下，可以以 10GigE 线速录制或回放消息流
- **Spy 功能**：无需激活 Subscription 即可录制 Publication
- **扩展录制**：可以在重启后继续向现有录制追加数据
- **高效录制**：本地网络 Publication 使用 Spy 特性提高效率
- **三种回放模式**：
  - **直接回放**：从 Archive 直接回放到目标 Subscription
  - **合并回放**：先回放历史数据，然后切换到实时流
  - **追踪回放**：回放正在进行的录制，自动跟随最新数据

Aeron Archive 是一个使用 Aeron Transport 进行通信的应用程序，与任何使用 Aeron Transport 编写的应用程序没有任何不同，**对 Aeron Transport 内部结构没有特权访问**。

---

## 2. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│                      Client Process                       │
│                                                           │
│  ┌─────────────┐          ┌──────────────────────────┐   │
│  │ Application │          │     Archive Client        │   │
│  │ 1. 业务逻辑  │ ──────── │ 2. 录制/回放请求处理      │   │
│  └─────────────┘          └──────────────────────────┘   │
│                                       │                   │
│                              3. Archive 协议通信           │
└──────────────────────────────────────┼───────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────┐
│                  Archive Service Process                   │
│                                                           │
│  ┌──────────────────┐     ┌──────────────────────────┐   │
│  │ Archiving Media  │     │      Archive Agent        │   │
│  │     Driver       │     │  • 录制管理               │   │
│  │  4. 媒体传输      │ ─── │  • 回放控制               │   │
│  └──────────────────┘     │  • 文件操作               │   │
│                           └──────────────────────────┘   │
│                                       │ 5. 存储操作        │
│                                       ▼                   │
│                    ┌─────────────────────────────────┐   │
│                    │          持久化存储               │   │
│                    │  • Catalog（元数据）              │   │
│                    │  • Segment Files（数据）          │   │
│                    │  • Mark Files（状态）             │   │
│                    └─────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**Archive Agent 支持的命令类型：**

| 命令类型 | 具体操作 |
|---------|---------|
| 录制控制命令 | 开始、停止、扩展录制 |
| 回放控制命令 | 开始回放、暂停、恢复、停止 |
| 状态查询请求 | 录制列表、进度查询、元数据获取 |
| 管理操作命令 | 截断、清理、复制、迁移 |

---

## 3. 关键组件

### Aeron Archive Service

- **功能**：提供录制和回放流的核心服务
- **特点**：高性能、持久化存储管理
- **部署**：可独立运行或嵌入其他服务

### Aeron Archive Client（`AeronArchive` 类）

- **功能**：客户端接口，用于请求录制和回放操作
- **位置**：运行在接收归档流的进程中
- **协议**：通过专用协议与 Archive Service 通信
- **连接**：调用 `AeronArchive.connect()` 与 Archive 应用建立连接并创建 **控制会话（ControlSession）**

### Archiving Media Driver

- **功能**：包含标准 Media Driver 的扩展版本
- **启动**：通过 `ArchivingMediaDriver` 启动
- **组合**：通过组合方式包含 Media Driver

### Archive 内部组件关系

```
┌─────────────────────────────────────────────────────────┐
│                    Aeron Archive                         │
│                                                          │
│  ┌────────────┐    ┌──────────────────┐                 │
│  │  Replayer  │    │  Publications    │                  │
│  ├────────────┤    ├──────────────────┤   Shared        │
│  │  Archive   │    │ Client Conductor │ ─ Memory ─ Media │
│  │ Conductor  │    ├──────────────────┤          Driver │
│  ├────────────┤    │  Subscriptions   │                  │
│  │  Recorder  │    └──────────────────┘                 │
│  └────────────┘    Aeron Transport Client                │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 持久化存储结构

### 4.1 Catalog 元数据存储（`archive.catalog`）

目录文件类似于目录表，用于跟踪所有录制和它们的段文件。

- 记录所有录制的元数据信息
- 包含录制ID、开始/结束位置、时间戳、通道信息等
- 包含每个录制的：`startPosition`、`stopPosition`、起始/结束时间戳、`termLength`、`streamId`、`sessionId` 等
- 提供快速的录制查找和索引功能
- 支持事务性更新，确保元数据一致性
- 你可以把一个录制看作一个 DVD 套装，段文件各各独立的 DVD，存档目录就是你的目录页

### 4.2 Segment Files 段文件存储（`*.rec`）

段文件直接包含从被录制的 Publication 的日志缓冲区中的 Term 复制过来的原始数据。

**文件特性：**

- 存储实际的消息数据内容
- 采用分段存储策略，**每个段文件固定大小**（默认 128 MB）
- 支持顺序写入和随机读取操作
- 可选数据压缩和校验机制
- 段文件长度必须是介于 64 KB 到 1 GB（含）之间的 2 的幂
- 没有额外的数据格式层，也不存在段文件头或段元数据之类的东西，**任何附加数据都在目录中**
- 将 Recording 拆分成多个文件使其更易于管理，例如可以在仍在写入最新 Segment 文件时删除旧的 Segment 文件

**命名规范：**

```
格式：<recordingId>-<segmentFileBasePosition>.rec
```

- `recordingId`：从 0 开始递增的数字，标识哪个录制
- `segmentFileBasePosition`：该文件起始位置在 Publication 中的偏移量（`segmentFileBasePosition`）

**命名示例：**

```
0-0.rec           # 录制0，从Publication位置0开始
0-131072.rec      # 录制0，从位置131072开始
0-262144.rec
0-393216.rec
0-524288.rec
0-655360.rec

1-65536.rec       # 录制1，从位置65536开始
1-196608.rec
1-327680.rec

archive.catalog
archive-mark.dat
```

这里有两个 Recording，意味着记录了两个不同的 Publication。第一个 Recording 存储在 `0-*.rec` 文件中，第二个存储在 `1-*.rec` 中。

**段文件名计算规则：**

> 假设 term 长度（Term Length）为 64 KB，每个段文件包含 4 个期限（Terms），因此 `0-0.rec` 的长度为 256 KB，即 262,144 字节。这意味着第二个段文件的起始位置对应发布中的位置 262144，所以文件名为 `0-262144.rec`。

> 段文件始终保存完整的 term，因此段文件从第 1 个 term 的起始处开始，尽管直到该 term 中间才开始录制消息（文件的前半部分将包含零）。因此 segmentFileBasePosition 为 64 KB，即 65,536，所以文件名为 `0-65536.rec`。

### 4.3 Mark Files 状态文件（`archive-mark.dat`）

Aeron Archive 创建一个标记文件 `archive-mark.dat`，包含两部分：

- **第一部分**：包含有关归档的信息。其内容由 `aeron-archive-mark-codecs.xml` 中的 `MarkFileHeader` 定义
- **第二部分**：一个用于错误日志的缓冲区，包装为 `DistinctErrorLog`，类似于 Aeron Transport 的 `cnc.dat` 文件。Aeron Archive 中发生的任何错误都会记录在此

**Mark Files 作用：**

- 记录录制和回放操作的状态信息
- 提供进程间的状态同步机制
- 支持故障恢复和状态重建
- 维护系统运行时的健康状态信息

### 4.4 Catalog Refresh（目录刷新）

当 Aeron Archive 启动时，不会有活动的 Recording，因此目录中的每个 `RecordingDescriptor` 都应具有 `stopPosition`。如果 Aeron Archive 未能正常关闭，情况可能并非如此，所以在**启动时**，Aeron Archive 会扫描目录以查找缺失的停止位置：

- 对于找到的任何项，它会打开该 Recording 的最后一个段（Segment）文件，并遍历所有片段，直到找到最后一个（即下一个帧的长度字段为零）
- 将目录中的 `stopPosition` 设置为该片段的结尾，并将 `stopTimestamp` 设置为当前时间

### 4.5 Checksums 校验和

Aeron Archive 可以配置为在将 DATA 帧记录到 Segment 文件时为每个帧添加校验和，在回放 Recording 时会验证该校验和。

- **写入位置**：校验和写入每个 DATA 帧头中，覆盖 `sessionId` 字段
- **回放时**：`sessionId` 和 `streamId` 字段无论如何都会被回放 Publication 的值覆盖，因此丢失原始 `sessionId` 并不重要
- **空间影响**：以这种方式复用现有字段意味着启用校验和时，Segment 文件不需要变得更大，对文件结构的影响很小
- 段文件中记录的数据与通过日志缓冲区传输的数据完全相同

---

## 5. 线程模型

### archiveThreadMode 三种模式

| 模式 | 线程数 | 说明 |
|------|--------|------|
| **INVOKER** | 0 个线程 | 不创建线程，Archive 嵌入在你的应用中，需由应用主动调用 |
| **SHARED** | 1 个线程 | 创建一个线程，该线程调用 `ArchiveConductor`、`Recorder` 和 `Replayer` 的职责循环 |
| **DEDICATED** | 3 个线程（默认） | 为 `ArchiveConductor`、`Recorder` 和 `Replayer` 各创建一个线程 |

### ArchivingMediaDriver 线程模型

在使用 `ArchivingMediaDriver` 组合时，Media Driver 和 Archive 的线程模式是**相互独立**的。

**示例：** Archive 使用 `DEDICATED` 模式，而 Media Driver 使用 `INVOKER` 模式：
- Archive 会使用 3 个线程，而 Media Driver 不会使用任何线程
- `ArchiveConductor` 将负责调用 Media Driver，以便为其提供 CPU 资源

---

## 6. Archive 部署方式

Aeron Archive 有四种运行方式：

1. **基于多个 Agrona Agent**：类似于 Aeron Transport 的方式
2. **与 Media Driver 同址运行**：使用复合的 `ArchivingMediaDriver`，该驱动包含一个 MediaDriver 和一个 Archive
3. **作为独立应用在其自身进程中运行**：使用 `Archive` 类的 `main()` 方法。以这种方式运行时，必须通过系统属性进行配置，而不是通过编程方式配置
4. **嵌入到你自己的某个应用程序中**：可以在其自己的线程上运行，也可以由应用程序调用

---

## 7. 工作流程总览

```
1. 运行 Aeron Archive 应用程序
   ↓
2. 用户应用调用 AeronArchive.connect()
   → 与 Aeron Archive 应用建立连接
   → 创建控制会话（ControlSession）
   ↓
3. 用户应用在 AeronArchive 客户端上调用其他方法
   → 通过控制会话向 Aeron Archive 应用发送控制请求（control request）消息
   → 在控制响应返回通道上接收响应
```

**使用案例（以市场数据录制为例）：**

```
1. 创建一个市场数据的 Publication
2. 使用 Archive 的 Client API 连接到 Aeron Archive
3. 指挥 Aeron Archive 开始进行 Publication 的录制
4. 继续采集和发布市场的新数据变更
```

**典型业务场景（交易系统）：**

```
Machine 1                              Machine 2
┌─────────────────┐                 ┌──────────────────────┐
│ Market Data     │  live market    │  Media Driver        │
│ Collector  Pub → Pub → Sender  → data channel → Receiver │
│                 │                 │  Image → Sub         │
└─────────────────┘                 │  Trading Strategy    │
                                    └──────────────────────┘
```

- **追赶（catchup）**：如果重启或部署了新的交易策略版本，而市场数据采集器继续运行，可以重放交易策略停机期间错过的实时数据。一旦同步完成，交易策略可重新加入实时流（称为**重放合并**）
- **开发环境重放**：能够在开发环境中重放实时数据，以重现并逐步分析实时交易策略经历的场景
- **A/B 测试**：能够用与实时交易策略处理的相同市场数据测试新版本交易策略，以评估新版本是否表现更好

---

## 8. Archive 操作详解

### 8.1 开始录制 Start Recording

**参数：** `channel`、`streamId`、`sourceLocation`

**流程：**
1. 在该 Channel 和 StreamId 上创建一个 Subscription
2. 分配一个 `recordingId`（从 0 开始递增的数字）
3. 在目录（Catalog）中创建一个 `RecordingDescriptor`，包含关于 Publication（`termLength`、`streamId` 等）和录制（`startTimestamp`、`startPosition` 等）的元数据

**SourceLocation 参数说明（仅在 network publication 下有意义）：**

| 值 | 适用场景 | 行为 |
|----|---------|------|
| `SourceLocation.LOCAL` | 在网络发布的**发送端**进行记录 | Archive 在 Channel 开头添加 `aeron-spy:` 从而创建一个 Spy Subscription，从 Publication 日志缓冲区读取消息 |
| `SourceLocation.REMOTE` | 在网络发布的**接收端**进行记录 | Archive 创建一个普通 Subscription（独立于 Aeron Transport），从 Image 日志缓冲区读取消息 |
| `SourceLocation.NULL_VAL` | IPC 发布 | sourceLocation 参数不用于 IPC 发布 |

**Spy Subscription 原理图：**

```
Machine 1
┌──────────────────────────────────────┐
│  Market Data                         │
│  Collector  Pub ──────────→ Pub ──→ Sender (Media Driver)
│                              │
│                             Spy
│                              │
│  Aeron Archive   Sub ◄───────┘
│                   │
│               Recording ──→ Segment Files
└──────────────────────────────────────┘
```

当创建 Spy Subscription（图中为"Sub"）并调用 `AvailableImageHandler` 时，Image（在 Aeron 客户端中只是一个指向日志缓冲区的 Java 对象）对应的是 Publication 的日志缓冲区（图中为"Pub"）。Aeron Archive 中的 `RecordingSession` 是专为该 Image 创建的。

### 8.2 停止录制 Stop Recording

关闭对该发布的 Subscription，关闭活动段文件，并在目录中记录 `stopPosition` 和 `stopTimestamp`。

### 8.3 扩展录制 Extend Recording

扩展录制意味着**重新打开录制并在其末尾追加新的消息**。

**典型用例：** 当应用重启后，希望从上次停止的地方继续向同一录制写入。

**在目录（Catalog）中**：清除 `stopPosition` 和 `stopTimestamp`，因为录制已再次变为活动状态。

**使用条件（必须同时满足）：**

1. **Recording 必须处于非活动状态**：必须已停止并具有 `stopPosition`
2. **相同的 streamId**：扩展请求必须使用相同的 `streamId`（防止数据错乱）
3. **无间隙连续性**：扩展的起始位置必须等于 Recording 的 `stopPosition`（记录之间不能有间隙）
4. **参数一致性**：新 Publication 的 `initialTermId`、`termLength` 和 `mtuLength` 必须与被记录的原始 Publication 相同（这些值存储在目录中）

**无缝隙进行扩展录制：**

- Subscription 的起始位置应与录制的 `stopPosition` 相匹配
- 录制开始时，它会在任何消息发布之前订阅该 Publication，因此加入位置将是其初始位置
- 可以通过在新 Publication 的 Channel 中设置初始位置、`initialTermId`、`termLength` 和 `mtuLength`，使用来自录制的值

**扩展模式特性：**

- 支持多次扩展：同一录制可以多次停止和重新开始
- 版本兼容性：确保扩展录制与原录制格式兼容
- 权限控制：只有授权用户可以扩展现有录制
- 完整性保证：扩展过程中维护数据的完整性和一致性

### 8.4 列出录制 List Recordings

查询目录以检索有关录制的信息。这在用户应用程序启动期间很有用，以查找应用程序希望继续使用的现有录制。

所有方法通过**回调**返回数据，该回调返回所有 `RecordingDescriptor` 参数。

**使用 `alias` 参数进行过滤：**

- 在 Publication 的 Channel 上设置 `alias` 参数是一个字符串值，Aeron 不会使用它，因此可以将其设置为具有描述性的内容
- 在列出录制时，可以通过 `RecordingDescriptor` 的 `originalChannel` 或 `strippedChannel` 字段对 `alias` 参数进行过滤

### 8.5 回放录制 Replay Recording

将已记录的消息重放回用户应用。

**两种启动方式：**

| 方法 | 说明 |
|------|------|
| `AeronArchive.replay()` | 还会自动创建一个 Subscription 对象，用户应用可以使用它来接收回放的数据 |
| `AeronArchive.startReplay()` | 要求用户应用**自行创建** Subscription |

**回放参数说明：**

| 参数 | 说明 |
|------|------|
| `recordingId` | 目标录制的唯一标识符，可从 Catalog 查询获得 |
| `replayPosition` | 开始回放的位置（字节偏移），`NULL_POSITION` 表示从头开始 |
| `length` | 回放的数据长度，`NULL_LENGTH` 表示回放全部；`Long.MAX_VALUE` 表示在 Recording 末尾进行**尾部跟踪（tail-follow）** |
| `replayChannel` | 回放数据的目标 Channel，客户端将订阅此 Channel |
| `replayStreamId` | 回放数据的目标 Stream ID |

**startBoundedReplay()：**

- 行为类似 `startReplay()`
- 额外传入 `limitCounterId`（计数器在 `cnc.dat` 中）
- 回放操作将查询该计数器以确定它可以读取到的位置，该计数器会在回放过程中不断前进

### 8.6 停止回放 Stop Replay

停止一个回放会话，需要传入 `replaySessionId` 参数，该参数由 `startReplay()` 方法返回。

### 8.7 分离段文件 Detach Segments

**参数：** `recordingId` + `startPosition`（新的 startPosition）

**新 startPosition 的合法条件：**

- 位于 Segment 文件的开头
- 高于当前起始位置，以便至少分离出一个 Segment 文件
- 不高于已停止录制的 `stopPosition`，或活动录制的 `rec-pos`
- 不高于任何重放位置

**效果：**

- 如果新的 `startPosition` 有效，则 Catalog 中的 `startPosition` 会更新为该值，其他内容均保持不变
- 分离的 Segment 文件将不再被 Aeron Archive 访问，用户可以随意处理（移动到另一台机器、压缩等）

### 8.8 附加段文件 Attach Segments

与分离 Segments 相反，允许将 Segment 文件添加到录制记录的开头。

**使用条件：**

- Catalog 中的当前 `startPosition` 必须位于第一个 Segment 文件的开头
- 新的 Segment 文件必须紧邻当前 `startPosition`，附加后录制记录中不会出现间隙
- 需要在请求 Aeron Archive 附加文件**之前**，手动将 Segment 文件添加到存档目录中

**工作原理：**

- 只需传入 `recordingId` 参数，它会从当前第一个 Segment 文件开始自动向后搜索
- 对于找到的每个文件，检查文件长度是否为 Segment 文件长度，然后在文件中第一个 Term 的数据量中查找第一个片段
- 如果第一个片段位于文件开头，执行基本检查（`termId` 和 `streamId` 是否正确），然后更新 Catalog 中的 `startPosition`
- 如果第一个片段不在文件开头（文件开头的 Frame 长度为零），向前遍历检查每个对齐边界（每 32 字节）查找非零的 Frame 长度，找到后执行相同的基本检查并更新 `startPosition`

### 8.9 清理段 Purge Segments

与分离段（Detach Segments）相同，但**同时删除**已分离的段文件。

### 8.10 清理录制 Purge Recording

**参数：** `recordingId`

**使用条件：**

- Recording 必须已经停止（`stopped`）
- 不再被回放的 Recording

**效果：**

- 从目录（Catalog）中移除 `RecordingDescriptor`
- 删除该 `recordingId` 的所有段文件

### 8.11 截断录制 Truncate Recording

**参数：** `recordingId` + `newStopPosition`

**验证条件（Recording 必须处于静止状态）：**

- 不能有任何正在进行的 Replay
- Recording 必须有一个 `stopPosition`（不得处于活动状态）
- `newStopPosition` 必须位于 `startPosition` 和 `stopPosition`（含）之间，且位于帧边界上

**效果：**

- 目录中的 `stopPosition` 将被设置为 `newStopPosition`
- 如果 `newStopPosition` 不在段文件（Segment file）的起始位置，则该文件中 `newStopPosition` 之后的所有内容都会被置为零
- 位于 `newStopPosition` 之后的完整段文件将被删除
- 如果 `newStopPosition == startPosition`，则所有段文件都会被删除，但 Recording 仍保留在 Catalog 中

### 8.12 归档复制 Replication

用于将录制从一个归档复制到另一个归档。

**场景：** 设想有一个主归档（source）和一个备份归档（destination），将主归档复制到备份归档。

**方向说明：**

- 主归档是**源（source）**，数据的来源
- 备份归档是**目标（destination）**
- 向**目标（备份）**发送复制请求，要求它从**源（主归档）**进行复制

**复制流程：**

```
目标 Archive 创建 ReplicationSession 管理复制
    ↓
启动一个 RecordingSession
    ↓
使用 Archive 客户端连接到源 Archive
    ↓
发送重放请求（Replay Request）
    ↓
请求将源数据 replay 到当前 RecordingSession 创建的 Subscription 上
```

- **源端**：Replay（回放）
- **目标端**：Recording（录制）

---

## 9. Recording 生命周期

### 状态机

```
           开始录制              处理消息              停止录制
              ↓                    ↓                    ↓
┌──────────┐      ┌──────────────────────┐      ┌────────────┐
│  START   │─────→│       ACTIVE         │─────→│  STOPPED   │
│ 创建录制  │      │ • 持续写入消息数据    │      │ • 完成录制  │
│ 元数据   │      │ • Position 更新       │      │ • 更新状态  │
└──────────┘      │ • Segment 文件        │      └────────────┘
     │            │ • 实时状态            │            │
     │            └──────────────────────┘            │
     ↓                                                 ↓
 Recording ID                                    Stop Position
 Channel/Stream                                  Stop Timestamp
 Start Position                                  最终元数据
```

**扩展录制（重启后继续）：**

```
STOPPED ─────→ ACTIVE（扩展模式）
                └── 从 Stop Position 继续
└── 重新打开现有录制
```

### RecordingDescriptor 关键字段

| 字段 | 说明 |
|------|------|
| `recordingId` | 唯一标识符，从 0 开始递增 |
| `startTimestamp` | 录制开始时间戳 |
| `stopTimestamp` | 录制停止时间戳（活动录制时为空） |
| `startPosition` | 录制开始位置（字节偏移） |
| `stopPosition` | 录制停止位置（活动录制时为空） |
| `initialTermId` | 初始期限 ID |
| `segmentFileLength` | 段文件长度 |
| `termBufferLength` | Term 缓冲区长度（即 `termLength`） |
| `mtuLength` | MTU 长度 |
| `sessionId` | Aeron 会话 ID |
| `streamId` | Stream ID |
| `channel` | 原始 Channel（`originalChannel`） |
| `strippedChannel` | 去除参数后的 Channel |
| `sourceIdentity` | 源标识（如 `aeron:ipc` 或 `host:port`） |

---

## 10. 控制通道配置

一旦用户应用连接到 Aeron Archive，就可以通过控制请求通道向其发送控制请求。每条发送到 Archive 的消息都包含 `controlSessionId`，用于标识控制会话（`ControlSession`）。该控制会话包含用于将响应消息发送回应用的控制响应通道的 Publication。

### UDP 控制通道配置（默认）

```properties
aeron.archive.control.channel.enabled=true
aeron.archive.control.channel=
aeron.archive.control.stream.id=10
```

### 本地 IPC 控制通道配置

```properties
aeron.archive.local.control.channel=aeron:ipc
aeron.archive.local.control.stream.id=10
```

### 请求和响应消息

完整的请求和响应消息列表定义在：
`aeron-archive/src/main/resources/archive/aeron-archive-codecs.xml`

---

## 11. 录制事件与计数器

### 录制信号事件（RecordingSignalEvent）

当用户应用程序启动或停止录制时，会通过其控制响应通道向其发送 `RecordingSignalEvent` 消息。

Aeron Archive 还包含一个**录制事件通道**（默认情况下禁用），如有需要可以配置为向多个客户端（在多台主机上）广播录制事件，支持 MDC（多目标传送）。

**Recording 事件由 RecordingSession 发送：**

| 事件 | 参数 |
|------|------|
| `RecordingStarted` | `recordingId`, `channel`, `streamId`, `sessionId`, `startPosition`, `sourceIdentity` |
| `RecordingProgress` | `recordingId`, `startPosition`, `position` — 每次写入后，`rec-pos` 更新后发送 |
| `RecordingStopped` | `recordingId`, `startPosition`, `stopPosition` |

### Counter 计数器

- `Recorder` 可以包含多个 `RecordingSession`，每个 `RecordingSession` 都有一个 `RecordingWriter`
- 每当 `RecordingWriter` 向段文件写入时，它会将写入的字节数和写入这些字节所用的时间（以纳秒为单位）报告回 `Recorder`
- `Recorder` 使用这些信息在 `cnc.dat` 文件中维护**三个计数器**：

```
120,048  - archive-recorder max write time in ns  - archiveId=1
 31,744  - archive-recorder total write bytes      - archiveId=1
1,353,831 - archive-recorder total write time in ns - archiveId=1
```

---

## 12. Start Replay 完整流程

### 流程概览

```
客户端                    Archive Service              Storage
   │                           │                          │
   │  1. startReplay()         │                          │
   │   (recordingId, position, │                          │
   │    length, replayChannel) │                          │
   │──────────────────────────→│                          │
   │                           │  2. 验证参数              │
   │                           │──────────────────────────→
   │                           │  3. 创建 ReplaySession    │
   │                           │──────────────────────────→
   │  4. sessionId 返回         │                          │
   │←──────────────────────────│                          │
   │  5. 订阅 replayChannel     │                          │
   │                           │  6. 流式传输数据           │
   │←──────────────────────────────────────────────────────
```

### 详细步骤

#### 步骤 1：客户端请求开始回放

- 客户端通过 `AeronArchive.replay()` 或 `startReplay()` 方法发起
- 向 Aeron Archive 发送一个 `ReplayRequest` 消息以开始回放
- `replay()` 方法还会创建一个 Subscription 对象；`startReplay()` 要求用户应用自行创建 Subscription
- 请求采用异步方式发送，不阻塞客户端主线程

#### 步骤 2：Archive 为 replayChannel 创建一个 Publication

Aeron Archive 最终都会进入 `ArchiveConductor.startReplay()`：

1. 检查目录（Catalog）是否包含 `recordingId`，然后加载一个 `RecordingSummary`（包含 `startPosition`，如果录制不再活动则包含 `stopPosition`）
2. 检查 `replayPosition` 以确保其在**帧边界**上对齐（32 的倍数），并且处于录制的 `startPosition` 与 `stopPosition`（如果已设置）之间
3. `ArchiveConductor` 异步开始创建一个回发到 `replayChannel` 和 `replayStreamId` 的 `ExclusivePublication`（`initialTermId` 和 `termLength` 也从 `RecordingSummary` 中设置）
4. `ArchiveConductor` 将一个 `CreateReplayPublicationSession` 添加到其会话列表中。每当它被处理时，检查 publication 是否已创建

**Archive Service 验证参数阶段：**

- **录制存在性验证**：检查 `recordingId` 是否存在于 Catalog 中，验证录制状态是否允许回放（已完成或正在进行的录制），确认录制文件的完整性和可访问性
- **参数合理性检查**：验证 `position` 是否在录制的有效范围内，检查 `length` 参数的合理性，防止超出录制边界，确认 `replayChannel` 的格式正确性和可用性
- **权限和资源检查**：验证客户端是否有权访问该录制，检查系统资源是否足够支持新的回放会话，确认并发回放会话数量是否在限制范围内

#### 步骤 3：Archive 创建一个 Replay Session

当 Replay Publication 已创建后，`CreateReplayPublicationSession` 调用 `ArchiveConductor.newReplaySession()`：

- 该调用向 `Replayer` 添加了一个新的 `ReplaySession`
- `CreateReplayPublicationSession` 将自身标记为"完成"，从会话列表中移除并被丢弃

**会话资源分配：**

- 生成唯一的 Session ID，用于标识此次回放会话
- 分配内存缓冲区用于数据读取和传输
- 创建 Publication 实例向 `replayChannel` 发送数据
- 初始化回放状态跟踪和进度监控机制

**Storage Access 准备：**

- 定位并打开相关的 Segment 文件
- 计算起始位置在文件中的精确偏移量
- 准备文件读取策略，包括预读取和缓存机制
- 建立文件访问的错误处理和重试机制

#### 步骤 4：Replay Session（INIT 状态）

默认情况下，`Replayer` 在其自己的线程中运行，对每个 `ReplaySession` 调用 `doWork()`。

`ReplaySession` 从 **INIT 状态**开始：

1. 计算哪个段文件包含 `replayPosition` 并打开该文件
2. 如果 `replayPosition` 不是录制开始位置，则验证其是否位于**片段（Fragment）的起始处**
3. `ReplaySession` **不**通过从一个任期（Term）的开始遍历录制直到 `replayPosition`，而是检查在该位置是否存在包含正确 `streamId`、`termId` 和 `termOffset` 的帧头：
   - `termOffset` 通过将 `replayPosition` 除以 `RecordingSummary` 中的 `termLength` 后取余来计算
   - `termId` 也通过 `replayPosition` 计算，使用 `initialTermId` 和 `termLength`
   - `streamId` 直接取自 `RecordingSummary`
4. 一旦验证了 `replayPosition`，`ReplaySession` 要求 `ControlSession`（位于 `ArchiveConductor` 线程上）向客户端发送带有 OK 响应码的 `ControlResponse` 消息，包含 `correlationId` 和 `replaySessionId`

**状态流转：**

```
INIT ──────────────────────────────────────────────────────→ REPLAY
 │    客户端创建 Sub 并连接了 replayChannel 的 Pub 时
 │
 └── 5 秒内未连接 ──→ INACTIVE（终止态，超时出错）
```

`ReplaySession` 在 INIT 状态，直到回到 `replayChannel` 的 Publication 已创建且客户端已连接到它（创建了 Subscription）。

#### 步骤 5：客户端订阅

当客户端收到 `ControlResponse` 消息时，它从中取出 `replaySessionId`：

- 如果用户应用调用了 `AeronArchive.replay()` 方法，归档客户端会创建一个订阅，订阅 `replayChannel` 和 `replayStreamId`，并将 **`replaySessionId` 的低 32 位**作为 `sessionId` 包含在内
- 该订阅将连接到发布端，使重放会话进入 **REPLAY 状态**，然后返回给用户应用

- 如果用户应用调用了 `AeronArchive.startReplay()` 方法，客户端会将 `replaySessionId` 回给它

#### 步骤 6：流式传输数据

**数据读取处理：**

- Archive Service 从 Storage 顺序读取录制数据
- 重构原始的 Aeron 消息格式和结构
- 应用速率控制，支持变速回放功能
- 处理跨 Segment 文件的数据连续性

**数据传输机制：**

- 使用 Publication 将数据发送到 `replayChannel`
- 维护原始消息的时序和完整性
- 应用流量控制，防止客户端处理不过来
- 监控传输进度，提供实时状态更新

---

## 13. ReplaySession 内部详解

### replaySessionId 编码结构

```java
final long replaySessionId = ((long)(replayId++) << 32) | (replayPublication.sessionId() & 0xFFFF_FFFFL);
```

| 位段 | 含义 |
|------|------|
| **低 32 位** | 重放 Publication 的 `sessionId`（客户端需要订阅该 sessionId） |
| **高 32 位** | ArchiveConductor 内的唯一 id（`replayId` 从 1 开始并按上述方式递增） |

- **客户端订阅重放 Publication 时需要低 32 位**，以便只接收来自该 `sessionId` 的消息
- **执行重放的其他操作**（例如停止重放）时则需要整个 `replaySessionId`

### ReplaySession 关键字段

| 字段 | 说明 |
|------|------|
| `replayPosition` | 被设置为 `RecordingDescriptor.startPosition`，或者如果在重放请求中设置了，则为 `position` |
| `stopPosition` | 被设置为 `limitPosition` 计数器的值（如果存在），否则为录制的 `stopPosition` |
| `replayLimit` | 要回放到的位置（回放的目标位置）|

### replayLimit 详细说明

`replayLimit` 是要回放到的位置（回放的目标位置）：

- 如果存在 `limitPosition` 计数器，则该值为 `Long.MAX_VALUE`（因为限制由该计数器控制）
- 如果没有计数器（仅在录制已停止时出现），则将其设置为录制的 `stopPosition`
- 在这两种情况下，`replayLimit` 可以被回放请求中的 `length` 减少（但不能增加），如果该值被设置的话

### limitPosition 计数器

`limitPosition` 是一个 Counter，其值用于限制重放到何处：

- 对于有界 replay，它来自有界重放请求
- 如果不是有界的，那么如果 Recording 仍在活动中（`active`），它就是 `rec-pos` counter
- 否则 Recording 已停止且为 null

### 回放会话管理特性

| 特性 | 说明 |
|------|------|
| **并发控制** | 支持多个回放会话同时进行，互不干扰 |
| **资源管理** | 自动清理完成或失败的回放会话资源 |
| **状态监控** | 实时跟踪回放进度和性能指标 |
| **错误恢复** | 支持回放会话的故障恢复和重启机制 |

---

## 附录：关键术语

| 术语 | 说明 |
|------|------|
| `Recording` | 一次完整的录制，对应一个 Publication 的数据，由唯一 `recordingId` 标识 |
| `RecordingSession` | 正在进行的录制会话，包含一个 `RecordingWriter` |
| `RecordingWriter` | 负责将数据写入 Segment 文件 |
| `ReplaySession` | 正在进行的回放会话 |
| `ControlSession` | 客户端与 Archive 之间的控制通道会话 |
| `Segment File` | 存储实际消息数据的文件，命名格式为 `{recordingId}-{segmentFileBasePosition}.rec` |
| `archive.catalog` | 元数据目录文件，记录所有录制的描述信息 |
| `archive-mark.dat` | 标记文件，记录 Archive 运行状态和错误日志 |
| `Spy Subscription` | 通过在 channel 前添加 `aeron-spy:` 创建，无需接收端即可订阅 Publication 的日志缓冲区 |
| `rec-pos` | Recording Position，录制当前写入位置计数器（存储在 `cnc.dat` 中） |
| `segmentFileBasePosition` | 段文件起始位置在 Publication 中的偏移量 |
| `ArchiveConductor` | Archive 的核心协调组件，负责处理控制请求和管理会话 |
| `Recorder` | 负责管理多个 `RecordingSession` 的组件 |
| `Replayer` | 负责管理多个 `ReplaySession` 的组件 |
