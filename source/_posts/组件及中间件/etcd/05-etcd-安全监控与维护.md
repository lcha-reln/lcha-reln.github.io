---
title: etcd - 安全、监控与维护
date: 2026-03-12 10:04:00
tags:
  - etcd
  - 分布式
  - 中间件
  - 安全
  - 运维
categories:
  - 中间件
  - etcd
---

> etcd 传输安全（TLS）、RBAC 权限控制、Prometheus 监控指标、集群维护（压缩、碎片整理、备份）和性能调优。

## 1. 传输安全（TLS）

etcd 支持通过 TLS 协议对以下两类通信进行加密：

| 通信类型 | 说明 |
|---------|------|
| **客户端到服务端** | `etcdctl`、应用客户端与 etcd 节点之间 |
| **节点间通信（Peer）** | etcd 集群节点之间的复制通信 |

> ⚠️ **注意：** etcd 默认**不启用**安全特性，以降低初始使用门槛。未启用安全特性的 etcd 集群会将数据暴露给任何客户端。**生产环境务必启用 TLS。**

### 1.1 TLS 配置参数

**客户端到服务端：**

```bash
--cert-file=<path>          # 服务端 TLS 证书（客户端连接时验证）
--key-file=<path>           # 服务端私钥（必须未加密）
--client-cert-auth          # 要求客户端提供证书（双向 TLS）
--trusted-ca-file=<path>    # 信任的 CA 证书（用于验证客户端证书）
--auto-tls                  # 自动生成自签名证书（仅用于测试）
```

**节点间通信（Peer）：**

```bash
--peer-cert-file=<path>         # Peer 通信证书
--peer-key-file=<path>          # Peer 通信私钥
--peer-client-cert-auth         # 要求 Peer 提供证书
--peer-trusted-ca-file=<path>   # 信任的 Peer CA 证书
--peer-auto-tls                 # 自动生成 Peer 自签名证书
```

**通用 TLS 参数：**

```bash
--cipher-suites         # 允许的 TLS 密码套件（逗号分隔）
--tls-min-version       # 最低 TLS 版本（如 TLS1.2、TLS1.3）
--tls-max-version       # 最高 TLS 版本
```

### 1.2 示例一：单向 TLS（HTTPS）

仅加密传输，不验证客户端身份：

```bash
etcd --name infra0 --data-dir infra0 \
  --cert-file=/path/to/server.crt \
  --key-file=/path/to/server.key \
  --advertise-client-urls https://127.0.0.1:2379 \
  --listen-client-urls https://127.0.0.1:2379
```

客户端连接：

```bash
etcdctl --cacert=/path/to/ca.crt \
  --endpoints=https://127.0.0.1:2379 \
  get foo
```

### 1.3 示例二：双向 TLS（mTLS）

服务端验证客户端证书，实现双向认证：

```bash
etcd --name infra0 \
  --cert-file=/path/to/server.crt \
  --key-file=/path/to/server.key \
  --client-cert-auth \
  --trusted-ca-file=/path/to/ca.crt \
  --advertise-client-urls https://127.0.0.1:2379 \
  --listen-client-urls https://127.0.0.1:2379
```

客户端连接（需提供客户端证书）：

```bash
etcdctl --cacert=/path/to/ca.crt \
  --cert=/path/to/client.crt \
  --key=/path/to/client.key \
  --endpoints=https://127.0.0.1:2379 \
  get foo
```

### 1.4 示例三：集群 TLS（含 Peer 加密）

