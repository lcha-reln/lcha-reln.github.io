---
title: etcd - 开发指南（API 与交互）
tags:
  - etcd
  - 分布式
  - 中间件
  - API
categories:
  - 中间件
  - etcd
abbrlink: bdd76024
date: 2026-03-12 10:03:00
---

> etcd v3 API 全面指南：键值操作、Watch、Lease、事务、分布式锁，以及 etcdctl 命令行工具使用。

## 1. API 概述

etcd v3 API 基于 **gRPC** 设计，同时通过 **gRPC Gateway** 提供 HTTP/JSON REST API。

**主要 gRPC 服务：**

| 服务 | 说明 |
|------|------|
| `KV` | 键值存储的基本 CRUD 操作 |
| `Watch` | 订阅键的变更事件 |
| `Lease` | 管理键的 TTL 生命周期 |
| `Cluster` | 集群成员管理 |
| `Maintenance` | 集群维护（压缩、碎片整理、快照等） |
| `Auth` | 认证与权限控制 |
| `Lock`（concurrency）| 分布式锁 |
| `Election`（concurrency）| 分布式选举 |

**设置 API 版本：**

```bash
export ETCDCTL_API=3
```

---

## 2. 键值操作（KV）

### 2.1 写入键（Put）

```bash
# 基本写入
etcdctl put foo bar
# OK

# 写入并设置 Lease（TTL）
LEASE_ID=$(etcdctl lease grant 60 | awk '{print $2}')
etcdctl put foo1 bar1 --lease=$LEASE_ID
# OK

# 写入时显示上一个值
etcdctl put foo newbar --prev-kv
# OK
# foo
# bar
```

**gRPC API 说明：**

`Put` 请求包含字段：
- `key`：键（bytes）
- `value`：值（bytes）
- `lease`：关联的 Lease ID
- `prev_kv`：是否返回上一个值
- `ignore_value`：是否忽略 value（用于更新 Lease）
- `ignore_lease`：是否忽略 Lease（用于更新 value）

### 2.2 读取键（Get/Range）

```bash
# 读取单个键
etcdctl get foo
# foo
# bar

# 只返回值
etcdctl get foo --print-value-only
# bar

# 十六进制格式输出
etcdctl get foo --hex

# 范围查询（半开区间 [foo, foo3)）
etcdctl get foo foo3
# foo -> bar, foo1 -> bar1, foo2 -> bar2

# 前缀查询
etcdctl get --prefix foo
# 返回所有以 foo 开头的键

# 限制返回数量
etcdctl get --prefix --limit=2 foo

# 大于等于某键的所有键
etcdctl get --from-key b
# 返回键值 ≥ b 的所有键

# 统计键的数量（不返回值）
etcdctl get --prefix foo --count-only
```

### 2.3 历史版本查询

```bash
# 假设历史如下：
# revision=2: foo = bar
# revision=4: foo = bar_new

# 查询特定修订版本
etcdctl get --prefix --rev=2 foo
# 返回 revision 2 时的 foo

etcdctl get --prefix --rev=4 foo
# 返回 revision 4 时的 foo（当前最新）
```

### 2.4 删除键（Delete）

```bash
# 删除单个键
etcdctl del foo
# 1  (删除的键数量)

# 删除并返回被删除的键值
etcdctl del --prev-kv foo
# 1
# foo
# bar

# 范围删除
etcdctl del foo foo9
# 2

# 前缀删除
etcdctl del --prefix foo

# 大于等于某键的所有键
etcdctl del --from-key b
```

---

## 3. Watch（监听变更）

### 3.1 监听单个键

```bash
# 持续监听 foo 的变化
etcdctl watch foo

# 监听前缀（所有以 foo 开头的键）
etcdctl watch --prefix foo

# 监听并执行命令（每次变更时执行）
etcdctl watch foo -- echo "foo changed"
```

### 3.2 监听历史变更

```bash
# 从 revision 2 开始监听（包含历史事件）
etcdctl watch --rev=2 foo
```

### 3.3 进度通知（Progress Notification）

Watch 流可以请求进度通知，告知当前已交付事件到达的修订版本：

```bash
etcdctl watch --progress-notify foo
```

### 3.4 压缩修订版本

若 Watch 从已被压缩的修订版本开始，会返回 `ErrCompacted` 错误：

```bash
# 先压缩到 revision 10
etcdctl compact 10

# 从 revision 5 开始 watch 会报错
etcdctl watch --rev=5 foo
# Error: required revision has been compacted
```

---

