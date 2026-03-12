---
title: Agrona 零基础入门
date: 2026-03-10 11:15:21
tags:
  - 高性能
  - Agrona
categories:
  - 高性能组件
  - Agrona
---

> 基于 Agrona 1.21.1 | 涵盖核心概念、组件详解与 Cookbook 实战

# 第一部分：概述与定位

## 1. Agrona 简介

Agrona 是 Real Logic 公司开发的一个专注于**高性能、低延迟**的 Java 工具库，为构建高效并发系统提供基础组件。它被广泛用于 Simple Binary Encoding（SBE）、Aeron 消息传输系统及相关高性能项目中。

### 核心设计目标

Agrona 的设计从根本上回避了 Java 生态中常见的性能陷阱：

| 目标 | 实现方式 | 收益 |
|------|---------|------|
| **零垃圾回收** | 对象重用、直接内存、原始类型集合 | 消除 GC 停顿，延迟可预测 |
| **无锁并发** | CAS 操作替代 synchronized | 消除线程阻塞，线性扩展 |
| **直接内存访问** | `sun.misc.Unsafe` + off-heap | 零拷贝，降低内存带宽消耗 |
| **缓存友好布局** | CPU 缓存行对齐，避免伪共享 | 提升 L1/L2 缓存命中率 |
| **确定性执行模型** | Agent + Duty Cycle + IdleStrategy | 行为可预测，易于调试 |

### 适用场景

**推荐使用 Agrona 的场景：**
- 延迟要求 < 1ms（金融交易、实时报价等）
- 吞吐量 > 1M ops/s
- 不能容忍 GC 停顿
- 需要可预测的性能表现

**不适合的场景：**
- 延迟要求宽松（> 10ms 可接受）
- 低吞吐量业务系统
- 团队缺乏高性能编程经验

---

## 2. 技术栈位置

Agrona 是整个 Real Logic 高性能技术栈的**基础层**，所有上层组件都构建于其之上：

```
┌─────────────────────┐
│  Aeron Cluster      │  ← 分布式共识系统（Raft）
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│  Aeron Archive      │  ← 消息持久化
└──────────┬──────────┘
           │
┌──────────┴───────────────────────┐
│  Aeron Transport   │  SBE        │  ← 传输层 + 序列化
└─────────────────────────────────-┘
                   │
        ┌──────────▼──────────┐
        │       Agrona        │  ← 基础工具库（本文重点）
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐
        │    Java 虚拟机 JVM  │
        └─────────────────────┘
```

**各层职责：**
- **Agrona**：高性能数据结构、并发原语、内存管理、Agent 框架
- **SBE**：基于 Agrona DirectBuffer 的零拷贝序列化
- **Aeron Transport**：基于 Agrona 无锁队列的高性能 UDP/IPC 消息传输
- **Aeron Archive**：消息流持久化与回放
- **Aeron Cluster**：分布式一致性、状态机复制

---

## 3. 核心架构组件

Agrona 的核心组件分为六个层次：

```
┌────────────── Agrona 核心库 ──────────────────────────────┐
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  数据结构层  │  │  并发工具层  │  │  缓冲区管理层 │  │
│  ├──────────────┤  ├──────────────┤  ├───────────────┤  │
│  │Int2ObjectMap │  │ 无锁队列     │  │ DirectBuffer  │  │
│  │原始类型集合  │  │ ManyToOne    │  │ UnsafeBuffer  │  │
│  │高效数组队列  │  │ OneToOne     │  │ 堆内/堆外内存 │  │
│  │零GC设计      │  │ Broadcast    │  │ 零拷贝操作    │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Agent 框架  │  │  时钟系统层  │  │  ID生成器层   │  │
│  ├──────────────┤  ├──────────────┤  ├───────────────┤  │
│  │ Agent 接口   │  │ SystemClock  │  │ SnowflakeID   │  │
│  │ DutyCycle    │  │ CachedClock  │  │ 高性能生成    │  │
│  │ IdleStrategy │  │ 纳秒精度时间 │  │ 无锁算法      │  │
│  │ AgentRunner  │  │ 低开销时间源 │  │ 分布式唯一性  │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
└───────────────────────────────────────────────────────────┘
```

---

## 4. 快速开始

### Maven 依赖

```xml
<dependency>
    <groupId>org.agrona</groupId>
    <artifactId>agrona</artifactId>
    <version>1.21.1</version>
</dependency>
```

### 最小运行示例

```java
import org.agrona.concurrent.*;

public class QuickStart {
    public static void main(String[] args) throws Exception {
        // 1. 创建无锁队列
        OneToOneConcurrentArrayQueue<String> queue =
            new OneToOneConcurrentArrayQueue<>(1024);

        // 2. 定义 Agent
        Agent agent = new Agent() {
            @Override
            public int doWork() {
                String msg = queue.poll();
                if (msg != null) {
                    System.out.println("处理消息: " + msg);
                    return 1;
                }
                return 0;
            }

            @Override
            public String roleName() { return "demo-agent"; }
        };

        // 3. 启动 AgentRunner
        AgentRunner runner = new AgentRunner(
            new BackoffIdleStrategy(100, 10, 1, 1_000_000),
            Throwable::printStackTrace,
            null,
            agent
        );
        AgentRunner.startOnThread(runner);

        // 4. 发送消息
        queue.offer("Hello Agrona!");

        Thread.sleep(500);
        runner.close();
    }
}
```

---

# 第二部分：执行模型

## 5. Duty Cycle（职责周期）

### 5.1 什么是 Duty Cycle

Duty Cycle（职责周期）是 Agrona 执行模型的核心概念，本质上是一个**可重复执行的工作单元**。每次 Agent 被调度时，都会执行一次 Duty Cycle。

这个概念并不陌生——电脑游戏中的主循环（Game Loop / Event Loop）就是一种 Duty Cycle：

```java
// 游戏循环示例
EpochClock clock = new SystemEpochClock();
while (true) {
    long time = clock.time();
    processInput();   // 处理输入
    update();         // 更新游戏状态
    render();         // 渲染画面
    Thread.sleep(MS_PER_FRAME - (clock.time() - time));  // 控制帧率
}
```

其中的 `sleep` 控制了两件事：**功耗**（CPU 使用率）和**帧率**（执行频率）。在 Aeron/Agrona 中，这个"sleep"的等价物就是 **IdleStrategy（空闲策略）**。

### 5.2 两种典型的 Duty Cycle

#### 业务逻辑 Duty Cycle

由输入消息驱动，追求高吞吐量，IdleStrategy 几乎不引入延迟：

```java
// 典型的业务逻辑循环
while (true) {
    Command command = adaptInputBuffer();         // 从输入缓冲区读取命令
    routeToAppropriateBusinessLogic(command);     // 路由到业务逻辑
}

// 业务逻辑处理
public void doSomething(Command command) {
    processInput();   // 处理输入，更新状态
    emitEvents();     // 发出事件，通知下游
}
```

**执行流程：**
```
输入缓冲区 → adaptInputBuffer() → routeToBusinessLogic() → processInput() → emitEvents()
     ↑__________________________________________________|
                     （高频循环，几乎不等待）
```

#### 连接管理 Duty Cycle

不由消息驱动，负责维护连接状态。不需要高频执行，每次循环可以休眠数百毫秒：

```java
// 连接管理循环
while (true) {
    checkConnectionStatus();   // 检查连接状态
    reconnectIfNeeded();       // 如有必要则重连
    Thread.sleep(100);         // 休眠 100ms（使用 SleepingIdleStrategy）
}
```

### 5.3 Agent 接口与 doWork() 返回值

Duty Cycle 通过 `Agent.doWork()` 方法实现，**返回值语义至关重要**：

```java
public interface Agent {
    /**
     * 执行一次 Duty Cycle 的工作
     *
     * @return 完成的工作项数量：
     *         > 0 表示有工作完成，调度器会继续紧密循环
     *         = 0 表示无工作，调度器会调用 IdleStrategy
     */
    int doWork() throws Exception;

    String roleName();

    default void onStart() {}

    default void onClose() {}
}
```

**正确返回值的重要性：**

```java
// ❌ 错误：总是返回 1，导致 IdleStrategy 永远无法正确介入
@Override
public int doWork() {
    processMessage();
    return 1;  // 即使没有消息也返回 1
}

// ✅ 正确：准确反映实际工作量
@Override
public int doWork() {
    Message msg = queue.poll();
    if (msg != null) {
        processMessage(msg);
        return 1;
    }
    return 0;  // 无工作时返回 0，触发 IdleStrategy
}
```

### 5.4 批量处理模式

合理的批量处理可以大幅提升吞吐量：

```java
private static final int BATCH_SIZE = 100;

@Override
public int doWork() {
    int workDone = 0;

    // 批量处理，最多处理 BATCH_SIZE 条
    for (int i = 0; i < BATCH_SIZE; i++) {
        final Message msg = queue.poll();
        if (msg == null) break;  // 队列为空则提前退出

        processMessage(msg);
        workDone++;
    }

    return workDone;
}
```

**批量大小选择建议：**

| 场景 | 批量大小 | 理由 |
|------|---------|------|
| 超低延迟（< 10μs） | 1-10 | 避免单次循环占用过长时间 |
| 通用高性能 | 50-200 | 平衡延迟与吞吐量 |
| 高吞吐批处理 | 500-1000 | 摊销固定开销 |

### 5.5 常见陷阱

**陷阱一：工作量无上限**

```java
// ❌ 错误：while 无限处理可能导致其他 Agent 饥饿
@Override
public int doWork() {
    int work = 0;
    while (!queue.isEmpty()) {
        processMessage(queue.poll());
        work++;
    }
    return work;
}

// ✅ 正确：设置每次执行的上限
@Override
public int doWork() {
    int work = 0;
    for (int i = 0; i < 100 && !queue.isEmpty(); i++) {
        processMessage(queue.poll());
        work++;
    }
    return work;
}
```

