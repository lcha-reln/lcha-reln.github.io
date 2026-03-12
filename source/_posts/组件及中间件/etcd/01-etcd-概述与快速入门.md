---
title: etcd - 概述与快速入门
date: 2026-03-12 10:00:00
tags:
  - etcd
  - 分布式
  - 中间件
categories:
  - 中间件
  - etcd
---

> 基于 etcd v3.5 官方文档整理。etcd 是 CoreOS 开发的高可用、强一致性的分布式键值存储系统，被 Kubernetes 用作集群状态存储的核心组件。

## 1. etcd 是什么

etcd 的名称来源于两个概念：Unix 的 `/etc` 目录（存储单机配置数据）和 **d**istributed（分布式）。`/etc` 是存储单台机器配置数据的地方，而 etcd 存储大规模分布式系统的配置信息，因此 **分布式的 `/etc`** 即为 **etcd**。

etcd 被设计为大规模分布式系统的通用基础设施，这些系统绝不能容忍脑裂（split-brain）操作，并愿意为此牺牲一定的可用性。etcd 以一致且容错的方式存储元数据，旨在提供**最佳稳定性、可靠性、可扩展性和性能**的键值存储服务。

**典型使用场景：**

- **Kubernetes**：将集群状态（所有资源对象）存储到 etcd 中进行服务发现和集群管理；使用 etcd 的 Watch API 监控集群并推出关键配置变更
- **Container Linux (CoreOS)**：使用 locksmith 基于 etcd 实现分布式信号量，协调集群节点的自动无停机内核更新
- **配置管理**：分布式系统的配置中心
- **服务发现**：动态注册和发现服务实例
- **分布式协调**：实现分布式锁、Leader 选举、队列等原语

---

## 2. 核心特性

| 特性 | 说明 |
|------|------|
| **简单接口** | 通过标准 HTTP/JSON API（gRPC gateway）或 gRPC API 读写键值 |
| **键值存储** | 将数据以目录层级方式存储，观察者可以监视单个键或目录的变化 |
| **Watch 机制** | 客户端可监听键的变化，实时推送变更通知 |
| **安全可靠** | 可选使用 SSL 客户端证书进行身份验证，使用 Raft 协议保证强一致性 |
| **高性能** | 基准测试每秒可写入 10,000 次 |
| **多版本并发控制（MVCC）** | 保留每个键的历史版本，支持时间旅行查询 |
| **事务** | 支持原子的多键读写事务（compare-and-swap） |
| **租约（Lease）** | 键可关联 TTL 租约，租约过期则键自动删除，用于心跳检测 |

---

## 3. 与其他键值存储的对比

| 对比项 | etcd | ZooKeeper | Consul | NewSQL |
|--------|------|-----------|--------|--------|
| **并发原语** | Lock RPC、Election RPC、命令行锁/选举 | 外部 Curator（Java）| 原生 Lock API | 极少 |
| **线性化读** | 是 | 否 | 是 | 部分 |
| **多版本并发控制** | 是 | 否 | 否 | 部分 |
| **事务** | 字段比较 + 读 + 写 | 版本检查 + 写 | 字段比较 + 锁 + 读 + 写 | SQL 风格 |
| **变更通知** | 历史和当前键区间 | 当前键和目录 | 当前键和前缀 | 触发器（部分） |
| **用户权限** | 基于角色（RBAC）| ACL | ACL | 各异 |
| **HTTP/JSON API** | 是 | 否 | 是 | 极少 |
| **成员重配置** | 是 | ≥3.5.0 | 是 | 是 |
| **最大可靠数据库大小** | 数 GB | 数百 MB（偶尔数 GB）| 数百 MB | TB 级 |

**etcd vs ZooKeeper：**

- etcd 原生支持 gRPC，ZooKeeper 需要通过外部库（如 Curator）使用
- etcd 支持多版本并发控制（MVCC），ZooKeeper 不支持
- etcd 支持线性化读，ZooKeeper 默认不支持
- etcd 的 Watch 支持历史版本区间查询；ZooKeeper Watch 是一次性的
- etcd 使用基于角色的访问控制（RBAC）；ZooKeeper 使用 ACL
- etcd 支持 HTTP/JSON API，ZooKeeper 不支持

**etcd vs Consul：**

- Consul 是一套完整的服务网格解决方案（含服务发现、健康检查等），etcd 专注于键值存储和协调
- 两者都支持线性化读、变更通知、RBAC/ACL
- etcd 的 MVCC 比 Consul 更完整

---

## 4. 快速入门

### 4.1 安装

从官方 GitHub Releases 下载预编译的二进制文件：[https://github.com/etcd-io/etcd/releases](https://github.com/etcd-io/etcd/releases)

或通过包管理器安装：

```bash
# macOS
brew install etcd

# 手动下载并解压（以 Linux amd64 为例）
ETCD_VER=v3.5.0
curl -L https://github.com/etcd-io/etcd/releases/download/${ETCD_VER}/etcd-${ETCD_VER}-linux-amd64.tar.gz | tar xz
mv etcd-${ETCD_VER}-linux-amd64/etcd* /usr/local/bin/
```

验证安装：

```bash
etcd --version
etcdctl version
```

### 4.2 启动单节点 etcd

```bash
# 直接启动（默认监听 localhost:2379）
etcd
```

输出的 info 级别日志可以忽略，etcd 正常运行中。

### 4.3 基本键值操作

在**另一个终端**中，使用 `etcdctl` 与 etcd 交互：

```bash
# 设置 API 版本为 v3（推荐）
export ETCDCTL_API=3

# 写入键值
etcdctl put greeting "Hello, etcd"
# OK

# 读取键值
etcdctl get greeting
# greeting
# Hello, etcd

# 只返回值（不返回键名）
etcdctl get greeting --print-value-only
# Hello, etcd

# 删除键
etcdctl del greeting
# 1
```

### 4.4 etcdctl 版本查询

```bash
etcdctl version
# etcdctl version: 3.5.0
# API version: 3.5
```

> **注意**：通过环境变量 `ETCDCTL_API=3` 设置使用 v3 API（推荐）。v2 API 创建的键无法通过 v3 API 查询。

---

## 5. 端口说明

| 端口 | 用途 |
|------|------|
| `2379` | 客户端通信端口（Client API） |
| `2380` | 集群节点间通信端口（Peer API） |

---

## 6. 下一步

- **了解原理**：[etcd 核心概念与数据模型](./02-etcd-核心概念与数据模型.md)
- **搭建集群**：[etcd 集群安装与运维](./03-etcd-集群安装与运维.md)
- **API 使用**：[etcd 开发指南](./04-etcd-开发指南.md)
- **生产加固**：[etcd 安全、监控与维护](./05-etcd-安全监控与维护.md)
