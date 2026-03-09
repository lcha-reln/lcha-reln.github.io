---
title: Agrona 零基础入门
date: 2026-03-07 20:54:50
tags:
  - 高性能
  - Java
categories:
  - Agrona
---
# 1.Agrona 概述
## 1.1.Agrona 的核心价值
Agrona 提供了许多有用的高性能通用数据结构和常见支持对象,这些组件被广泛应用于 Simple Binary Encoding (SBE)、Aeron 以及相关项目中。

Agrona 是一个专注于高性能、低延迟的 Java 工具库,它为构建高效的并发系统提供了基础组件。这个库的设计理念是避免不必要的内存分配和垃圾回收开销,从而实现极致的性能。
**Agrona 的地位**

![Agrona 的地位](/images/Agrona/Agrona 的地位.png)

## 1.2.核心架构组件

![核心架构组件](/images/Agrona/核心架构组件.png)

部分组件详细说明
- 数据结构层：提供针对性能优化的专用数据结构
  - Int2ObjectHashMap: 整数到对象的映射,避免装箱开销
  - Object2ObjectHashMap: 自定义哈希实现,减少碰撞
  - ArrayQueue: 基于数组的高性能队列
- 并发工具层：无锁并发组件,支持高吞吐量线程通信
  - ManyToOneConcurrentArrayQueue: 多生产者单消费者队列
  - OneToOneConcurrentArrayQueue: 单生产者单消费者队列
  - BroadcastTransmitter/Receiver: 一对多广播通信
- 缓冲区管理层：直接内存访问能力
  - DirectBuffer: 抽象的内存缓冲区接口
  - UnsafeBuffer: 使用sun.misc.Unsafe的高性能实现
  - MutableDirectBuffer: 可变的直接缓冲区
- Agent框架层：任务调度和执行模型
  - Agent: 可执行任务的抽象
  - DutyCycle: 任务执行周期管理
  - IdleStrategy: 空闲时的CPU策略

# 2.Duty Cycles（职责周期）
Duty Cycle（职责周期）是 Agrona 中一个核心概念，它定义了一个工作单元在执行过程中应该完成的任务。在高性能系统中，合理设计 Duty Cycle 对于实现低延迟和高吞吐量至关重要。
## 2.1.什么是 Duty Cycles
Duty Cycle 本质上是一个可重复执行的工作单元。在 Agrona 的上下文中，它通常指的是 Agent 在每次被调度时执行的工作量。也可以说是忙轮询（Busy-Spin）模式的结构化封装，让每个线程专注于一组固定的任务，反复执行，不依赖锁和阻塞

如果你玩过电脑游戏，你很可能已经与 Duty Cycle(也称为事件循环 Event Loop)打过交道。Duty Cycle 是系统组件执行的主循环。在循环中执行一些任务，然后可以选择等待一段时间。
**游戏示例：**
对于简单的电脑游戏，Duty Cycle 可能是这样的:
```java
                EpochClock clock = new SystemEpochClock();
                while (true)
                {
                    long time = clock.time();
                    processInput();    // 处理输入
                    update();          // 更新游戏状态
                    render();          // 渲染画面
                    Thread.sleep(MS_PER_FRAME - (clock.time() - time));  // 控制帧率
                }
```
这里的 sleep 允许游戏开发者控制两件事:
1. 游戏的功耗: 通过限制CPU使用率降低能耗
2. 每秒帧数: 确保一致的游戏体验

这很重要，因为不同的 CPU 具有不同的性能特征，游戏开发者希望用户在不同硬件上获得一致的体验。
## 2.2.在 Aeron/Agrona 中的应用
在典型的 Aeron 应用程序中，我们也使用 Duty Cycle。它们在 Agrona Agent 内部运行，游戏示例中的 sleep 由空闲策略(Idle Strategy)管理。Duty Cycle 直接影响:
- 服务能力: 每秒处理的消息数(吞吐量)
- CPU 消耗: 进程的资源使用情况