```bash
etcd --name infra0 \
  --initial-advertise-peer-urls https://10.0.1.10:2380 \
  --listen-peer-urls https://10.0.1.10:2380 \
  --listen-client-urls https://10.0.1.10:2379,https://127.0.0.1:2379 \
  --advertise-client-urls https://10.0.1.10:2379 \
  # 客户端 TLS
  --cert-file=/path/to/server.crt \
  --key-file=/path/to/server.key \
  --client-cert-auth \
  --trusted-ca-file=/path/to/ca.crt \
  # Peer TLS
  --peer-cert-file=/path/to/peer.crt \
  --peer-key-file=/path/to/peer.key \
  --peer-client-cert-auth \
  --peer-trusted-ca-file=/path/to/ca.crt \
  # 集群参数
  --initial-cluster infra0=https://10.0.1.10:2380,...
```

### 1.5 自动 TLS（测试环境）

```bash
etcd --auto-tls --peer-auto-tls
```

> ⚠️ 仅用于开发/测试，**不要在生产环境中使用**。

---

## 2. 基于角色的访问控制（RBAC）

etcd v3 支持完整的 RBAC 权限模型：**用户（User）→ 角色（Role）→ 权限（Permission）**。

### 2.1 认证模型

etcd 提供以下认证方式：
- **密码认证**：用户名 + 密码
- **证书认证**：TLS 客户端证书的 Common Name 作为用户名

### 2.2 启用认证

```bash
# 1. 创建 root 用户（必须在启用认证前完成）
etcdctl user add root
# Enter password:

# 2. 为 root 授予 root 角色（内置，拥有所有权限）
etcdctl user grant-role root root

# 3. 启用认证
etcdctl auth enable
# Authentication Enabled

# 4. 后续操作需要认证
etcdctl --user root:<password> get foo
# 或通过环境变量
export ETCD_USER=root
export ETCD_PASSWORD=<password>
```

### 2.3 用户管理

```bash
# 创建用户
etcdctl --user root:<pwd> user add alice
etcdctl --user root:<pwd> user add bob

# 查看用户列表
etcdctl --user root:<pwd> user list

# 删除用户
etcdctl --user root:<pwd> user delete alice

# 修改密码
etcdctl --user root:<pwd> user passwd alice

# 查看用户角色
etcdctl --user root:<pwd> user get alice
```

### 2.4 角色管理

```bash
# 创建角色
etcdctl --user root:<pwd> role add reader
etcdctl --user root:<pwd> role add writer
etcdctl --user root:<pwd> role add admin

# 查看角色列表
etcdctl --user root:<pwd> role list

# 删除角色
etcdctl --user root:<pwd> role delete reader
```

### 2.5 权限设置

etcd 的权限针对**键或键范围**设置，分为 `read`、`write`、`readwrite` 三种：

```bash
# 授予角色对键 /foo 的读权限
etcdctl --user root:<pwd> role grant-permission reader read /foo

# 授予角色对前缀 /app/ 下所有键的读写权限
etcdctl --user root:<pwd> role grant-permission admin readwrite /app/ --prefix

# 授予角色对键范围 [/app/a, /app/z) 的写权限
etcdctl --user root:<pwd> role grant-permission writer write /app/a /app/z

# 授予角色对所有键的读写权限（即 root 级别）
etcdctl --user root:<pwd> role grant-permission admin readwrite "" --prefix

# 查看角色权限
etcdctl --user root:<pwd> role get reader

# 撤销角色权限
etcdctl --user root:<pwd> role revoke-permission reader /foo
```

### 2.6 绑定用户和角色

```bash
# 将角色授予用户
etcdctl --user root:<pwd> user grant-role alice reader
etcdctl --user root:<pwd> user grant-role bob writer

# 撤销用户角色
etcdctl --user root:<pwd> user revoke-role alice reader
```

### 2.7 禁用认证

```bash
etcdctl --user root:<pwd> auth disable
```

---

## 3. 监控

### 3.1 Prometheus 指标

etcd 暴露了丰富的 Prometheus 指标，默认在 `http://localhost:2379/metrics` 可访问：

```bash
curl http://localhost:2379/metrics
```

**关键监控指标分类：**

**集群健康：**

