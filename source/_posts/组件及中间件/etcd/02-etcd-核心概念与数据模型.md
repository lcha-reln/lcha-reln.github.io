---
title: etcd - 核心概念与数据模型
tags:
  - etcd
  - 分布式
  - 中间件
categories:
  - 中间件
  - etcd
abbrlink: 5ebb723b
date: 2026-03-12 10:01:00
---

> etcd 的数据模型、一致性保证、API 语义和 Raft 一致性协议详解。

## 1. 数据模型

### 1.1 逻辑视图（Logical View）

etcd 的存储逻辑视图是一个**扁平的二进制键空间（flat binary key space）**。键空间在字节字符串键上维护了一个字典序排序的索引，因此范围查询（range query）的代价非常低廉。

**键空间维护多个修订版本（Revision）：**

- 存储创建时，初始修订版本为 **1**
- 每个原子变更操作（如一个事务可包含多个操作）都会在键空间上创建一个新的修订版本
- 所有过去修订版本的数据保持不变——旧版本的键仍然可以通过指定旧的修订版本号来访问
- 修订版本也有索引，通过 watcher 对修订版本区间进行范围查询是高效的
- 修订版本号在集群的整个生命周期中**单调递增**
- 若存储被压缩（compact），压缩修订版本之前的修订版本将被移除

**键的生命周期（Generation）：**

- 每个键的生命周期跨越多个 generation，从创建到删除
- 创建一个键会从 1 开始递增该键的 **version**（若该键在当前修订版本不存在）
- 删除一个键会生成一个 tombstone（墓碑），通过将 version 重置为 0 结束该键当前的 generation
- 每次修改键都会递增其 version——因此 version 在键的单个 generation 内**单调递增**

```
revision=1: put /foo → bar        (foo.version=1)
revision=2: put /foo → baz        (foo.version=2)
revision=3: delete /foo           (foo.version=0, tombstone)
revision=4: put /foo → qux        (foo.version=1, new generation)
```

### 1.2 物理视图（Physical View）

etcd 将物理数据以键值对的形式存储在一个持久化的 **B+ 树（b+tree）** 中。

**B+ 树键的结构：**

每个键值对的键是一个 3 元组 `(major, sub, type)`：

| 字段 | 含义 |
|------|------|
| `major` | 持有该键的存储修订版本（store revision） |
| `sub` | 在同一修订版本内区分不同的键 |
| `type` | 可选后缀，用于特殊值（如 `t` 表示值中包含 tombstone） |

键值对的 value 包含了相对于前一修订版本的增量变更（delta），B+ 树按键的字典序排列，使得查找特定修订版本范围内的变更非常高效。

**辅助内存 B 树索引：**

etcd 还维护了一个辅助的内存**B 树（btree）索引**以加速键的范围查询。该 B 树的键是暴露给用户的键名，值是指向持久化 B+ 树中对应修改的指针。压缩会移除过期指针。

**查询流程：**

```
用户请求 key → 内存 B 树索引（找到 revision）→ 持久化 B+ 树（用 revision 获取 value）
```

---

## 2. API 保证（API Guarantees）

etcd 是一个**一致且持久的**键值存储。它确保了分布式系统中最强的一致性和持久性保证。

### 2.1 KV API 保证

#### 持久性（Durability）

任何已完成的操作都是**持久的**。所有可访问的数据也都是持久数据。读操作永远不会返回未被持久化的数据。

#### 严格串行化（Strict Serializability）

KV Service 的操作是原子的，按照与这些操作的实际时间顺序一致的全序（total order）发生。全序通过修订版本号（revision）体现。

严格串行化蕴含以下更弱的保证：

**原子性（Atomicity）：**
- 所有 API 请求都是原子的：操作要么完全完成，要么完全不发生
- 对于 Watch 请求，一个操作产生的所有事件将出现在同一个 watch 响应中，Watch 永远不会观察到单个操作的部分事件

**线性化（Linearizability）：**

> 线性化提供了这样一种幻觉：并发进程应用的每个操作在其调用和响应之间的某个时刻立即生效。

例如，客户端在时间点 *t1* 完成写操作。在 *t2*（*t2* > *t1*）发起读操作的客户端，应该收到至少和 *t1* 完成的写同样新的值。etcd 默认对所有操作保证线性化。

线性化是有代价的——线性化请求必须经过 Raft 共识过程。为了获得更低延迟和更高吞吐量，客户端可以将读请求的一致性模式配置为 `serializable`，此时读取可能返回相对于 quorum 来说稍旧的数据，但可以避免线性化访问依赖活跃共识的性能开销。

### 2.2 Watch API 保证

Watch 对事件做出如下保证：

| 保证 | 说明 |
|------|------|
| **有序（Ordered）** | 事件按修订版本顺序排列。已发布的事件之后，更早的事件不会出现在 watch 中 |
| **唯一（Unique）** | 同一个事件永远不会在 watch 中出现两次 |
| **可靠（Reliable）** | 一系列事件不会丢弃任何子序列。若按时间顺序 a < b < c，watch 收到了 a 和 c，则只要 b 在可用历史窗口内，b 也一定被收到 |
| **原子（Atomic）** | 事件列表保证包含完整的修订版本。同一修订版本中对多个键的更新不会被拆分到多个事件列表中 |
| **可恢复（Resumable）** | 中断的 watch 可以通过建立新 watch（从中断前最后收到的修订版本之后开始）来恢复 |
| **可书签（Bookmarkable）** | 进度通知事件保证截至某修订版本的所有事件已经交付 |