## 2.3.两种经典的 Duty Cycle 类型
1. 业务逻辑 Duty Cycle
   
   这是由输入消息驱动的典型 Duty Cycle。为了实现高吞吐量，应用的 sleep(即空闲策略)几乎不会延迟 Duty Cycle。
   ```java
                while (true)
                {
                    Command command = adaptInputBuffer();           // 从输入缓冲区适配命令
                    routeToAppropriateBusinessLogic(command);       // 路由到适当的业务逻辑
                } 
   ```
   routeToAppropriateBusinessLogic() 的调用通常会执行类似于在有状态对象(如复制状态机 Replicated State Machine)上调用方法的操作:
   ```java
                public void doSomething(Command command)
                {
                    processInput();    // 处理输入
                    emitEvents();      // 发出事件
                }
   ```
   基本流程
   - 适配输入：从网络或队列中接收并解析命令
   - 路由处理：根据命令类型路由到对应的业务逻辑处理器
   - 处理输入：执行业务逻辑，更新状态
   - 发出事件：生成输出事件，通知其他组件
   - 空闲策略：由于是高吞吐场景，通常使用 BusySpinIdleStrategy 或 BackoffIdleStrategy 的激进配置
2. 连接管理 Duty Cycle
   
   这种 Duty Cycle 不是由消息驱动的，而是由管理与某物连接的需求驱动的。没有必要每秒调用数千次，因此 Duty Cycle 中应用的 sleep 可能是数百毫秒。
   ```java
                while (true)
                {
                    checkConnectionStatus();     // 检查连接状态
                    reconnectIfNeeded();        // 如果需要则重新连接
                    Thread.sleep(100);          // 休眠 100ms
                }
   ```
   基本流程
   - 检查连接：定期检查网络连接、心跳等状态
   - 条件重连: 只有在检测到连接问题时才执行重连
   - 长时间休眠: 由于不需要高频率执行，使用较长的休眠时间(100-500ms)
   - 通常使用 SleepingIdleStrategy 来降低 CPU 使用率

## 2.4.核心概念
![核心概念](/images/Agrona/核心概念.png)
- 工作量定义：
  - 单次任务：每次 Duty Cycle 执行一个独立的工作项
  - 批量任务：每次 Duty Cycle 批量处理多个工作项，提高吞吐量
  - 复合任务：在一个 Duty Cycle 中完成多个相关联的任务
- 执行频率：
  - 紧密循环（Tight Loop）：持续快速执行，适合低延迟场景
  - 定时触发：按固定时间间隔执行，适合周期性任务
  - 事件驱动：根据外部事件触发执行，适合响应式系统
- 性能优化：
  - 减少线程上下文切换开销
  - 提高CPU缓存命中率
  - 优化CPU流水线执行效率

## 2.5.Duty Cycle的工作原理
![DutyCycle的工作原理](/images/Agrona/DutyCycle的工作原理.png)
- 调度器启动：调度器启动 Agent 的执行循环
- 检查工作：Agent 检查是否有待处理的工作
- 执行工作：如果有工作，执行并返回已完成的工作项数量
- 应用策略：如果没有工作，应用空闲策略来节省CPU资源
- 循环继续：重复上述过程

## 2.6.Duty Cycle接口
在 Agrona 中，Duty Cycle 主要通过以下接口实现：
```java
                /**
                 * Agent 接口 - 定义了 Duty Cycle 的核心方法
                 */
                public interface Agent
                {
                    /**
                     * 执行一个 Duty Cycle 的工作
                     *
                     * @return 完成的工作项数量，0 表示没有工作完成
                     * @throws Exception 如果在执行过程中发生错误
                     */
                    int doWork() throws Exception;

                    /**
                     * Agent 的角色名称
                     *
                     * @return 角色名称，用于日志和监控
                     */
                    String roleName();

                    /**
                     * 当 Agent 启动时调用
                     */
                    void onStart();

                    /**
                     * 当 Agent 关闭时调用
                     */
                    void onClose();
                }
```
简单的实现
```java
                import org.agrona.concurrent.Agent;
                import java.util.Queue;
                import java.util.concurrent.ConcurrentLinkedQueue;

                /**
                 * 简单的消息处理 Agent
                 */
                public class MessageProcessorAgent implements Agent
                {
                    private final Queue<String> messageQueue = new ConcurrentLinkedQueue<>();
                    private long processedCount = 0;

                    @Override
                    public int doWork() throws Exception
                    {
                        int workDone = 0;

                        // 批量处理消息，最多处理10条
                        for (int i = 0; i < 10; i++)
                        {
                            final String message = messageQueue.poll();
                            if (message == null)
                            {
                                break; // 没有更多消息，退出循环
                            }

                            // 处理消息
                            processMessage(message);
                            workDone++;
                            processedCount++;
                        }

                        return workDone;
                    }

                    @Override
                    public String roleName()
                    {
                        return "MessageProcessor";
                    }

                    @Override
                    public void onStart()
                    {
                        System.out.println("MessageProcessor Agent 启动");
                    }

                    @Override
                    public void onClose()
                    {
                        System.out.println("MessageProcessor Agent 关闭，总共处理了 "
                            + processedCount + " 条消息");
                    }

                    /**
                     * 添加消息到队列
                     */
                    public void addMessage(final String message)
                    {
                        messageQueue.offer(message);
                    }

                    /**
                     * 处理单条消息
                     */
                    private void processMessage(final String message)
                    {
                        // 实际的消息处理逻辑
                        // 这里只是简单打印
                        // System.out.println("处理消息: " + message);
                    }
                }
```