| 指标 | 说明 |
|------|------|
| `etcd_server_has_leader` | 节点是否有 Leader（1=有，0=无）|
| `etcd_server_leader_changes_seen_total` | Leader 变更总次数 |
| `etcd_server_proposals_failed_total` | 失败的 Raft Proposal 数 |
| `etcd_server_proposals_committed_total` | 已提交的 Raft Proposal 数 |
| `etcd_server_proposals_pending` | 待处理的 Raft Proposal 数 |

**磁盘性能（最关键）：**

| 指标 | 说明 |
|------|------|
| `etcd_disk_wal_fsync_duration_seconds` | WAL fsync 延迟（p99 应 < 10ms）|
| `etcd_disk_backend_commit_duration_seconds` | 后端 commit 延迟（p99 应 < 25ms）|
| `etcd_disk_defrag_duration_seconds` | 碎片整理耗时 |

**网络：**

| 指标 | 说明 |
|------|------|
| `etcd_network_peer_round_trip_time_seconds` | Peer 之间的 RTT |
| `etcd_network_client_grpc_received_bytes_total` | 接收的客户端请求字节数 |
| `etcd_network_client_grpc_sent_bytes_total` | 发送给客户端的字节数 |

**存储：**

| 指标 | 说明 |
|------|------|
| `etcd_mvcc_db_total_size_in_bytes` | 当前 B+ 树数据库大小（含历史版本）|
| `etcd_mvcc_db_total_size_in_use_in_bytes` | 实际使用的数据库大小 |
| `etcd_mvcc_delete_total` | 删除操作总次数 |
| `etcd_mvcc_put_total` | Put 操作总次数 |
| `etcd_mvcc_range_total` | Range 查询总次数 |

**Watcher：**

| 指标 | 说明 |
|------|------|
| `etcd_debugging_mvcc_watcher_total` | Watch 流总数 |
| `etcd_debugging_mvcc_slow_watcher_total` | 慢速 Watch 数 |

### 3.2 Prometheus 配置

```yaml
# prometheus.yml
scrape_configs:
  - job_name: etcd
    static_configs:
      - targets:
          - '10.0.1.10:2379'
          - '10.0.1.11:2379'
          - '10.0.1.12:2379'
    scheme: https
    tls_config:
      ca_file: /path/to/ca.crt
      cert_file: /path/to/client.crt
      key_file: /path/to/client.key
```

### 3.3 Grafana Dashboard

官方提供了 Grafana Dashboard，Dashboard ID: **3070**（etcd by Prometheus）

关键告警规则建议：

```yaml
# 高 Raft 提案失败率
- alert: EtcdHighNumberOfFailedProposals
  expr: rate(etcd_server_proposals_failed_total[5m]) > 0.05
  for: 5m

# 磁盘 fsync 延迟高
- alert: EtcdHighFsyncDuration
  expr: histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) > 0.5

# 没有 Leader
- alert: EtcdNoLeader
  expr: etcd_server_has_leader == 0
  for: 1m

# 存储空间使用率高
- alert: EtcdHighStorageUsage
  expr: etcd_mvcc_db_total_size_in_bytes / etcd_mvcc_db_total_size_in_use_in_bytes > 0.8
```

---

## 4. 维护操作

### 4.1 历史压缩（Compaction）

etcd 保存完整的键空间历史，需要定期压缩防止存储耗尽：

**手动压缩：**

```bash
# 压缩到当前最新修订版本（只保留最新状态）
REV=$(etcdctl endpoint status --write-out json | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Status']['header']['revision'])")
etcdctl compact $REV
```

**自动压缩（推荐）：**

```bash
# 保留最近 1 小时的历史
etcd --auto-compaction-retention=1

# 保留最近 5 分钟（适用于 v3.4+ 的 periodic 模式）
etcd --auto-compaction-mode=periodic --auto-compaction-retention=5m

# 基于修订版本数量（保留最近 1000 个修订版本）
etcd --auto-compaction-mode=revision --auto-compaction-retention=1000
```