> etcd **不**对 watch 操作保证线性化。用户需要验证 watch 事件的修订版本来确保与其他操作的正确排序。

### 2.3 Lease API 保证

Lease（租约）API 对 Grant、Revoke 和 KeepAlive 操作提供以下保证：

- **耐久性（Durability）**：已成功 grant 的租约在整个生命周期内都是有效的
- **单调性（Monotonicity）**：若租约已过期，则不再颁发该租约 ID 的新操作
- **可用性（Availability）**：etcd 确保租约相关的键在租约过期时被删除

### 2.4 关键定义

**操作完成（Operation Completed）：**

当 etcd 服务端增加了对应于该操作的修订版本，并将请求结果返回给客户端，该操作即为完成。

**修订版本（Revision）：**

修订版本是分配给 etcd 键值存储的每次变更的 64 位整数。在同一修订版本中的 KV 操作被认为是并发的，一个修订版本只有一个唯一的 zxid（etcd 对等物）。在集群操作的整个生命周期中，修订版本单调递增。

---

## 3. Raft 一致性协议

etcd 使用 **Raft** 共识算法来保证集群的一致性和高可用性。

### 3.1 Raft 基础

Raft 将集群中的服务器分为三个角色：

| 角色 | 描述 |
|------|------|
| **Leader** | 负责接收所有写请求，将日志复制到 Follower，提交已复制的日志 |
| **Follower** | 响应 Leader 和 Candidate 的请求；将客户端请求转发给 Leader |
| **Candidate** | 选举 Leader 过程中的临时状态 |

### 3.2 Leader 选举

当 Follower 在**选举超时**内未收到 Leader 的心跳，即转变为 Candidate 并发起选举：

1. 自增 term，向其他节点发送 `RequestVote` RPC
2. 收到**多数节点**的投票后成为新 Leader
3. 新 Leader 立即发送心跳以防止其他节点重新发起选举

**投票规则：**
- 每个 term 内每个节点只投一票
- 只投给日志至少和自己一样新的 Candidate（日志比较：term 更大优先，term 相同则 index 更大优先）

**etcd 集群节点数要求：**

- 必须使用**奇数**节点（3、5、7...）
- 支持容忍的最大故障节点数 = `(N-1)/2`，如 3 节点容忍 1 个故障，5 节点容忍 2 个故障

### 3.3 日志复制（写操作流程）

```
1. 客户端发送写请求到任意节点
2. Follower/Observer 将请求转发给 Leader
3. Leader 将操作追加到本地日志（log entry），并向所有 Follower 发送 AppendEntries RPC
4. Follower 收到后写入本地日志，返回 ACK
5. Leader 收到多数节点（Quorum）的 ACK 后，提交（commit）该日志条目
6. Leader 将结果返回给客户端
7. Leader 通知 Follower 提交
```

### 3.4 读操作

- **线性化读（Linearizable Read，默认）**：Leader 需要确认自己仍然是 Leader（通过心跳或 ReadIndex），确保返回最新的数据，有网络 RTT 的开销
- **串行化读（Serializable Read）**：直接从本地状态机读取，可能返回稍旧的数据，但延迟更低

### 3.5 快照与日志压缩

Raft 日志会持续增长，etcd 通过快照（snapshot）机制进行日志压缩：

- 将当前状态机状态持久化为快照文件
- 截断快照点之前的日志
- 新加入或落后太多的节点直接发送完整快照，而不是大量日志

**相关配置：**

```bash
# 触发快照的 Raft 条目数（默认 100,000）
etcd --snapshot-count=100000
```

---

## 4. MVCC 与修订版本

etcd 使用**多版本并发控制（MVCC）** 存储数据，是其最重要的设计特点之一：

```
时间轴（修订版本）:
rev=1  →  put /app/config = v1
rev=2  →  put /app/config = v2
rev=3  →  delete /app/other
rev=4  →  put /app/config = v3

当前状态：/app/config = v3

历史查询：
  --rev=2  →  /app/config = v2   (时间旅行)
  --rev=1  →  /app/config = v1   (时间旅行)
```

**MVCC 的价值：**

1. **时间旅行查询**：访问历史版本的键值
2. **Watch 历史**：订阅历史变更事件
3. **无锁读**：读写操作互不阻塞（不同版本的快照读）
4. **低开销快照**：直接引用某个修订版本，无需复制数据

**版本压缩（Compaction）：**

随着时间推移，历史修订版本会占用越来越多空间，需要定期压缩：

```bash
# 手动压缩到修订版本 3
etcdctl compact 3

# 自动压缩（保留最近 1 小时的历史）
etcd --auto-compaction-retention=1
```

---

## 5. 关键术语表

| 术语 | 说明 |
|------|------|
| **Revision** | 全局单调递增的整数，每次原子变更操作递增，标识键空间的版本 |
| **Version** | 单个键在其当前 generation 内的修改次数，随每次写操作递增 |
| **Generation** | 一个键从创建到删除的生命周期，删除后重建开始新的 generation |
| **Tombstone** | 键被删除时创建的标记，version 重置为 0 |
| **Compaction** | 删除历史修订版本以释放空间的操作 |
| **Lease** | 带 TTL 的令牌，关联键在 Lease 过期时自动删除，用于实现心跳 |
| **Watch** | 订阅键或键范围的变更事件，支持历史和实时 |
| **Transaction（TXN）** | 原子执行的一组 compare-then-action 操作 |
| **Term** | Raft Leader 任期，每次选举后递增 |
| **Index** | Raft 日志条目的索引，单调递增 |
| **Quorum** | 集群的多数节点（> N/2），写操作需要 Quorum 确认 |