# 3.Agents & Idle Strategies (代理与空闲策略)
Idle Strategy（空闲策略）决定了当 Agent 没有工作可做时应该采取什么行动。

## 3.1.线程的问题
> 线程作为计算模型具有极高的不确定性，程序员的工作就变成了修剪这种不确定性。虽然许多研究技术通过提供更有效的修剪来改进模型，但我认为这是在倒着解决问题。我们应该从本质上确定性的、可组合的组件开始构建，而不是从需要移除的地方移除不确定性。不确定性应该在需要的地方明确而审慎地引入，而不是在不需要的地方移除。

Agrona 的 Agent 和 Idle Strategy 正是实现这一理念的方式之一。当 Agrona Agent 与 Aeron 一起使用时，允许以安全、一致的方式构建确定性的、资源管理的线程，这对开发者来说易于理解和推理。

## 3.2.核心设计理念

![核心设计理念](/images/Agrona/核心设计理念.png)

关键特性:
- 确定性: Agent 的行为是可预测的
- 可组合: 多个 Agent 可以组合在一起
- 资源管理: 通过 Idle Strategy 精确控制 CPU 使用
- 易于推理: 简单的编程模型，易于理解和调试

## 3.3.Agent（代理）
Agent 是一个执行特定职责的工作单元，它持续运行并处理分配给它的任务。

Agrona Agent 是应用程序逻辑的容器，在 Duty Cycle 中执行，例如处理来自 Aeron 订阅的消息。Agent 的 Duty Cycle 间隔以及 CPU 消耗由空闲策略控制。Agent 可以被调度在专用线程上，也可以作为单个线程上的复合代理组的一部分运行。

典型的 Duty Cycle 工作流程:
1. 持续轮询 Agent 的 doWork 函数，直到它返回 0
2. 一旦返回 0，调用空闲策略(Idle Strategy)
3. 空闲策略决定如何处理无工作状态(自旋、让出CPU、休眠等)

![典型的DutyCycle工作流程](/images/Agrona/典型的DutyCycle工作流程.png)

## 3.4.Idle Strategy（空闲策略）
### 3.4.1.空闲策略的重要性
当 Agent 没有工作可做时，IdleStrategy 决定如何使用 CPU 资源。这直接影响：
- 延迟：响应时间的快慢
- CPU 使用率：资源利用效率
- 功耗：能源消耗水平
- 吞吐量：系统整体处理能力

![空闲策略的重要性](/images/Agrona/空闲策略的重要性.png)

### 3.4.2.IdleStrategy 接口
```java
package org.agrona.concurrent;

                /**
                 * 空闲策略接口
                 */
                public interface IdleStrategy
                {
                    /**
                     * 空闲时调用
                     *
                     * @param workCount 最近一次 doWork() 返回的工作量
                     */
                    void idle(int workCount);

                    /**
                     * 空闲时调用（无工作量参数）
                     */
                    void idle();

                    /**
                     * 重置策略状态
                     */
                    void reset();
                }
```

### 3.4.3.常用的空闲策略
#### 3.4.3.1.BusySpinIdleStrategy (忙等待策略)
   
特点：持续自旋，不让出 CPU