**陷阱二：doWork() 内部阻塞**

```java
// ❌ 错误：Thread.sleep 违反非阻塞原则
@Override
public int doWork() {
    Thread.sleep(100);  // 严禁！
    return processMessages();
}
```

---

## 6. Agent 与 IdleStrategy

### 6.1 为什么需要 Agent 模型

2006 年，Edward A. Lee 在技术报告《The Problem with Threads》中指出：

> **线程作为计算模型具有极高的不确定性，程序员的工作就变成了修剪这种不确定性。我们应该从本质上确定性的、可组合的组件开始构建。**

Agrona 的 Agent 模型正是对这一理念的实践：每个 Agent 是**确定性、可组合、资源可管理**的工作单元，搭配 IdleStrategy 精确控制 CPU 消耗，使多线程行为变得可预测、易于推理。

### 6.2 Agent 实现示例

```java
import org.agrona.concurrent.Agent;
import org.agrona.concurrent.ManyToOneConcurrentArrayQueue;

public class MessageProcessorAgent implements Agent {
    private final ManyToOneConcurrentArrayQueue<String> inputQueue;
    private long processedCount = 0;

    public MessageProcessorAgent(ManyToOneConcurrentArrayQueue<String> inputQueue) {
        this.inputQueue = inputQueue;
    }

    @Override
    public int doWork() {
        int workDone = 0;

        for (int i = 0; i < 50; i++) {  // 批量最多处理 50 条
            final String message = inputQueue.poll();
            if (message == null) break;

            processMessage(message);
            workDone++;
            processedCount++;
        }

        return workDone;
    }

    @Override
    public String roleName() {
        return "message-processor";
    }

    @Override
    public void onStart() {
        System.out.println("[" + roleName() + "] 启动");
    }

    @Override
    public void onClose() {
        System.out.println("[" + roleName() + "] 关闭，共处理 " + processedCount + " 条");
    }

    private void processMessage(String message) {
        // 实际处理逻辑
    }
}
```

### 6.3 IdleStrategy 详解

IdleStrategy 决定了 Agent 在 `doWork()` 返回 0（无工作）时的行为，直接影响**延迟、CPU 使用率和功耗**的权衡。

#### 接口定义

```java
public interface IdleStrategy {
    void idle(int workCount);  // 根据工作量决定是否空闲
    void idle();               // 直接执行空闲逻辑
    void reset();              // 重置状态（有工作时调用）
}
```

#### 五种内置策略

**1. BusySpinIdleStrategy — 忙等待**

```java
// 实现原理：什么都不做，持续轮询
public final class BusySpinIdleStrategy implements IdleStrategy {
    @Override
    public void idle(int workCount) {
        // 空实现，永不让出 CPU
    }
}

// 使用方式
IdleStrategy strategy = new BusySpinIdleStrategy();
```

| 特性 | 值 |
|------|---|
| 响应延迟 | ~100ns（最低） |
| CPU 占用 | 100% |
| 适用场景 | 超低延迟交易系统、独占 CPU 核心 |

**2. BackoffIdleStrategy — 渐进式退避**

```java
// 三阶段退避：自旋 → Thread.yield() → LockSupport.parkNanos()
IdleStrategy strategy = new BackoffIdleStrategy(
    100,        // 最大自旋次数
    10,         // 最大让出次数
    1,          // 最小休眠时间（1ns）
    1_000_000   // 最大休眠时间（1ms）
);
```

退避状态机：
```
有工作 → 自旋阶段（最多100次）→ 让出阶段（最多10次）→ 休眠阶段（最长1ms）
  ↑_________有工作，reset()_____________________________________|
```

| 特性 | 值 |
|------|---|
| 响应延迟 | 1μs ~ 10ms（视退避深度） |
| CPU 占用 | 10% ~ 70%（自适应） |
| 适用场景 | 通用高性能应用，负载波动场景 |

**3. YieldingIdleStrategy — 让出策略**

```java
// 调用 Thread.yield() 让调度器决定
IdleStrategy strategy = new YieldingIdleStrategy();
```

| 特性 | 值 |
|------|---|
| 响应延迟 | ~1μs |
| CPU 占用 | 高（70-90%） |
| 适用场景 | 快速响应但非极致低延迟，CPU 核心充足 |

**4. SleepingIdleStrategy — 休眠策略**

```java
// 无工作时立即休眠指定时间
IdleStrategy strategy = new SleepingIdleStrategy(1_000_000);  // 1ms
```

| 特性 | 值 |
|------|---|
| 响应延迟 | 1ms+（最高） |
| CPU 占用 | 1-10%（最低） |
| 适用场景 | 后台批处理、连接管理、节能场景 |

**5. NoOpIdleStrategy — 无操作**

```java
// 与 BusySpinIdleStrategy 类似，主要用于测试
IdleStrategy strategy = NoOpIdleStrategy.INSTANCE;
```

#### 策略选型速查表

| 策略 | 延迟 | CPU 占用 | 推荐场景 |
|------|------|----------|---------|
| `BusySpinIdleStrategy` | ~100ns | 100% | 高频交易、专用核心 |
| `YieldingIdleStrategy` | ~1μs | 高 | 快速响应、多核系统 |
| `BackoffIdleStrategy` | 1μs-10ms | 自适应 | **通用推荐** |
| `SleepingIdleStrategy` | 1ms+ | 低 | 后台任务 |

### 6.4 AgentRunner — 运行框架

AgentRunner 将 Agent 和 IdleStrategy 结合，在线程中驱动整个执行循环：

```java
// 完整的 AgentRunner 使用示例
Agent agent = new MessageProcessorAgent(queue);

AgentRunner runner = new AgentRunner(
    new BackoffIdleStrategy(100, 10, 1, 1_000_000),  // 空闲策略
    throwable -> {                                    // 错误处理
        System.err.println("Agent 错误: " + throwable);
        throwable.printStackTrace();
    },
    null,   // 错误计数器（可选，AtomicCounter）
    agent   // Agent 实例
);

// 在新线程中启动
Thread thread = AgentRunner.startOnThread(runner);
thread.setName("message-processor-thread");

// ... 运行一段时间 ...

// 关闭
runner.close();
```

**AgentRunner 内部执行循环（简化）：**

```java
// AgentRunner.run() 的核心逻辑
while (isRunning) {
    try {
        int workCount = agent.doWork();
        idleStrategy.idle(workCount);  // 根据工作量决定是否空闲
    } catch (AgentTerminationException e) {
        isRunning = false;             // 正常终止
        handleError(e);
    } catch (Exception e) {
        handleError(e);                // 异常处理但继续运行
    }
}
agent.onClose();
```

### 6.5 高级技巧：监控 Agent 性能

通过装饰器模式为 Agent 添加监控能力，不侵入业务逻辑：

```java
public class MonitoredAgent implements Agent {
    private final Agent delegate;
    private long totalCycles = 0;
    private long busyCycles = 0;
    private long totalWork = 0;
    private long startTimeNs;

    public MonitoredAgent(Agent delegate) {
        this.delegate = delegate;
    }

    @Override
    public int doWork() throws Exception {
        totalCycles++;
        int work = delegate.doWork();
        if (work > 0) {
            busyCycles++;
            totalWork += work;
        }
        return work;
    }

    @Override
    public String roleName() {
        return delegate.roleName() + "-monitored";
    }

    @Override
    public void onStart() {
        startTimeNs = System.nanoTime();
        delegate.onStart();
    }

    @Override
    public void onClose() {
        delegate.onClose();
        long runTimeMs = (System.nanoTime() - startTimeNs) / 1_000_000;
        double utilization = totalCycles > 0 ? (double) busyCycles / totalCycles * 100 : 0;
        System.out.printf("=== %s 运行统计 ===%n", roleName());
        System.out.printf("运行时间: %d ms%n", runTimeMs);
        System.out.printf("总周期数: %d，忙碌率: %.1f%%%n", totalCycles, utilization);
        System.out.printf("总工作量: %d，平均每周期: %.2f%n",
            totalWork, (double) totalWork / totalCycles);
    }
}
```

---

## 7. 线程、Agent 与 Duty Cycle 的协作

### 7.1 三者的关系

```
Thread（线程）
  └── AgentRunner（运行框架）
        ├── IdleStrategy（空闲策略）
        └── Agent（工作单元）
              └── doWork()（= 一次 Duty Cycle）
```

- **Thread** 提供执行上下文
- **AgentRunner** 管理 Agent 生命周期，实现运行循环
- **Agent** 定义业务逻辑（Duty Cycle 的内容）
- **IdleStrategy** 控制 CPU 在空闲时的行为

### 7.2 专用线程模式 vs 共享线程模式

#### 专用线程（Dedicated Thread）

每个 Agent 独占一个线程，适合低延迟场景：

```java
Agent criticalAgent = new OrderMatchingAgent();

AgentRunner runner = new AgentRunner(
    new BusySpinIdleStrategy(),   // 最低延迟策略
    Throwable::printStackTrace,
    null,
    criticalAgent
);

Thread thread = AgentRunner.startOnThread(runner);
thread.setName("order-matching");
thread.setPriority(Thread.MAX_PRIORITY);
```

**优势：** 最低延迟，性能可预测  
**劣势：** 每个 Agent 消耗一个线程，资源开销大

#### 共享线程（CompositeAgent）

多个 Agent 在同一线程上顺序执行：

```java
// 将多个相关 Agent 组合到一个线程
Agent compositeAgent = new CompositeAgent(
    new ReceiverAgent(),
    new ProcessorAgent(),
    new SenderAgent()
);

AgentRunner runner = new AgentRunner(
    new BackoffIdleStrategy(100, 10, 1, 1_000_000),
    Throwable::printStackTrace,
    null,
    compositeAgent
);

AgentRunner.startOnThread(runner).setName("pipeline-thread");
```

**优势：** 节约线程，降低上下文切换  
**劣势：** Agent 串行执行，相互影响