## 4. Lease（租约）

Lease 是 etcd 提供的 TTL 机制，用于实现键的自动过期，常用于心跳检测和分布式锁的自动释放。

### 4.1 创建租约

```bash
# 创建 60 秒 TTL 的租约
etcdctl lease grant 60
# lease 694d71ddacfda227 granted with TTL(60s)

LEASE_ID="694d71ddacfda227"
```

### 4.2 绑定键到租约

```bash
# 将键绑定到租约（租约到期时键自动删除）
etcdctl put foo bar --lease=$LEASE_ID
```

### 4.3 续约（Keep-Alive）

```bash
# 持续刷新租约（直到手动终止）
etcdctl lease keep-alive $LEASE_ID
# lease 694d71ddacfda227 keepalived with TTL(60), new expiry 1633...

# 程序应定期（如每 TTL/3 秒）发送 keep-alive
```

### 4.4 查询租约信息

```bash
etcdctl lease timetolive $LEASE_ID
# lease 694d71ddacfda227 granted with TTL(60s), remaining(52s)

# 显示绑定到该租约的所有键
etcdctl lease timetolive --keys $LEASE_ID
# lease 694d71ddacfda227 granted with TTL(60s), remaining(52s), attached keys([foo])
```

### 4.5 撤销租约

```bash
# 撤销租约（同时删除所有绑定的键）
etcdctl lease revoke $LEASE_ID
# lease 694d71ddacfda227 revoked
```

---

## 5. 事务（Transaction）

etcd 支持原子的 **compare-and-swap** 事务，格式为：

```
Txn(
  If  <条件列表>,
  Then <成功操作列表>,
  Else <失败操作列表>
)
```

### 5.1 命令行事务

```bash
etcdctl txn <<EOF
compares:
value("foo") = "bar"

success requests (get, put, del):
put foo baz

failure requests (get, put, del):
put foo abc
EOF
```

或使用 `--interactive=false`：

```bash
printf 'compares:\nvalue("foo") = "bar"\n\nsuccess:\nput foo baz\n\nfailure:\nput foo abc\n' | etcdctl txn
```

### 5.2 事务用例：CAS（Compare-And-Swap）

```bash
# 只有当 foo 的值为 "old_value" 时才更新
etcdctl txn <<EOF
compares:
value("foo") = "old_value"

success requests:
put foo new_value

failure requests:
get foo
EOF
```

### 5.3 事务用例：乐观锁

```bash
# 获取当前版本号
VERSION=$(etcdctl get foo --write-out=json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['kvs'][0]['version'])")

# 只有当版本匹配时才更新（乐观锁）
etcdctl txn <<EOF
compares:
version("foo") = $VERSION

success requests:
put foo updated_value

failure requests:
get foo
EOF
```

---

## 6. 分布式锁

etcd 提供了基于 Lease 的分布式互斥锁实现。

### 6.1 命令行锁

```bash
# 获取锁 mylock（阻塞直到获取成功）
etcdctl lock mylock

# 获取锁并执行命令（命令完成后自动释放锁）
etcdctl lock mylock -- echo "critical section"

# 超时锁（5 秒未获取则放弃）
etcdctl lock --ttl=5 mylock -- bash -c "echo 'do work'; sleep 3"
```

### 6.2 分布式锁原理

```
1. 在 /locks/<name>/ 下创建带前缀的临时键（绑定 Lease）
   如：/locks/mylock/abc123   （当前持有者）
       /locks/mylock/def456   （等待者1）

2. 检查自己创建的键是否是最小（最先创建）的
   - 是：获取锁
   - 否：Watch 比自己小的键，等待其删除

3. 释放锁：删除自己创建的键（或 Lease 过期自动删除）
```

---

## 7. 分布式选举

etcd 提供了 Leader 选举原语：

```bash
# 参与选举（阻塞直到成为 Leader）
etcdctl elect myelection proposal1

# 另一个候选者
etcdctl elect myelection proposal2

# 查看当前 Leader
etcdctl elect --observe myelection
```

**选举原理：**

与分布式锁类似，但使用了 Campaign（竞选）语义：

1. 每个候选者在 `/elections/<name>/` 下创建带 Lease 的键
2. 键值最小（zxid 最小）的候选者成为 Leader
3. Leader 失去 Lease 后，其他候选者竞争成为新 Leader

---

## 8. gRPC Gateway（HTTP/JSON API）

etcd 提供了 gRPC gateway，允许通过 HTTP/JSON 调用 gRPC API：