使用场景：
 - 超低延迟要求（微秒级）
 - 独占CPU核心
 - 实时交易系统
 - 高频消息处理

```java
                package org.agrona.concurrent;

                /**
                 * 忙等待空闲策略
                 * 最低延迟，但CPU使用率100%
                 */
                public final class BusySpinIdleStrategy implements IdleStrategy
                {
                    @Override
                    public void idle(final int workCount)
                    {
                        // 什么都不做，持续自旋
                    }

                    @Override
                    public void idle()
                    {
                        // 什么都不做，持续自旋
                    }

                    @Override
                    public void reset()
                    {
                        // 无状态，无需重置
                    }
                }
```

#### 3.4.3.2.BackoffIdleStrategy (退避策略)
   
特点：渐进式退避，平衡延迟和 CPU 使用

使用场景：
- 负载波动的系统
- 需要平衡延迟和CPU使用
- 多个Agent共享CPU
- 通用的高性能应用

![退避策略过程](/images/Agrona/退避策略过程.png)

```java
                package org.agrona.concurrent;

                /**
                 * 退避空闲策略
                 * 在忙等待、让出CPU和休眠之间渐进切换
                 */
                public final class BackoffIdleStrategy implements IdleStrategy
                {
                    private final long maxSpins;          // 最大自旋次数
                    private final long maxYields;         // 最大让出次数
                    private final long minParkPeriodNs;   // 最小休眠时间（纳秒）
                    private final long maxParkPeriodNs;   // 最大休眠时间（纳秒）

                    private long spins = 0;
                    private long yields = 0;
                    private long parks = 0;

                    public BackoffIdleStrategy(
                        final long maxSpins,
                        final long maxYields,
                        final long minParkPeriodNs,
                        final long maxParkPeriodNs)
                    {
                        this.maxSpins = maxSpins;
                        this.maxYields = maxYields;
                        this.minParkPeriodNs = minParkPeriodNs;
                        this.maxParkPeriodNs = maxParkPeriodNs;
                    }

                    @Override
                    public void idle(final int workCount)
                    {
                        if (workCount > 0)
                        {
                            reset();
                        }
                        else
                        {
                            idle();
                        }
                    }

                    @Override
                    public void idle()
                    {
                        // 第一阶段：自旋
                        if (spins < maxSpins)
                        {
                            spins++;
                            return;
                        }

                        // 第二阶段：让出CPU
                        if (yields < maxYields)
                        {
                            yields++;
                            Thread.yield();
                            return;
                        }

                        // 第三阶段：休眠
                        parks++;
                        final long parkTime = Math.min(
                            minParkPeriodNs << parks,
                            maxParkPeriodNs
                        );

                        LockSupport.parkNanos(parkTime);
                    }

                    @Override
                    public void reset()
                    {
                        spins = 0;
                        yields = 0;
                        parks = 0;
                    }
                }
```

#### 3.4.3.3.SleepingIdleStrategy (休眠策略)
特点：立即休眠，最低 CPU 使用

使用场景：
- 后台批处理任务
- 非时间敏感的操作
- 节能场景
- 资源受限环境

```java
                package org.agrona.concurrent;

                /**
                 * 休眠空闲策略
                 * 最低CPU使用，但延迟较高
                 */
                public final class SleepingIdleStrategy implements IdleStrategy
                {
                    private final long sleepPeriodNs;

                    public SleepingIdleStrategy(final long sleepPeriodNs)
                    {
                        this.sleepPeriodNs = sleepPeriodNs;
                    }

                    @Override
                    public void idle(final int workCount)
                    {
                        if (workCount <= 0)
                        {
                            idle();
                        }
                    }

                    @Override
                    public void idle()
                    {
                        LockSupport.parkNanos(sleepPeriodNs);
                    }

                    @Override
                    public void reset()
                    {
                        // 无状态
                    }
                }
```

#### 3.4.3.4.YieldingIdleStrategy (让出策略)
特点：调用 Thread.yield() 让出 CPU

使用场景：
- 需要快速响应但不需要极低延迟
- CPU核心数充足
- 多个线程竞争