### 7.3 完整的多 Agent 消息处理系统示例

```java
public class MessageProcessingSystem {
    private final ManyToOneConcurrentArrayQueue<Message> inputQueue;
    private final ManyToOneConcurrentArrayQueue<Message> outputQueue;

    // 三个独立线程，针对各自特性选择不同策略
    private final AgentRunner receiverRunner;
    private final AgentRunner processorRunner;
    private final AgentRunner senderRunner;

    public MessageProcessingSystem(int queueSize) {
        inputQueue = new ManyToOneConcurrentArrayQueue<>(queueSize);
        outputQueue = new ManyToOneConcurrentArrayQueue<>(queueSize);

        // 接收器：最低延迟，使用 BusySpin
        receiverRunner = new AgentRunner(
            new BusySpinIdleStrategy(),
            this::handleError, null,
            new ReceiverAgent(inputQueue)
        );

        // 处理器：均衡策略
        processorRunner = new AgentRunner(
            new BackoffIdleStrategy(100, 10, 1, 1_000_000),
            this::handleError, null,
            new ProcessorAgent(inputQueue, outputQueue)
        );

        // 发送器：可以让出 CPU
        senderRunner = new AgentRunner(
            new YieldingIdleStrategy(),
            this::handleError, null,
            new SenderAgent(outputQueue)
        );
    }

    public void start() {
        AgentRunner.startOnThread(receiverRunner).setName("receiver");
        AgentRunner.startOnThread(processorRunner).setName("processor");
        AgentRunner.startOnThread(senderRunner).setName("sender");
    }

    public void shutdown() {
        receiverRunner.close();
        processorRunner.close();
        senderRunner.close();
    }

    private void handleError(Throwable t) {
        System.err.println("系统错误: " + t.getMessage());
    }
}
```

### 7.4 最佳实践总结

1. **低延迟路径**：使用专用线程 + `BusySpinIdleStrategy`，并绑定 CPU 核心
2. **通用场景**：使用 `BackoffIdleStrategy`，合理设置退避参数
3. **非关键任务**：使用 `CompositeAgent` 共享线程，减少资源开销
4. **`doWork()` 必须非阻塞**：任何阻塞都会破坏整个系统的响应性
5. **批量处理**：设置合理的批量上限，避免长时间占用线程

---

# 第三部分：核心组件

## 8. DirectBuffer — 直接内存缓冲区

### 8.1 概述

DirectBuffer 是 Agrona 实现零拷贝、零 GC 的核心机制。它提供了对**堆内（on-heap）和堆外（off-heap）内存**的统一访问接口，支持类型安全的读写操作，同时完全避免中间对象的分配。

**传统方式 vs Agrona 方式：**

```
传统对象方式：                    Agrona DirectBuffer 方式：
创建 Message 对象 → GC 分配       分配一次 ByteBuffer → 永久重用
读取字段 → 解引用                 直接按偏移量读取 → 零拷贝
方法调用 → 可能装箱               原始类型 API → 无装箱
GC 回收 → 停顿                   无 GC → 零停顿
```

### 8.2 接口层次

```
DirectBuffer（只读接口）
  └── MutableDirectBuffer（读写接口）
        ├── UnsafeBuffer（主力实现，使用 Unsafe）
        └── ExpandableArrayBuffer（可自动扩容）
```

### 8.3 UnsafeBuffer 使用详解

UnsafeBuffer 是最常用的实现，底层使用 `sun.misc.Unsafe` 进行直接内存操作：

```java
import org.agrona.concurrent.UnsafeBuffer;
import java.nio.ByteBuffer;

// 三种创建方式
// 方式一：包装字节数组（堆内内存）
byte[] byteArray = new byte[1024];
UnsafeBuffer heapBuffer = new UnsafeBuffer(byteArray);

// 方式二：包装 DirectByteBuffer（堆外内存，推荐）
ByteBuffer directBB = ByteBuffer.allocateDirect(1024);
UnsafeBuffer directBuffer = new UnsafeBuffer(directBB);

// 方式三：对齐分配（高性能场景）
UnsafeBuffer alignedBuffer = new UnsafeBuffer(
    BufferUtil.allocateDirectAligned(1024, 64)  // 64字节（缓存行）对齐
);

// 写入各种类型
directBuffer.putByte(0, (byte) 0xFF);
directBuffer.putShort(1, (short) 1234);
directBuffer.putInt(3, 567890);
directBuffer.putLong(7, 123456789012345L);
directBuffer.putDouble(15, 3.14159);
directBuffer.putStringAscii(23, "Hello");  // 写入 ASCII 字符串

// 读取各种类型
byte  b = directBuffer.getByte(0);
short s = directBuffer.getShort(1);
int   i = directBuffer.getInt(3);
long  l = directBuffer.getLong(7);
double d = directBuffer.getDouble(15);
String str = directBuffer.getStringAscii(23);
```

### 8.4 零拷贝消息编解码示例

这是 DirectBuffer 在实际项目中最常见的用法——以固定内存布局直接表示协议消息：

```java
/**
 * 订单消息的零拷贝编解码器
 * 消息布局（共 28 字节）：
 *   offset 0  : orderId   (long,   8 bytes)
 *   offset 8  : price     (double, 8 bytes)
 *   offset 16 : quantity  (int,    4 bytes)
 *   offset 20 : flags     (int,    4 bytes)
 *   offset 24 : symbolLen (int,    4 bytes)
 *   offset 28 : symbol    (bytes,  可变长)
 */
public class OrderCodec {
    private static final int ORDER_ID_OFFSET   = 0;
    private static final int PRICE_OFFSET      = 8;
    private static final int QUANTITY_OFFSET   = 16;
    private static final int FLAGS_OFFSET      = 20;
    private static final int SYMBOL_LEN_OFFSET = 24;
    private static final int SYMBOL_OFFSET     = 28;
    private static final int FIXED_SIZE        = 28;

    // 编码
    public static int encode(
        MutableDirectBuffer buffer,
        int baseOffset,
        long orderId, double price, int quantity, String symbol)
    {
        buffer.putLong(baseOffset + ORDER_ID_OFFSET, orderId);
        buffer.putDouble(baseOffset + PRICE_OFFSET, price);
        buffer.putInt(baseOffset + QUANTITY_OFFSET, quantity);
        buffer.putInt(baseOffset + FLAGS_OFFSET, 0);

        byte[] symbolBytes = symbol.getBytes(StandardCharsets.US_ASCII);
        buffer.putInt(baseOffset + SYMBOL_LEN_OFFSET, symbolBytes.length);
        buffer.putBytes(baseOffset + SYMBOL_OFFSET, symbolBytes);

        return FIXED_SIZE + symbolBytes.length;
    }

    // 解码（使用 OrderData 持有者避免创建对象）
    public static void decode(
        DirectBuffer buffer,
        int baseOffset,
        OrderData out)  // 复用持有者对象，零 GC
    {
        out.orderId   = buffer.getLong(baseOffset + ORDER_ID_OFFSET);
        out.price     = buffer.getDouble(baseOffset + PRICE_OFFSET);
        out.quantity  = buffer.getInt(baseOffset + QUANTITY_OFFSET);

        int symbolLen = buffer.getInt(baseOffset + SYMBOL_LEN_OFFSET);
        out.symbol    = buffer.getStringAscii(baseOffset + SYMBOL_OFFSET, symbolLen);
    }

    // 可重用的数据持有者（避免 GC）
    public static class OrderData {
        public long orderId;
        public double price;
        public int quantity;
        public String symbol;
    }
}
```

### 8.5 ExpandableArrayBuffer — 可扩容缓冲区

当消息大小不确定时，使用 `ExpandableArrayBuffer`：

```java
import org.agrona.ExpandableArrayBuffer;

// 初始容量 256，会自动按需扩容
ExpandableArrayBuffer buffer = new ExpandableArrayBuffer(256);

// 写入超过初始容量的数据，自动扩容
for (int i = 0; i < 10000; i++) {
    buffer.putInt(i * 4, i);
}

System.out.println("自动扩容后容量: " + buffer.capacity());  // 40000
```

### 8.6 性能优化技巧

**技巧一：缓存行对齐，避免伪共享**

```java
// 64 字节缓存行对齐分配
ByteBuffer aligned = BufferUtil.allocateDirectAligned(1024, 64);
UnsafeBuffer buffer = new UnsafeBuffer(aligned);
```

**技巧二：批量操作优于逐个操作**

```java
// ❌ 低效：逐字节操作
for (int i = 0; i < length; i++) {
    buffer.putByte(offset + i, sourceArray[i]);
}

// ✅ 高效：批量复制
buffer.putBytes(offset, sourceArray, 0, length);
```

**技巧三：明确字节序**

```java
// 跨平台通信时显式指定字节序
buffer.putInt(0, value, ByteOrder.BIG_ENDIAN);   // 网络字节序
buffer.putInt(0, value, ByteOrder.LITTLE_ENDIAN); // x86 本机字节序

// 单机内部通信使用默认（本机字节序），性能最优
buffer.putInt(0, value);
```

### 8.7 常见陷阱

1. **内存泄漏**：堆外内存需要手动释放
   ```java
   // 使用 Agrona 的工具类释放
   IoUtil.unmap((MappedByteBuffer) byteBuffer);
   ```

2. **并发安全**：`DirectBuffer` 不是线程安全的，需要外部同步或每线程独立实例

3. **字节序混用**：同一个系统内保持一致的字节序约定

---

## 9. 并发集合与队列

### 9.1 概述

Agrona 提供的并发集合是**无锁设计**的，使用 CAS（Compare-And-Swap）操作替代传统锁，实现高吞吐量的线程间通信。

**与 JDK 标准库对比：**