```bash
# 写入键
curl http://localhost:2379/v3/kv/put \
  -X POST \
  -d '{"key": "Zm9v", "value": "YmFy"}'
# key 和 value 使用 base64 编码
# "foo" = "Zm9v", "bar" = "YmFy"

# 读取键
curl http://localhost:2379/v3/kv/range \
  -X POST \
  -d '{"key": "Zm9v"}'

# 创建 Lease
curl http://localhost:2379/v3/lease/grant \
  -X POST \
  -d '{"TTL": 60}'
```

**base64 编解码：**

```bash
echo -n "foo" | base64   # Zm9v
echo -n "bar" | base64   # YmFy
echo "Zm9v" | base64 -d  # foo
```

---

## 9. 系统限制

| 限制项 | 默认值 | 说明 |
|--------|--------|------|
| 请求体大小 | 1.5 MiB | 单个请求最大大小 |
| 存储大小 | 2 GiB | 默认配额（可通过 `--quota-backend-bytes` 调整，最大 8 GiB） |
| 键/值大小 | 1 MiB | 单个键或值的最大大小 |
| Watch 数量 | 无硬限制 | 过多 Watch 会增加内存使用 |

**调整存储配额：**

```bash
# 设置 8 GB 存储配额
etcd --quota-backend-bytes=$((8*1024*1024*1024))
```

---

## 10. Go 客户端示例

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
)

func main() {
    // 创建连接
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"localhost:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        log.Fatal(err)
    }
    defer cli.Close()

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // 写入键值
    _, err = cli.Put(ctx, "foo", "bar")
    if err != nil {
        log.Fatal(err)
    }

    // 读取键值
    resp, err := cli.Get(ctx, "foo")
    if err != nil {
        log.Fatal(err)
    }
    for _, kv := range resp.Kvs {
        fmt.Printf("Key: %s, Value: %s\n", kv.Key, kv.Value)
    }

    // Watch 键变化
    watchCh := cli.Watch(context.Background(), "foo")
    go func() {
        for watchResp := range watchCh {
            for _, event := range watchResp.Events {
                fmt.Printf("Event: %s, Key: %s, Value: %s\n",
                    event.Type, event.Kv.Key, event.Kv.Value)
            }
        }
    }()

    // 创建 Lease
    leaseResp, err := cli.Grant(ctx, 60)
    if err != nil {
        log.Fatal(err)
    }
    leaseID := leaseResp.ID

    // 绑定 Lease 到键
    _, err = cli.Put(ctx, "temp-key", "temp-value", clientv3.WithLease(leaseID))
    if err != nil {
        log.Fatal(err)
    }

    // 事务
    kvc := clientv3.NewKV(cli)
    _, err = kvc.Txn(ctx).
        If(clientv3.Compare(clientv3.Value("foo"), "=", "bar")).
        Then(clientv3.OpPut("foo", "baz")).
        Else(clientv3.OpGet("foo")).
        Commit()
    if err != nil {
        log.Fatal(err)
    }

    // 分布式锁
    session, err := concurrency.NewSession(cli)
    if err != nil {
        log.Fatal(err)
    }
    defer session.Close()

    mutex := concurrency.NewMutex(session, "/my-lock/")
    if err := mutex.Lock(context.Background()); err != nil {
        log.Fatal(err)
    }
    fmt.Println("Got the lock")
    // 执行临界区操作...
    if err := mutex.Unlock(context.Background()); err != nil {
        log.Fatal(err)
    }
}
```

---

## 11. etcdctl 快速参考

```bash
# 键值操作
etcdctl put <key> <value>
etcdctl get <key>
etcdctl get --prefix <prefix>
etcdctl get --from-key <key>
etcdctl del <key>
etcdctl del --prefix <prefix>

# 历史操作
etcdctl get --rev=<revision> <key>
etcdctl watch --rev=<revision> <key>
etcdctl compact <revision>

# Lease 操作
etcdctl lease grant <ttl>
etcdctl lease revoke <id>
etcdctl lease keep-alive <id>
etcdctl lease timetolive --keys <id>

# 集群操作
etcdctl member list
etcdctl member add <name> --peer-urls=<urls>
etcdctl member remove <id>
etcdctl endpoint health
etcdctl endpoint status --write-out=table

# 快照
etcdctl snapshot save <file>
etcdctl snapshot restore <file> [flags]
etcdctl snapshot status <file> --write-out=table

# 维护
etcdctl compact <revision>
etcdctl defrag
etcdctl alarm list
etcdctl alarm disarm
```