```java
                package org.agrona.concurrent;

                /**
                 * 让出空闲策略
                 * 中等延迟和CPU使用
                 */
                public final class YieldingIdleStrategy implements IdleStrategy
                {
                    @Override
                    public void idle(final int workCount)
                    {
                        if (workCount <= 0)
                        {
                            Thread.yield();
                        }
                    }

                    @Override
                    public void idle()
                    {
                        Thread.yield();
                    }

                    @Override
                    public void reset()
                    {
                        // 无状态
                    }
                }
```

#### 3.4.3.5.NoOpIdleStrategy (无操作策略)
特点：什么都不做

```java
                package org.agrona.concurrent;

                /**
                 * 无操作空闲策略
                 * 用于测试或特殊场景
                 */
                public final class NoOpIdleStrategy implements IdleStrategy
                {
                    public static final NoOpIdleStrategy INSTANCE = new NoOpIdleStrategy();

                    @Override
                    public void idle(final int workCount)
                    {
                        // 什么都不做
                    }

                    @Override
                    public void idle()
                    {
                        // 什么都不做
                    }

                    @Override
                    public void reset()
                    {
                        // 无状态
                    }
                }
```

### 3.4.4.空闲策略对比

![空闲策略对比](/images/Agrona/空闲策略对比.png)

## 3.5.AgentRunner（Agent 运行器）
### 3.5.1.AgentRunner 的作用
AgentRunner 负责在线程中运行 Agent，并应用 IdleStrategy。

![AgentRunner](/images/Agrona/AgentRunner.png)

# 4.Threads, Agents & Duty Cycles (线程、代理与职责周期)
探讨 Agrona 中线程、Agent 和 Duty Cycle 三者之间的关系,以及如何通过合理的设计实现高性能系统。

## 4.1.三者关系

![三者关系](/images/Agrona/三者关系.png)

- Thread: 提供执行上下文
- AgentRunner: 管理Agent的生命周期
- Agent: 定义工作逻辑
- Duty Cycle: Agent的单次工作周期
- IdleStrategy: 控制空闲时的行为

## 4.2.线程模型
### 4.2.1.专用线程模型
每个Agent运行在独占的线程上:
```java
                // 创建Agent
                final Agent agent = new MyHighPriorityAgent();
                final IdleStrategy idleStrategy = new BusySpinIdleStrategy();

                // 创建Runner
                final AgentRunner runner = new AgentRunner(
                    idleStrategy,
                    Throwable::printStackTrace,
                    null,
                    agent
                );

                // 启动专用线程
                final Thread thread = AgentRunner.startOnThread(runner);
                thread.setName("HighPriority-Agent");
                thread.setPriority(Thread.MAX_PRIORITY);
```
优势: 最低延迟、可预测的性能 劣势: 资源消耗大

### 4.2.2.共享线程模型
多个Agent共享一个线程:

```java
                // 创建复合Agent
                final Agent compositeAgent = new CompositeAgent(
                    "SharedThread",
                    new ReceiveAgent(),
                    new ProcessAgent(),
                    new SendAgent()
                );

                final AgentRunner runner = new AgentRunner(
                    new BackoffIdleStrategy(100, 10, 1, 1_000_000),
                    Throwable::printStackTrace,
                    null,
                    compositeAgent
                );

                AgentRunner.startOnThread(runner);
```

- 优势: 资源利用率高 
- 劣势: 可能存在优先级问题

## 4.3.性能优化技巧
### 4.3.1.CPU亲和性
```java
                // 将线程绑定到特定CPU核心
                public static void setThreadAffinity(final Thread thread, final int cpuId)
                {
                    // 使用JNI或Agrona的ThreadHints
                    ThreadHints.onSpinWait();
                }
```

### 4.3.2.批量处理
```java
                @Override
                public int doWork()
                {
                    int work = 0;
                    
                    // 批量处理提高吞吐量
                    for (int i = 0; i < BATCH_SIZE; i++)
                    {
                        final Task task = queue.poll();
                        if (task == null) break;
                        
                        processTask(task);
                        work++;
                    }
                    
                    return work;
                }
```

### 4.3.3.预取优化
```java
                @Override
                public int doWork()
                {
                    int totalWork = 0;
                    
                    // 预取多个数据源
                    totalWork += processInput1();
                    totalWork += processInput2();
                    totalWork += processOutput();
                    
                    return totalWork;
                }
```