| 队列类型 | 吞吐量 | 延迟 | GC 压力 |
|---------|-------|------|---------|
| Agrona `OneToOneConcurrentArrayQueue` | 200M ops/s | <100ns | 零 |
| Agrona `ManyToOneConcurrentArrayQueue` | 150M ops/s | <200ns | 零 |
| JDK `ConcurrentLinkedQueue` | 50M ops/s | ~500ns | 高 |
| JDK `ArrayBlockingQueue` | 30M ops/s | ~1μs | 中 |

### 9.2 三种并发队列

#### OneToOneConcurrentArrayQueue — 单生产者单消费者

```java
import org.agrona.concurrent.OneToOneConcurrentArrayQueue;

// 单生产者、单消费者场景，性能最优
OneToOneConcurrentArrayQueue<Order> queue =
    new OneToOneConcurrentArrayQueue<>(1024);  // 容量必须为 2 的幂

// 生产者线程（只能有一个）
boolean offered = queue.offer(new Order(...));
if (!offered) {
    // 队列满，需要背压处理
}

// 消费者线程（只能有一个）
Order order = queue.poll();
if (order != null) {
    processOrder(order);
}

// 批量消费（更高效）
int consumed = queue.drain(order -> processOrder(order), 100);
```

#### ManyToOneConcurrentArrayQueue — 多生产者单消费者

```java
import org.agrona.concurrent.ManyToOneConcurrentArrayQueue;

// 多个生产者、单消费者，这是最常见的场景
ManyToOneConcurrentArrayQueue<Message> queue =
    new ManyToOneConcurrentArrayQueue<>(4096);

// 任意多个生产者线程都可以安全 offer
// 生产者 1
queue.offer(new Message("from-thread-1"));

// 生产者 2（并发安全）
queue.offer(new Message("from-thread-2"));

// 消费者（只能有一个线程 poll）
Message msg = queue.poll();
```

#### ManyToManyConcurrentArrayQueue — 多生产者多消费者

```java
import org.agrona.concurrent.ManyToManyConcurrentArrayQueue;

// 多生产者多消费者，最灵活但性能略低
ManyToManyConcurrentArrayQueue<Event> queue =
    new ManyToManyConcurrentArrayQueue<>(2048);
```

### 9.3 如何选择队列类型

```
需要使用并发队列？
│
├─ 几个线程写？
│    ├─ 1个 → 几个线程读？
│    │         ├─ 1个 → OneToOneConcurrentArrayQueue（最快）
│    │         └─ 多个 → ManyToManyConcurrentArrayQueue
│    └─ 多个 → 几个线程读？
│              ├─ 1个 → ManyToOneConcurrentArrayQueue（推荐）
│              └─ 多个 → ManyToManyConcurrentArrayQueue
```

### 9.4 广播通信：BroadcastTransmitter & BroadcastReceiver

广播机制实现"一写多读"，每个接收者独立追踪读取位置：

```java
import org.agrona.concurrent.broadcast.*;

// 分配广播缓冲区
int capacity = 1024;  // 必须为 2 的幂
MutableDirectBuffer broadcastBuffer = new UnsafeBuffer(
    ByteBuffer.allocateDirect(
        BroadcastBufferDescriptor.TRAILER_LENGTH + capacity
    )
);

// 发送端（只能有一个）
BroadcastTransmitter transmitter = new BroadcastTransmitter(broadcastBuffer);

// 发送消息
transmitter.transmit(
    MSG_TYPE_ORDER,     // 消息类型 ID
    srcBuffer,          // 源缓冲区
    srcOffset,          // 源偏移量
    length              // 消息长度
);

// 接收端（可以有任意多个，各自独立）
BroadcastReceiver receiver1 = new BroadcastReceiver(broadcastBuffer);
BroadcastReceiver receiver2 = new BroadcastReceiver(broadcastBuffer);

// 接收消息
MessageHandler handler = (msgTypeId, buffer, index, length) -> {
    System.out.println("收到类型 " + msgTypeId + " 的消息");
};

int received = receiver1.receive(handler);
```

**广播缓冲区工作原理：**
```
单写者                  环形缓冲区
                ┌───┬───┬───┬───┬───┬───┬───┬───┐
Transmitter --> │ M1│ M2│ M3│ M4│   │   │ M7│ M8│
                └───┴───┴───┴───┴───┴───┴───┴───┘
                                        ↑       ↑
                                   Recv1.pos  Recv2.pos（各自独立）
```

### 9.5 RingBuffer — 高性能环形缓冲区

`ManyToOneRingBuffer` 在 Agrona 内部广泛使用（例如 Aeron Media Driver 与客户端的通信）：

```java
import org.agrona.concurrent.ringbuffer.*;

// 创建环形缓冲区（容量 + 尾部元数据）
int capacity = 1024;
MutableDirectBuffer ringMem = new UnsafeBuffer(
    ByteBuffer.allocateDirect(capacity + RingBufferDescriptor.TRAILER_LENGTH)
);
RingBuffer ringBuffer = new ManyToOneRingBuffer(ringMem);

// 写入（支持多个写入线程）
boolean written = ringBuffer.write(MSG_TYPE, srcBuffer, srcOffset, length);

// 读取（单消费者）
int messagesRead = ringBuffer.read(
    (msgTypeId, buffer, index, length) -> {
        // 处理消息（在消费者线程中执行）
    },
    10  // 每次最多处理 10 条
);
```

### 9.6 最佳实践

1. **预分配足够容量**：避免满载，一般设置为预期峰值吞吐量的 2-4 倍
2. **使用批量操作**：`drain()` 比循环 `poll()` 效率更高
3. **不要在队列满时阻塞**：实现背压机制（通知生产者减速或丢弃）
4. **容量必须是 2 的幂次**：Agrona 队列要求此约束以使用位运算取模

---

## 10. 高性能数据结构

### 10.1 为什么需要专用数据结构

JDK 标准库的 `HashMap<Integer, V>` 有一个隐藏的性能问题：**装箱（Boxing）**。

```
// JDK HashMap<Integer, Order>：
map.get(orderId)
  → orderId 被装箱为 Integer 对象（堆分配 + GC 压力）
  → 通过 hashCode() 定位 bucket
  → equals() 比较（拆箱）

// Agrona Int2ObjectHashMap<Order>：
map.get(orderId)
  → 直接用 int 哈希定位 bucket
  → int 比较（无对象，无装箱）
```

### 10.2 核心数据结构

#### Int2ObjectHashMap — 整数键映射

```java
import org.agrona.collections.Int2ObjectHashMap;

// 创建（初始容量 1000，负载因子 0.65，默认避免额外分配）
Int2ObjectHashMap<Order> orderMap = new Int2ObjectHashMap<>(1000, 0.65f);

// 基本操作
orderMap.put(12345, new Order(12345, "AAPL", 100, 150.0));
Order order = orderMap.get(12345);
boolean exists = orderMap.containsKey(12345);
orderMap.remove(12345);

// 高效的 forEach（无迭代器对象创建）
orderMap.forEach((orderId, o) ->
    System.out.printf("Order %d: %s%n", orderId, o));

// 预计算容量，避免 rehash
// 如果预计存放 N 个元素，初始容量设为 (int)(N / loadFactor) + 1
int expectedSize = 10000;
float loadFactor = 0.65f;
Int2ObjectHashMap<Order> preAllocated =
    new Int2ObjectHashMap<>((int)(expectedSize / loadFactor) + 1, loadFactor);
```

#### Long2ObjectHashMap — 长整数键映射

```java
import org.agrona.collections.Long2ObjectHashMap;

Long2ObjectHashMap<Session> sessions = new Long2ObjectHashMap<>(512, 0.7f);
sessions.put(sessionId, session);
Session s = sessions.get(sessionId);
```

#### IntHashSet / LongHashSet — 原始类型集合

```java
import org.agrona.collections.IntHashSet;

IntHashSet activeConnections = new IntHashSet(256);
activeConnections.add(connectionId);
boolean isActive = activeConnections.contains(connectionId);
activeConnections.remove(connectionId);

// 遍历（无装箱）
activeConnections.forEach(id -> System.out.println("Active: " + id));
```

#### Object2ObjectHashMap — 自定义对象映射

```java
import org.agrona.collections.Object2ObjectHashMap;

// 相比 JDK HashMap，内存布局更紧凑
Object2ObjectHashMap<String, Account> accounts =
    new Object2ObjectHashMap<>(512, 0.6f);
```

### 10.3 调试模式：让调试器可见 Map 内容

Agrona Map 默认会缓存迭代器对象（`shouldAvoidAllocation = true`），这会导致调试器无法正常显示 Map 内容：

```java
// ✅ 生产环境（高性能，调试器看不到内容）
Int2ObjectHashMap<String> prodMap = new Int2ObjectHashMap<>(100, 0.65f);
// 等价于：new Int2ObjectHashMap<>(100, 0.65f, true)

// ✅ 调试环境（调试器可见，有轻微 GC 压力）
Int2ObjectHashMap<String> debugMap = new Int2ObjectHashMap<>(100, 0.65f, false);
// 调试器现在可以正常展开显示 Map 内容

// 通用的工厂方法：根据系统属性切换
private static final boolean DEBUG_MODE = Boolean.getBoolean("app.debug");
Int2ObjectHashMap<String> map = new Int2ObjectHashMap<>(100, 0.65f, !DEBUG_MODE);
```

### 10.4 性能最佳实践

1. **选择合适的 Key 类型**：能用 `int` 就不用 `Integer`，能用 `long` 就不用 `Long`
2. **预分配容量**：提前估算元素数量，`initialCapacity = (int)(expectedSize / loadFactor) + 1`
3. **使用 `forEach` 而非迭代器**：`forEach` 避免创建迭代器对象
4. **避免频繁 rehash**：负载因子 0.55-0.65 是性能与空间的良好平衡点
5. **考虑是否需要 Map**：如果主要操作是遍历，`ArrayList` 可能更快

---

## 11. 时钟与时间源

### 11.1 为什么时钟很重要