**自动压缩模式说明：**

| 模式 | 参数 | 说明 |
|------|------|------|
| `periodic`（默认）| 小时数或时间字符串 | 按时间窗口保留历史，如 `1h`、`5m` |
| `revision` | 修订版本数量 | 保留最近 N 个修订版本 |

### 4.2 碎片整理（Defragmentation）

压缩只是在逻辑上标记数据为可用，物理空间需要碎片整理才能释放：

```bash
# 对单个节点进行碎片整理
etcdctl defrag --endpoints=10.0.1.10:2379

# 对所有节点进行碎片整理
etcdctl defrag --endpoints=10.0.1.10:2379,10.0.1.11:2379,10.0.1.12:2379
```

> ⚠️ 碎片整理会**阻塞**该节点上的读写操作，建议：
> - 逐节点进行（避免影响集群可用性）
> - 先对 Follower 节点整理，最后再对 Leader 节点整理
> - 在低峰期执行

**整理效果验证：**

```bash
# 整理前后对比
etcdctl endpoint status --write-out=table
# 对比 DB SIZE 列
```

### 4.3 存储配额管理

当存储超出配额，etcd 会触发 `NOSPACE` 告警，集群进入只读模式：

```bash
# 查看告警
etcdctl alarm list

# 清除告警（在压缩和碎片整理后执行）
etcdctl alarm disarm
```

**建议配额设置：**

```bash
# 生产环境建议设置 8 GB（最大值）
etcd --quota-backend-bytes=$((8*1024*1024*1024))
```

### 4.4 快照备份

**创建快照：**

```bash
# 备份到本地文件
etcdctl snapshot save /backup/etcd-snapshot-$(date +%Y%m%d).db

# 验证快照
etcdctl snapshot status /backup/etcd-snapshot-20260312.db --write-out=table
# +----------+----------+------------+------------+
# |   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
# +----------+----------+------------+------------+
# | 59fc7d5a |        6 |         25 |      25 kB |
# +----------+----------+------------+------------+
```

**从快照恢复：**

```bash
# 在每个节点上（使用不同的 --name 和 --initial-advertise-peer-urls）
etcdctl snapshot restore snapshot.db \
  --name infra0 \
  --initial-cluster infra0=http://10.0.1.10:2380,infra1=http://10.0.1.11:2380,infra2=http://10.0.1.12:2380 \
  --initial-cluster-token etcd-cluster-restored \
  --initial-advertise-peer-urls http://10.0.1.10:2380 \
  --data-dir /var/lib/etcd-restored

# 使用恢复的数据目录启动 etcd
etcd --data-dir=/var/lib/etcd-restored [其他参数...]
```

**自动备份脚本示例（cron）：**

```bash
#!/bin/bash
BACKUP_DIR="/backup/etcd"
ENDPOINTS="https://10.0.1.10:2379"
CERT_DIR="/etc/etcd/certs"
RETENTION_DAYS=7

mkdir -p $BACKUP_DIR
DATE=$(date +%Y%m%d-%H%M%S)

etcdctl snapshot save $BACKUP_DIR/etcd-$DATE.db \
  --endpoints=$ENDPOINTS \
  --cacert=$CERT_DIR/ca.crt \
  --cert=$CERT_DIR/client.crt \
  --key=$CERT_DIR/client.key

# 删除超过保留期的备份
find $BACKUP_DIR -name "etcd-*.db" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: etcd-$DATE.db"
```

---

## 5. 性能调优

### 5.1 磁盘 I/O 优化

etcd 的性能瓶颈通常在磁盘 I/O，特别是 WAL fsync：

```bash
# 检查磁盘 fsync 延迟（p99 应 < 10ms）
etcdctl check perf

# 使用 fio 测试磁盘顺序写性能
fio --rw=write --ioengine=sync --fdatasync=1 --directory=/var/lib/etcd --size=22m --bs=2300 --name=mytest
# 10ms 以内为合格，1ms 以内为优秀
```