在高性能系统中，时间的获取方式直接影响性能：
- `System.currentTimeMillis()` 每次调用约需要 30-100ns（系统调用）
- 在每秒处理百万次消息的系统中，频繁调用时钟会消耗可观的 CPU

Agrona 提供了**缓存时钟**，让你每次 Duty Cycle 只调用一次系统时钟，然后在循环内多次复用。

### 11.2 时钟接口

```java
// 毫秒精度时钟（用于业务时间戳、超时控制）
public interface EpochClock {
    long time();  // 返回自 Unix 纪元以来的毫秒数
}

// 纳秒精度时钟（用于性能测量）
public interface NanoClock {
    long nanoTime();  // 返回相对时间（纳秒），不保证与挂钟时间对应
}
```

### 11.3 内置实现

```java
// SystemEpochClock：直接调用 System.currentTimeMillis()
EpochClock clock = SystemEpochClock.INSTANCE;
long millis = clock.time();

// SystemNanoClock：直接调用 System.nanoTime()
NanoClock nanoClock = SystemNanoClock.INSTANCE;
long nanos = nanoClock.nanoTime();

// CachedEpochClock：缓存值，减少系统调用
CachedEpochClock cachedClock = new CachedEpochClock();
// 每个 Duty Cycle 更新一次
cachedClock.update(System.currentTimeMillis());
// 循环内多次使用缓存值（零系统调用）
long cachedTime = cachedClock.time();

// CachedNanoClock：纳秒精度的缓存时钟
CachedNanoClock cachedNano = new CachedNanoClock();
cachedNano.update(System.nanoTime());
long cachedNanos = cachedNano.nanoTime();
```

### 11.4 典型使用模式

#### 性能测量

```java
NanoClock clock = SystemNanoClock.INSTANCE;

long start = clock.nanoTime();
performCriticalOperation();
long elapsed = clock.nanoTime() - start;

System.out.printf("耗时: %d ns (%.3f μs)%n", elapsed, elapsed / 1000.0);
```

#### 超时控制

```java
EpochClock clock = SystemEpochClock.INSTANCE;
long timeoutMs = 5000;
long deadline = clock.time() + timeoutMs;

while (clock.time() < deadline) {
    if (tryConnect()) {
        return true;  // 成功
    }
    Thread.sleep(100);
}
return false;  // 超时
```

#### Agent 中的缓存时钟优化

```java
public class TimeAwareAgent implements Agent {
    private final CachedEpochClock clock = new CachedEpochClock();

    @Override
    public int doWork() {
        // 每次 Duty Cycle 只调用一次系统时钟
        clock.update(System.currentTimeMillis());

        // 本次 Duty Cycle 内多次使用同一个时间值（零系统调用）
        int work = 0;
        work += processMessagesWithTimeout(clock.time());
        work += checkHeartbeats(clock.time());
        work += updateMetrics(clock.time());
        work += logWithTimestamp(clock.time());

        return work;
    }

    @Override
    public String roleName() {
        return "time-aware-agent";
    }

    private int processMessagesWithTimeout(long now) { return 0; /* ... */ }
    private int checkHeartbeats(long now) { return 0; /* ... */ }
    private int updateMetrics(long now) { return 0; /* ... */ }
    private int logWithTimestamp(long now) { return 0; /* ... */ }
}
```

### 11.5 时钟选型指南

| 时钟 | 精度 | 开销 | 推荐用途 |
|------|------|------|---------|
| `SystemEpochClock` | 毫秒 | 中（系统调用） | 低频业务时间戳 |
| `SystemNanoClock` | 纳秒 | 中（系统调用） | 精确性能测量 |
| `CachedEpochClock` | 毫秒 | 极低（读缓存） | **高频 Agent 内时间戳** |
| `CachedNanoClock` | 纳秒 | 极低（读缓存） | 高频性能统计 |

---

## 12. ID 生成器

### 12.1 SnowflakeIdGenerator

Agrona 实现了 Twitter Snowflake 算法的 ID 生成器，适合在**分布式系统中生成全局唯一、趋势递增**的 64 位 ID。

#### ID 结构

```
|  1位  |       41位        |    10位    |    12位    |
|符号位 |  时间戳（毫秒）   |   节点 ID  |   序列号   |
|  0   | timestamp-epoch   |  nodeId    |  sequence  |
```

- **时间戳**：相对于自定义 epoch 的毫秒数，支持约 69 年
- **节点 ID**：标识不同机器/进程（0-1023，支持 1024 个节点）
- **序列号**：同一毫秒内的序号（0-4095，每毫秒最多 4096 个 ID）

#### 使用示例

```java
import org.agrona.concurrent.SnowflakeIdGenerator;

// 选择一个固定的 epoch（建议设为系统上线日期）
long EPOCH = 1672531200000L; // 2023-01-01 00:00:00 UTC

// nodeId 在分布式部署时每个节点必须唯一（0-1023）
int nodeId = Integer.parseInt(System.getenv("NODE_ID"));

SnowflakeIdGenerator generator = new SnowflakeIdGenerator(nodeId, EPOCH);

// 生成唯一 ID（线程安全）
long id = generator.nextId();
System.out.println("Generated ID: " + id);

// 从 ID 中提取信息（用于调试/追踪）
long timestamp = ((id >> 22) & 0x1FFFFFFFFFL) + EPOCH;
int extractedNodeId = (int)((id >> 12) & 0x3FFL);
int sequence = (int)(id & 0xFFFL);

System.out.printf("时间戳: %d, 节点: %d, 序列: %d%n",
    timestamp, extractedNodeId, sequence);
```

#### 封装为订单 ID 生成器

```java
public class OrderIdGenerator {
    private static final long SYSTEM_EPOCH = 1672531200000L;
    private final SnowflakeIdGenerator generator;

    public OrderIdGenerator(int nodeId) {
        this.generator = new SnowflakeIdGenerator(nodeId, SYSTEM_EPOCH);
    }

    public long nextOrderId() {
        return generator.nextId();
    }

    // 从 ID 中提取创建时间（用于调试）
    public long extractCreationTime(long orderId) {
        return ((orderId >> 22) & 0x1FFFFFFFFFL) + SYSTEM_EPOCH;
    }
}
```

### 12.2 Snowflake ID 的特性

| 特性 | 说明 |
|------|------|
| **趋势递增** | 同一节点生成的 ID 天然有序，适合数据库索引 |
| **包含时间** | 可从 ID 直接提取生成时间，无需额外字段 |
| **分布式唯一** | 不同节点（不同 nodeId）生成的 ID 不重叠 |
| **高性能** | 纯内存操作，每秒可生成超过 400 万个 ID |
| **无需协调** | 不依赖中心节点或数据库 |

### 12.3 注意事项

1. **时钟回拨**：如果系统时钟向后调整，可能产生重复 ID，需要检测并处理
2. **nodeId 唯一性**：部署时必须确保每个实例的 nodeId 不重复
3. **epoch 选择**：建议选择晚于系统投产日期，以最大化时间戳的有效范围
4. **序列号溢出**：同一毫秒内超过 4096 个 ID 请求会等待到下一毫秒

---

# 第四部分：Cookbook 实战

本部分汇集了 Agrona 常见问题的解决方案和完整代码示例。每个 Recipe 都包含**问题描述 → 解决方案 → 完整示例 → 深入说明**的结构。

---

## 13. 预分配 Map 与调试技巧

### 问题

在开发阶段使用调试器查看 `Int2ObjectHashMap` 内容时，发现无法展开查看元素。

### 原因

Agrona Map 默认会缓存迭代器和 Entry 对象（`shouldAvoidAllocation = true`）以避免对象分配，这是生产环境下的正确行为。但这会导致调试器无法正确展示内容。

```
生产模式（shouldAvoidAllocation = true）：
  迭代器 → 缓存重用 → 高性能，零 GC
  调试器 → 看到缓存对象 → 内容不可见

调试模式（shouldAvoidAllocation = false）：
  迭代器 → 每次新建 → 轻微 GC 压力
  调试器 → 看到新建对象 → 内容可见
```

### 解决方案

```java
// 调试环境（可以在调试器中查看内容）
Int2ObjectHashMap<String> debugMap = new Int2ObjectHashMap<>(100, 0.55f, false);

debugMap.put(1, "Apple");
debugMap.put(2, "Banana");
// 现在调试器可以正常展示: {1=Apple, 2=Banana}
```

### 工厂方法：根据环境自动切换

```java
public class MapFactory {
    // 通过 JVM 参数控制：-Dapp.debug.maps=true
    private static final boolean DEBUG_MAPS = Boolean.getBoolean("app.debug.maps");

    public static <V> Int2ObjectHashMap<V> createInt2ObjectMap(
            int initialCapacity, float loadFactor) {
        // 调试模式：允许分配（!DEBUG_MAPS = false）
        // 生产模式：避免分配（!DEBUG_MAPS = true）
        return new Int2ObjectHashMap<>(initialCapacity, loadFactor, !DEBUG_MAPS);
    }
}

// 使用：
// 生产启动: java -jar app.jar
// 调试启动: java -Dapp.debug.maps=true -jar app.jar
Int2ObjectHashMap<Order> orders = MapFactory.createInt2ObjectMap(1000, 0.65f);
```

### 容量预分配最佳实践

```java
// 根据预期元素数量计算合理的初始容量，避免 rehash
int expectedElements = 10_000;
float loadFactor = 0.65f;
int initialCapacity = (int)(expectedElements / loadFactor) + 1;  // ~15385

Int2ObjectHashMap<Order> orders = new Int2ObjectHashMap<>(initialCapacity, loadFactor);

// ❌ 错误：初始容量设得太小，会触发多次 rehash（昂贵操作）
Int2ObjectHashMap<Order> badMap = new Int2ObjectHashMap<>(16, 0.65f);
// 插入 10000 个元素会触发约 10 次 rehash
```

---

## 14. 关闭 Unsafe 边界检查

### 问题

系统对性能要求极高，希望榨取 `UnsafeBuffer` 的极致性能。

### 解决方案

通过 JVM 参数禁用 Agrona 的边界检查：

```bash
java -Dagrona.disable.bounds.checks=true -jar your-application.jar
```

或在代码中设置（必须在创建任何 `UnsafeBuffer` 之前）：

```java
System.setProperty("agrona.disable.bounds.checks", "true");
```

### 边界检查机制对比

```
启用检查（默认）：
  buffer.putInt(offset, value)
    → 检查 offset >= 0
    → 检查 offset + 4 <= capacity
    → 通过 → UNSAFE.putInt()

禁用检查：
  buffer.putInt(offset, value)
    → UNSAFE.putInt()（直接执行）
```

### 性能提升数据

| 操作 | 检查开启 | 检查关闭 | 提升 |
|------|---------|---------|------|
| `putInt` | 500M ops/s | 550M ops/s | +10% |
| `getLong` | 480M ops/s | 535M ops/s | +11% |
| `putBytes`（小块） | 200M ops/s | 215M ops/s | +7.5% |

### 风险评估与决策树

```
是否应该禁用边界检查？
│
├─ 性能瓶颈确认在 UnsafeBuffer 操作？
│    否 → ❌ 不要禁用（先优化算法）
│    是 ↓
├─ 代码已经过充分测试（包括边界条件）？
│    否 → ❌ 不要禁用（先完善测试）
│    是 ↓
├─ 系统可以容忍偶尔的 JVM 崩溃？
│    否 → ❌ 不要禁用
│    是 ↓
└─ 已穷尽其他优化手段？
     否 → ❌ 先尝试其他优化
     是 → ✅ 可以考虑禁用
```

### 安全使用实践

即使禁用了 Agrona 检查，也可以在应用层添加验证：

```java
public class SafeBufferAccess {
    private final UnsafeBuffer buffer;
    private final int capacity;

    public SafeBufferAccess(int size) {
        this.buffer = new UnsafeBuffer(ByteBuffer.allocateDirect(size));
        this.capacity = size;
    }

    // 在逻辑层校验，而不依赖 Agrona 的运行时检查
    public void writeOrder(int offset, long orderId, double price) {
        assert offset >= 0 && offset + 16 <= capacity
            : "Buffer overflow at offset " + offset;

        buffer.putLong(offset, orderId);
        buffer.putDouble(offset + 8, price);
    }
}
```

### 优先级更高的优化方式

在考虑禁用边界检查之前，优先尝试这些收益更高、风险更低的优化：

1. **算法优化**：减少不必要的操作（收益高，风险零）
2. **批量处理**：合并多次小操作（收益中高，风险低）
3. **对象池 + 缓冲区重用**：避免堆分配（收益中，风险低）
4. **禁用边界检查**：最后手段（收益低，风险高）

---

## 15. 简单二进制编解码器

### 问题

需要在系统内部（IPC 或 Aeron 消息）传输数据，希望高效地编解码，但不需要 SBE 的全套功能。

### 核心思路

使用 `MutableDirectBuffer`，为消息的每个字段定义固定偏移量，顺序读写：

```java
// 写入
mutableBuffer.putShort(offset, valueShort);
mutableBuffer.putInt(offset + Short.BYTES, valueInt);

// 读取
short shortVal = mutableBuffer.getShort(offset);
int   intVal   = mutableBuffer.getInt(offset + Short.BYTES);
```

### 完整的流式编解码器实现

```java
import org.agrona.MutableDirectBuffer;
import org.agrona.concurrent.UnsafeBuffer;
import java.nio.ByteBuffer;

/**
 * 流式二进制编解码器
 * 支持链式调用，自动追踪偏移量
 */
public class BinaryCodec {

    public static class Encoder {
        private final MutableDirectBuffer buffer;
        private int cursor;

        public Encoder(MutableDirectBuffer buffer, int startOffset) {
            this.buffer = buffer;
            this.cursor = startOffset;
        }

        public Encoder putByte(byte value) {
            buffer.putByte(cursor, value);
            cursor += Byte.BYTES;
            return this;
        }

        public Encoder putShort(short value) {
            buffer.putShort(cursor, value);
            cursor += Short.BYTES;
            return this;
        }

        public Encoder putInt(int value) {
            buffer.putInt(cursor, value);
            cursor += Integer.BYTES;
            return this;
        }

        public Encoder putLong(long value) {
            buffer.putLong(cursor, value);
            cursor += Long.BYTES;
            return this;
        }

        public Encoder putDouble(double value) {
            buffer.putDouble(cursor, value);
            cursor += Double.BYTES;
            return this;
        }

        // 写入变长字符串（4字节长度前缀 + 内容）
        public Encoder putString(String value) {
            byte[] bytes = value.getBytes(StandardCharsets.US_ASCII);
            buffer.putInt(cursor, bytes.length);
            cursor += Integer.BYTES;
            buffer.putBytes(cursor, bytes);
            cursor += bytes.length;
            return this;
        }

        public int encodedLength() { return cursor; }
        public int cursor() { return cursor; }
    }

    public static class Decoder {
        private final MutableDirectBuffer buffer;
        private int cursor;

        public Decoder(MutableDirectBuffer buffer, int startOffset) {
            this.buffer = buffer;
            this.cursor = startOffset;
        }

        public byte getByte() {
            byte v = buffer.getByte(cursor);
            cursor += Byte.BYTES;
            return v;
        }

        public short getShort() {
            short v = buffer.getShort(cursor);
            cursor += Short.BYTES;
            return v;
        }

        public int getInt() {
            int v = buffer.getInt(cursor);
            cursor += Integer.BYTES;
            return v;
        }

        public long getLong() {
            long v = buffer.getLong(cursor);
            cursor += Long.BYTES;
            return v;
        }

        public double getDouble() {
            double v = buffer.getDouble(cursor);
            cursor += Double.BYTES;
            return v;
        }

        public String getString() {
            int len = buffer.getInt(cursor);
            cursor += Integer.BYTES;
            String v = buffer.getStringAscii(cursor, len);
            cursor += len;
            return v;
        }

        public int cursor() { return cursor; }
    }
}
```

### 实际应用：订单消息协议

```java
/**
 * 订单消息格式（固定偏移量，推荐）：
 *   0  : msgType   (short,  2B)
 *   2  : orderId   (long,   8B)
 *   10 : price     (double, 8B)
 *   18 : quantity  (int,    4B)
 *   22 : symbolLen (int,    4B)
 *   26 : symbol    (bytes,  可变)
 */
public class OrderMessageCodec {
    // 常量定义偏移量，避免魔法数字
    private static final int MSG_TYPE_OFFSET    = 0;
    private static final int ORDER_ID_OFFSET    = 2;
    private static final int PRICE_OFFSET       = 10;
    private static final int QUANTITY_OFFSET    = 18;
    private static final int SYMBOL_LEN_OFFSET  = 22;
    private static final int SYMBOL_OFFSET      = 26;

    private static final short MSG_TYPE_NEW_ORDER = 1;

    // 编码
    public static int encode(MutableDirectBuffer buffer, int offset,
                             long orderId, double price, int quantity, String symbol) {
        buffer.putShort(offset + MSG_TYPE_OFFSET, MSG_TYPE_NEW_ORDER);
        buffer.putLong(offset + ORDER_ID_OFFSET, orderId);
        buffer.putDouble(offset + PRICE_OFFSET, price);
        buffer.putInt(offset + QUANTITY_OFFSET, quantity);

        byte[] symbolBytes = symbol.getBytes(StandardCharsets.US_ASCII);
        buffer.putInt(offset + SYMBOL_LEN_OFFSET, symbolBytes.length);
        buffer.putBytes(offset + SYMBOL_OFFSET, symbolBytes);

        return SYMBOL_OFFSET + symbolBytes.length;  // 返回消息总长度
    }

    // 解码
    public static void decode(MutableDirectBuffer buffer, int offset, OrderData out) {
        // msgType 可用于路由
        out.msgType  = buffer.getShort(offset + MSG_TYPE_OFFSET);
        out.orderId  = buffer.getLong(offset + ORDER_ID_OFFSET);
        out.price    = buffer.getDouble(offset + PRICE_OFFSET);
        out.quantity = buffer.getInt(offset + QUANTITY_OFFSET);

        int symbolLen = buffer.getInt(offset + SYMBOL_LEN_OFFSET);
        out.symbol = buffer.getStringAscii(offset + SYMBOL_OFFSET, symbolLen);
    }

    public static class OrderData {
        public short msgType;
        public long orderId;
        public double price;
        public int quantity;
        public String symbol;
    }
}
```

### Agrona 二进制 vs SBE vs JSON

| 对比项 | Agrona 二进制 | SBE | JSON |
|--------|--------------|-----|------|
| 编码速度 | 50M ops/s | 60M ops/s | 500K ops/s |
| 解码速度 | 45M ops/s | 55M ops/s | 400K ops/s |
| 消息大小 | ~28B | ~26B | ~95B |
| 实现复杂度 | 低（手写） | 中（代码生成） | 极低 |
| 版本控制 | 手动 | 内置 | 通过 schema |
| 复杂结构支持 | 有限 | 完整 | 完整 |

**使用建议：**
- 简单消息（< 5 个字段），内部系统通信 → **Agrona 二进制**
- 复杂消息，需要版本控制 → **SBE**
- 对外 API，需要人类可读 → **JSON**

### 字节序与跨平台通信

```java
// 同一 JVM 内部：使用默认本机字节序（最快）
buffer.putInt(0, value);

// 跨网络协议（如实现 FIX/ITCH 等标准协议）：使用 Big Endian
buffer.putInt(0, value, ByteOrder.BIG_ENDIAN);

// 与 C/C++ 程序交互：通常需要 Little Endian
buffer.putInt(0, value, ByteOrder.LITTLE_ENDIAN);
```

---