**Linux 磁盘调优：**

```bash
# 对于 SSD，推荐使用 noop/none 调度器
echo noop > /sys/block/sda/queue/scheduler

# 对于 HDD，推荐 deadline 调度器
echo deadline > /sys/block/sda/queue/scheduler
```

### 5.2 网络延迟调优

```bash
# 调整心跳间隔和选举超时（适应高延迟网络）
etcd --heartbeat-interval=500 \    # 500ms
     --election-timeout=5000        # 5000ms（建议 = 10x heartbeat）
```

**网络延迟建议：**

| 节点间 RTT | 建议配置 |
|-----------|---------|
| < 1ms（同数据中心）| heartbeat=100ms, election=1000ms（默认）|
| 1-10ms（不同可用区）| heartbeat=250ms, election=2500ms |
| 10-100ms（跨地域）| heartbeat=500ms, election=5000ms |

### 5.3 Snapshot 调优

```bash
# 减少内存中保留的 Raft 条目数（降低内存使用，但慢节点追赶时间更短）
etcd --snapshot-count=10000

# 增加（更高内存，慢节点有更长时间追赶）
etcd --snapshot-count=500000
```

### 5.4 gRPC 并发调优

```bash
# 调整 gRPC 并发请求限制
etcd --max-concurrent-streams=1000
etcd --grpc-keepalive-timeout=30s
```

---

## 6. 常见运维问题

### 6.1 节点磁盘满

```bash
# 1. 快速压缩以释放空间
etcdctl compact $(etcdctl endpoint status --write-out json | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Status']['header']['revision'])")

# 2. 碎片整理
etcdctl defrag

# 3. 解除 NOSPACE 告警
etcdctl alarm disarm

# 4. 临时增加配额（需重启 etcd）
etcd --quota-backend-bytes=$((8*1024*1024*1024))
```

### 6.2 节点时钟偏差

etcd 对时钟偏差敏感（影响选举超时），建议：

```bash
# 安装并配置 NTP/Chrony
timedatectl set-ntp true
chronyc tracking

# 检查节点间时钟偏差（应 < 1 秒）
```

### 6.3 Learner 成员（v3.4+）

Learner（学习者）是一种不参与投票的特殊成员，用于安全地添加新节点：

```bash
# 添加 Learner 成员（不影响集群 Quorum）
etcdctl member add infra3 --peer-urls=http://10.0.1.13:2380 --learner

# 当 Learner 追上进度后，将其提升为正式成员
etcdctl member promote <learner-member-id>
```

**Learner 的使用场景：**

- 添加新节点时先以 Learner 身份加入，追上数据后再提升，避免影响集群可用性
- 跨地域部署时，远程数据中心节点可先以 Learner 运行

---

## 7. 安全加固检查列表

| 项目 | 状态 | 说明 |
|------|------|------|
| 启用 TLS 客户端加密 | 必须 | 所有客户端通信使用 HTTPS |
| 启用 TLS Peer 加密 | 必须 | 节点间通信加密 |
| 启用双向 TLS（mTLS）| 推荐 | 验证客户端身份 |
| 启用 RBAC 认证 | 推荐 | 限制访问权限 |
| 设置存储配额 | 必须 | 防止存储耗尽 |
| 启用自动压缩 | 必须 | 防止历史数据无限增长 |
| 定期快照备份 | 必须 | 数据恢复保障 |
| 独立 SSD 存储 | 强烈推荐 | etcd WAL 和数据目录使用专用 SSD |
| NTP 时间同步 | 必须 | 防止时钟偏差影响选举 |
| 监控 Prometheus 指标 | 推荐 | 实时感知集群健康状态 |
| 限制网络访问 | 推荐 | 防火墙仅允许授权主机访问 2379/2380 端口 |