## 16. 组合 Agent（CompositeAgent）

### 问题

已将系统构建为多个 Agent，但希望其中几个 Agent 在同一个线程上运行，以减少线程数量和上下文切换。

### 解决方案

将多个 Agent 包装成 `CompositeAgent`，然后通过单个 `AgentRunner` 调度：

```java
Agent agent1 = new OrderProcessingAgent();
Agent agent2 = new HeartbeatAgent();
Agent agent3 = new MetricsAgent();

// 组合为单个 Agent
Agent composite = new CompositeAgent(agent1, agent2, agent3);

// 单个 Runner，单个线程
AgentRunner runner = new AgentRunner(
    new BackoffIdleStrategy(100, 1000, 1_000_000, 10_000_000),
    Throwable::printStackTrace,
    null,
    composite
);

AgentRunner.startOnThread(runner);
```

### CompositeAgent 工作原理

```
AgentRunner 线程
  └── CompositeAgent.doWork()
        ├── agent1.doWork() → 返回 3
        ├── agent2.doWork() → 返回 0
        ├── agent3.doWork() → 返回 5
        └── 返回总工作量：3 + 0 + 5 = 8
              ↓
        idleStrategy.idle(8)  → 8 > 0，不休眠，继续下一循环
```

**关键特性：**
- Agent 按**构造顺序顺序执行**（非并行）
- 任意一个 Agent 返回 > 0，整个 CompositeAgent 就返回 > 0
- 所有 Agent 共享同一个空闲策略和线程

### 完整示例

```java
import org.agrona.concurrent.*;

public class CompositeAgentDemo {

    // Agent 1：处理业务消息
    static class BusinessAgent implements Agent {
        private final ManyToOneConcurrentArrayQueue<String> queue;

        BusinessAgent(ManyToOneConcurrentArrayQueue<String> queue) {
            this.queue = queue;
        }

        @Override
        public int doWork() {
            int work = 0;
            for (int i = 0; i < 50; i++) {
                String msg = queue.poll();
                if (msg == null) break;
                System.out.println("[Business] 处理: " + msg);
                work++;
            }
            return work;
        }

        @Override
        public String roleName() { return "business"; }
    }

    // Agent 2：发送心跳
    static class HeartbeatAgent implements Agent {
        private long lastHeartbeatNs = 0;
        private static final long INTERVAL_NS = 1_000_000_000L; // 1秒

        @Override
        public int doWork() {
            long now = System.nanoTime();
            if (now - lastHeartbeatNs >= INTERVAL_NS) {
                System.out.println("[Heartbeat] 发送心跳 @ " + System.currentTimeMillis());
                lastHeartbeatNs = now;
                return 1;
            }
            return 0;
        }

        @Override
        public String roleName() { return "heartbeat"; }
    }

    public static void main(String[] args) throws Exception {
        ManyToOneConcurrentArrayQueue<String> queue =
            new ManyToOneConcurrentArrayQueue<>(1024);

        Agent composite = new CompositeAgent(
            new BusinessAgent(queue),
            new HeartbeatAgent()
        );

        AgentRunner runner = new AgentRunner(
            new BackoffIdleStrategy(100, 1000, 1_000_000, 10_000_000),
            Throwable::printStackTrace,
            null,
            composite
        );

        AgentRunner.startOnThread(runner).setName("composite-agent");

        // 发送消息
        for (int i = 0; i < 5; i++) {
            queue.offer("Order-" + i);
        }

        Thread.sleep(3000);
        runner.close();
    }
}
```

### Aeron Media Driver 中的实际应用

`CompositeAgent` 在 Aeron 中被广泛使用。当 Media Driver 以 `SHARED` 线程模式运行时：

```
SHARED 模式（单线程）：
  CompositeAgent
    ├── ConductorAgent（管理连接和资源）
    ├── SenderAgent（发送网络数据包）
    └── ReceiverAgent（接收网络数据包）

DEDICATED 模式（三个独立线程）：
  ConductorThread + SenderThread + ReceiverThread
```

### 自定义线程名称

默认线程名是所有 Agent `roleName()` 的组合（如 `business+heartbeat`），可以通过重写来自定义：

```java
Agent composite = new CompositeAgent(agent1, agent2) {
    @Override
    public String roleName() {
        return "order-pipeline";  // 自定义线程名
    }
};
```

### CompositeAgent vs 独立线程的选择

| 因素 | CompositeAgent | 独立线程 |
|------|---------------|---------|
| 线程数量 | 少（节约资源） | 多 |
| 上下文切换 | 少 | 多 |
| Agent 间延迟 | 无（顺序执行） | 有（线程切换） |
| 并行度 | 无（串行） | 有（真正并行） |
| 适用场景 | Agent 轻量级、关联性强 | Agent 独立、CPU 密集 |

### AgentInvoker：另一种组合方式

如果 Agent 之间有主从关系，可以用 `AgentInvoker` 代替 `CompositeAgent`：

```java
// 主 Agent 在自己的 doWork() 中手动调用从属 Agent
static class MasterAgent implements Agent {
    private final AgentInvoker slaveInvoker;

    MasterAgent(Agent slave) {
        this.slaveInvoker = new AgentInvoker(Throwable::printStackTrace, null, slave);
        slaveInvoker.start();
    }

    @Override
    public int doWork() {
        int work = doMasterWork();
        if (shouldInvokeSlave()) {
            work += slaveInvoker.invoke();  // 主 Agent 控制从属 Agent 的调用时机
        }
        return work;
    }

    @Override
    public void onClose() {
        slaveInvoker.close();
    }

    @Override
    public String roleName() { return "master"; }

    private int doMasterWork() { return 0; }
    private boolean shouldInvokeSlave() { return true; }
}
```

---

## 17. 优雅终止 Agent

### 问题

Agent 中发生了终端错误（或达到某个终止条件），需要停止 Agent 的运行。

### 解决方案

在 `doWork()` 中抛出 `AgentTerminationException`：

```java
@Override
public int doWork() {
    if (terminalErrorOccurred) {
        throw new AgentTerminationException("致命错误：数据库连接丢失");
    }
    // ... 正常处理 ...
    return processMessages();
}
```

### 终止机制详解

```
Agent.doWork() 抛出 AgentTerminationException
  ↓
AgentRunner.doDutyCycle() 捕获
  ↓
isRunning = false
  ↓
运行循环退出
  ↓
Agent.onClose() 被调用（资源清理）
  ↓
线程退出
```

`AgentInvoker` 有同样的机制，通过 `invoker.isRunning()` 可检查状态：

```java
AgentInvoker invoker = new AgentInvoker(..., agent);
invoker.start();

// 手动驱动循环
while (invoker.isRunning()) {
    invoker.invoke();
}
// Agent 终止后，isRunning() 返回 false
System.out.println("Agent 已终止");
```

### 常见终止场景

```java
public class RobustAgent implements Agent {
    private int retryCount = 0;
    private static final int MAX_RETRIES = 3;
    private volatile boolean shutdownRequested = false;

    @Override
    public int doWork() {
        // 场景1：外部请求终止（优雅关闭）
        if (shutdownRequested && workQueue.isEmpty()) {
            throw new AgentTerminationException("优雅关闭：队列已清空");
        }

        // 场景2：检测到致命错误
        try {
            return processMessages();
        } catch (FatalDatabaseException e) {
            throw new AgentTerminationException("数据库连接丢失，无法恢复", e);
        } catch (RecoverableException e) {
            retryCount++;
            if (retryCount > MAX_RETRIES) {
                throw new AgentTerminationException(
                    "超过最大重试次数: " + MAX_RETRIES, e);
            }
            // 可恢复，继续运行
            return 0;
        }
    }

    // 外部调用请求优雅关闭
    public void requestGracefulShutdown() {
        shutdownRequested = true;
    }

    @Override
    public void onClose() {
        // 释放资源
        workQueue.clear();
        System.out.println("Agent 已关闭，重试次数: " + retryCount);
    }

    @Override
    public String roleName() { return "robust-agent"; }

    private int processMessages() { return 0; /* ... */ }
}
```

### 注册 JVM Shutdown Hook

```java
public class GracefulShutdownExample {
    public static void main(String[] args) {
        RobustAgent agent = new RobustAgent();
        AgentRunner runner = new AgentRunner(
            new BackoffIdleStrategy(100, 10, 1, 1_000_000),
            Throwable::printStackTrace,
            null,
            agent
        );
        AgentRunner.startOnThread(runner);

        // JVM 关闭时（Ctrl+C 或 kill）优雅停止 Agent
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("收到关闭信号，等待 Agent 完成...");
            agent.requestGracefulShutdown();
            runner.close();  // 等待 Agent 退出
        }));
    }
}
```

### 级联终止：一个 Agent 失败时关闭所有 Agent

```java
public class AgentCoordinator {
    private final List<AgentRunner> runners = new ArrayList<>();

    public void add(AgentRunner runner) {
        runners.add(runner);
    }

    public void monitorAndCascadeShutdown() {
        Thread monitor = new Thread(() -> {
            while (true) {
                // 检查是否有任何 Agent 已终止
                for (AgentRunner runner : runners) {
                    if (!runner.isRunning()) {
                        System.err.println("检测到 Agent 终止，执行级联关闭");
                        runners.forEach(AgentRunner::close);
                        return;
                    }
                }
                try { Thread.sleep(100); } catch (InterruptedException e) { break; }
            }
        });
        monitor.setDaemon(true);
        monitor.start();
    }
}
```

### 最佳实践

1. **`AgentTerminationException` 是正常的终止机制**，不是错误——在 `errorHandler` 中用 `instanceof` 判断是否为正常终止
2. **`onClose()` 必须实现资源清理**：关闭文件句柄、网络连接、释放内存等
3. **区分可恢复错误与致命错误**：可恢复的 → 记录日志继续运行，致命的 → 抛出 `AgentTerminationException`
4. **终止后无法重启**：需要重新创建 Agent 实例和 AgentRunner

---

## 18. AgentRunner 与自定义 ThreadFactory

### 问题

需要以特定方式创建和管理 Agent 线程（自定义名称、设置优先级、绑定 CPU 核心、集成监控等）。

### 解决方案

在 `AgentRunner.startOnThread()` 中传入自定义 `ThreadFactory`：

```java
ThreadFactory myFactory = runnable -> {
    Thread thread = new Thread(runnable);
    thread.setName("my-agent-thread");
    thread.setPriority(Thread.MAX_PRIORITY);
    return thread;
};

AgentRunner runner = new AgentRunner(idleStrategy, Throwable::printStackTrace, null, agent);
AgentRunner.startOnThread(runner, myFactory);
```

### 四种典型的 ThreadFactory 实现

#### 1. 高优先级命名工厂

```java
public class NamedPriorityThreadFactory implements ThreadFactory {
    private final String name;
    private final int priority;
    private final boolean daemon;

    public NamedPriorityThreadFactory(String name, int priority, boolean daemon) {
        this.name = name;
        this.priority = priority;
        this.daemon = daemon;
    }

    @Override
    public Thread newThread(Runnable r) {
        Thread t = new Thread(r, name);
        t.setPriority(priority);
        t.setDaemon(daemon);
        t.setUncaughtExceptionHandler((thread, ex) -> {
            System.err.println("Thread " + thread.getName() + " failed: " + ex);
        });
        return t;
    }
}

// 使用示例
ThreadFactory factory = new NamedPriorityThreadFactory(
    "trading-engine",
    Thread.MAX_PRIORITY,
    false
);
AgentRunner.startOnThread(runner, factory);
```

#### 2. CPU 亲和性绑定工厂

将线程绑定到特定 CPU 核心，避免跨核心迁移，提升缓存局部性：

```java
public class CpuAffinityThreadFactory implements ThreadFactory {
    private final int cpuCore;
    private final String name;

    public CpuAffinityThreadFactory(String name, int cpuCore) {
        this.name = name;
        this.cpuCore = cpuCore;
    }

    @Override
    public Thread newThread(Runnable r) {
        return new Thread(() -> {
            // 绑定 CPU（需要 Thread-Affinity 库或 JNA）
            // Affinity.setAffinity(1L << cpuCore);
            System.out.printf("线程 %s 运行在 CPU %d%n", name, cpuCore);
            r.run();
        }, name);
    }
}
```

#### 3. 监控统计工厂

```java
public class MonitoredThreadFactory implements ThreadFactory {
    private final String prefix;
    private final AtomicInteger created = new AtomicInteger();
    private final AtomicInteger active = new AtomicInteger();

    public MonitoredThreadFactory(String prefix) {
        this.prefix = prefix;
    }

    @Override
    public Thread newThread(Runnable r) {
        String threadName = prefix + "-" + created.incrementAndGet();
        return new Thread(() -> {
            active.incrementAndGet();
            System.out.println("启动: " + threadName);
            try {
                r.run();
            } finally {
                active.decrementAndGet();
                System.out.println("终止: " + threadName);
            }
        }, threadName);
    }

    public int getActiveCount() { return active.get(); }
    public int getTotalCreated() { return created.get(); }
}
```

#### 4. Builder 模式的生产级工厂

```java
public class ProductionThreadFactory implements ThreadFactory {
    private final String namePrefix;
    private final int priority;
    private final boolean daemon;
    private final Thread.UncaughtExceptionHandler exceptionHandler;
    private final AtomicInteger counter = new AtomicInteger();

    private ProductionThreadFactory(Builder b) {
        this.namePrefix = b.namePrefix;
        this.priority = b.priority;
        this.daemon = b.daemon;
        this.exceptionHandler = b.exceptionHandler;
    }

    @Override
    public Thread newThread(Runnable r) {
        Thread t = new Thread(r, namePrefix + "-" + counter.incrementAndGet());
        t.setPriority(priority);
        t.setDaemon(daemon);
        if (exceptionHandler != null) t.setUncaughtExceptionHandler(exceptionHandler);
        return t;
    }

    public static class Builder {
        private String namePrefix = "agent";
        private int priority = Thread.NORM_PRIORITY;
        private boolean daemon = false;
        private Thread.UncaughtExceptionHandler exceptionHandler;

        public Builder name(String prefix) { this.namePrefix = prefix; return this; }
        public Builder priority(int p) { this.priority = p; return this; }
        public Builder daemon(boolean d) { this.daemon = d; return this; }
        public Builder onUncaughtException(Thread.UncaughtExceptionHandler h) {
            this.exceptionHandler = h; return this;
        }
        public ProductionThreadFactory build() {
            return new ProductionThreadFactory(this);
        }
    }

    // 使用示例
    public static void main(String[] args) {
        ThreadFactory factory = new Builder()
            .name("critical-agent")
            .priority(Thread.MAX_PRIORITY)
            .daemon(false)
            .onUncaughtException((t, e) ->
                System.err.println("ALERT: Thread " + t.getName() + " failed"))
            .build();

        AgentRunner runner = new AgentRunner(
            new BusySpinIdleStrategy(),
            Throwable::printStackTrace, null,
            new MyAgent()
        );

        AgentRunner.startOnThread(runner, factory);
    }
}
```

### 默认线程 vs 自定义线程

| 配置项 | 默认 | 自定义工厂 |
|--------|------|----------|
| 线程名 | agent 的 `roleName()` | 任意 |
| 优先级 | `NORM_PRIORITY`（5） | 任意（1-10） |
| 守护线程 | `false` | 任意 |
| CPU 绑定 | 无 | 需要 JNA/JNI |
| 监控 | 无 | 自定义 |
| 异常处理 | 默认 JVM 处理 | 自定义 handler |

### 最佳实践

1. **始终设置线程名**：有意义的线程名让问题排查更容易（`jstack` 输出可读）
2. **设置未捕获异常处理器**：避免无声失败
3. **谨慎使用高优先级**：过多高优先级线程会降低系统整体响应性
4. **CPU 绑定需要操作系统支持**：在容器化环境中可能无效
5. **ThreadFactory 必须线程安全**：可能被多个线程并发调用

---

# 附录：性能对比与选型指南

## 编解码性能对比

| 格式 | 编码速度 | 解码速度 | 消息大小 | 推荐场景 |
|------|---------|---------|---------|---------|
| Agrona 二进制 | 50M ops/s | 45M ops/s | ~28B | 内部 IPC，简单结构 |
| SBE | 60M ops/s | 55M ops/s | ~26B | 复杂结构，版本控制 |
| Protobuf | 2M ops/s | 1.5M ops/s | ~35B | 跨语言，外部接口 |
| JSON | 500K ops/s | 400K ops/s | ~95B | 调试，对外 REST API |

## 队列性能对比

| 队列类型 | 吞吐量 | 延迟 | GC 压力 | 适用场景 |
|---------|-------|------|---------|---------|
| `OneToOneConcurrentArrayQueue` | 200M ops/s | <100ns | 零 | 1P1C，最高性能 |
| `ManyToOneConcurrentArrayQueue` | 150M ops/s | <200ns | 零 | 多P单C，最常用 |
| `ManyToManyConcurrentArrayQueue` | 100M ops/s | <500ns | 零 | 多P多C |
| JDK `LinkedBlockingQueue` | 20M ops/s | ~2μs | 高 | 通用但慢 |

## IdleStrategy 选型

| 策略 | 延迟 | CPU | 推荐场景 |
|------|------|-----|---------|
| `BusySpinIdleStrategy` | ~100ns | 100% | 高频交易，独占核心 |
| `YieldingIdleStrategy` | ~1μs | 高 | 快速响应，多核系统 |
| `BackoffIdleStrategy` | 1μs-10ms | 自适应 | **通用推荐** |
| `SleepingIdleStrategy` | 1ms+ | 低 | 后台任务，节能 |

## 数据结构选型

| 需求 | 推荐 | 原因 |
|------|------|------|
| int → Object 映射 | `Int2ObjectHashMap` | 无装箱，高性能 |
| long → Object 映射 | `Long2ObjectHashMap` | 无装箱 |
| int 集合 | `IntHashSet` | 无装箱 |
| 高频迭代映射 | `Int2ObjectHashMap` + 外部列表 | Map 迭代较慢 |

## 时钟选型

| 需求 | 推荐 | 原因 |
|------|------|------|
| 精确性能测量 | `SystemNanoClock` | 纳秒精度 |
| 高频业务时间戳 | `CachedEpochClock` | 零系统调用 |
| 低频业务时间戳 | `SystemEpochClock` | 简单直接 |
| Agent 内多处用时间 | `CachedEpochClock`（每 Duty Cycle 更新一次） | 减少系统调用 |

## 学习路径建议

```
Week 1（入门）：
  ├── 了解 Agrona 定位和技术栈
  ├── 理解 Duty Cycle 概念
  ├── 运行第一个 Agent 示例
  └── 尝试不同的 IdleStrategy

Week 2（核心组件）：
  ├── 掌握 DirectBuffer / UnsafeBuffer
  ├── 使用无锁队列进行线程间通信
  └── 了解 Int2ObjectHashMap 等数据结构

Week 3（进阶）：
  ├── 构建多 Agent 流水线
  ├── 实现自定义二进制编解码器
  └── 理解线程模型和调度策略

Week 4（优化）：
  ├── 性能分析与调优
  ├── 尝试 CPU 绑定和自定义 ThreadFactory
  ├── 实现生产级监控
  └── 构建完整的实际项目
```

---

> **参考资源**
> - [Agrona GitHub](https://github.com/real-logic/agrona)
> - [Aeron 官网](https://aeron.io)
> - [Simple Binary Encoding](https://github.com/real-logic/simple-binary-encoding)
> - 原始教程：[aeron-class-site.pages.dev](https://aeron-class-site.pages.dev/)
