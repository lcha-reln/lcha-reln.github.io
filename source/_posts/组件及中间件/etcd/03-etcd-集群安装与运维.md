---
title: etcd - 集群安装与运维
date: 2026-03-12 10:02:00
tags:
  - etcd
  - 分布式
  - 中间件
  - 运维
categories:
  - 中间件
  - etcd
---

> etcd 集群的三种引导方式（静态、etcd 服务发现、DNS 发现）、硬件建议和运行时动态配置。

## 1. 集群规划

### 1.1 节点数量建议

etcd 集群要求**奇数**节点，最小生产部署为 **3 节点**：

| 集群大小 | 容错节点数 | 是否推荐 |
|---------|---------|---------|
| 1 节点 | 0 | 仅用于开发/测试 |
| 3 节点 | 1 | 最小生产部署 |
| 5 节点 | 2 | 推荐生产部署 |
| 7 节点 | 3 | 高容错需求 |

> 节点数越多，写性能越低（需要更多节点确认）。大多数场景下 5 节点已足够。

### 1.2 硬件建议

**CPU：**
- 小型集群（< 50 requests/s）：1 vCPU 即可
- 中型集群（50-200 requests/s）：2-4 vCPU
- 大型集群（> 200 requests/s）：8+ vCPU（Leader 专用）

**内存：**
- 小型/中型：8 GB
- 大型：16+ GB

> etcd 的内存使用量与 watch 的数量成正比。一般来说，etcd 8 GB 内存足够大多数场景。

**存储（最关键）：**

etcd 对 I/O 延迟非常敏感，尤其是 Raft 日志写入：

| 存储类型 | 顺序写 IOPS | 是否推荐 |
|---------|-----------|---------|
| HDD | ~200 IOPS | 不推荐 |
| SSD | 1000-10000 IOPS | 推荐 |
| NVMe SSD | 10000+ IOPS | 最佳选择 |

**网络：**
- 节点间：1 GbE（小型），10 GbE（大型）
- 客户端到集群：1 GbE+

**存储配置建议：**
- 将 etcd `data-dir`（WAL 日志和快照）与系统磁盘分离，使用独立的 SSD
- 设置合适的 I/O 调度器（建议 `deadline` 或 `noop`）

---

## 2. 集群引导（Bootstrap）

### 2.1 方式一：静态引导（Static）

已知所有集群成员地址时使用，无需外部服务。

**示例集群规划（3 节点）：**

| 节点名 | IP | 主机名 |
|--------|------|--------|
| infra0 | 10.0.1.10 | infra0.example.com |
| infra1 | 10.0.1.11 | infra1.example.com |
| infra2 | 10.0.1.12 | infra2.example.com |

**在每台机器上分别启动 etcd：**

```bash
# infra0 节点
etcd --name infra0 \
  --initial-advertise-peer-urls http://10.0.1.10:2380 \
  --listen-peer-urls http://10.0.1.10:2380 \
  --listen-client-urls http://10.0.1.10:2379,http://127.0.0.1:2379 \
  --advertise-client-urls http://10.0.1.10:2379 \
  --initial-cluster-token etcd-cluster-1 \
  --initial-cluster infra0=http://10.0.1.10:2380,infra1=http://10.0.1.11:2380,infra2=http://10.0.1.12:2380 \
  --initial-cluster-state new

# infra1 节点
etcd --name infra1 \
  --initial-advertise-peer-urls http://10.0.1.11:2380 \
  --listen-peer-urls http://10.0.1.11:2380 \
  --listen-client-urls http://10.0.1.11:2379,http://127.0.0.1:2379 \
  --advertise-client-urls http://10.0.1.11:2379 \
  --initial-cluster-token etcd-cluster-1 \
  --initial-cluster infra0=http://10.0.1.10:2380,infra1=http://10.0.1.11:2380,infra2=http://10.0.1.12:2380 \
  --initial-cluster-state new

# infra2 节点
etcd --name infra2 \
  --initial-advertise-peer-urls http://10.0.1.12:2380 \
  --listen-peer-urls http://10.0.1.12:2380 \
  --listen-client-urls http://10.0.1.12:2379,http://127.0.0.1:2379 \
  --advertise-client-urls http://10.0.1.12:2379 \
  --initial-cluster-token etcd-cluster-1 \
  --initial-cluster infra0=http://10.0.1.10:2380,infra1=http://10.0.1.11:2380,infra2=http://10.0.1.12:2380 \
  --initial-cluster-state new
```

> **注意：** `--initial-cluster` 中指定的 URL 必须与各节点的 `--initial-advertise-peer-urls` 相匹配。
>
> 测试多个集群时，为每个集群设置唯一的 `--initial-cluster-token` 以防止跨集群交互。

**`--initial-cluster` 参数只在集群首次启动时生效。** 集群引导完成后，可以放心地从启动命令中移除这些参数。

### 2.2 方式二：etcd 服务发现

当 IP 地址事先未知时，可使用另一个 etcd 集群作为发现服务：

```bash
# 1. 在公共发现服务上创建唯一的发现 URL
curl https://discovery.etcd.io/new?size=3
# 返回类似: https://discovery.etcd.io/abc123...

# 2. 每台机器使用相同的发现 URL 启动
etcd --name infra0 \
  --initial-advertise-peer-urls http://10.0.1.10:2380 \
  --listen-peer-urls http://10.0.1.10:2380 \
  --listen-client-urls http://10.0.1.10:2379,http://127.0.0.1:2379 \
  --advertise-client-urls http://10.0.1.10:2379 \
  --discovery https://discovery.etcd.io/abc123...
```

> 适用于云环境或容器化部署等 IP 事先未知的场景。

### 2.3 方式三：DNS 发现

通过 DNS SRV 记录自动发现集群成员：

```bash
# 需要预先配置 DNS SRV 记录
# _etcd-server._tcp.example.com. 300 IN SRV 0 0 2380 infra0.example.com.
# _etcd-server._tcp.example.com. 300 IN SRV 0 0 2380 infra1.example.com.
# _etcd-server._tcp.example.com. 300 IN SRV 0 0 2380 infra2.example.com.

etcd --name infra0 \
  --discovery-srv example.com \
  --initial-advertise-peer-urls http://infra0.example.com:2380 \
  --listen-peer-urls http://0.0.0.0:2380 \
  --listen-client-urls http://0.0.0.0:2379 \
  --advertise-client-urls http://infra0.example.com:2379
```

---

## 3. TLS 安全集群

生产环境必须开启 TLS 加密通信。

### 3.1 生成证书（使用 cfssl）

```bash
# 安装 cfssl
go install github.com/cloudflare/cfssl/cmd/cfssl@latest
go install github.com/cloudflare/cfssl/cmd/cfssljson@latest

# 生成 CA 证书
cfssl gencert -initca ca-csr.json | cfssljson -bare ca

# 为每个节点生成证书
cfssl gencert \
  -ca=ca.pem -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="infra0,infra0.example.com,10.0.1.10" \
  node-csr.json | cfssljson -bare infra0
```

### 3.2 启动 TLS 集群

```bash
etcd --name infra0 \
  --initial-advertise-peer-urls https://10.0.1.10:2380 \
  --listen-peer-urls https://10.0.1.10:2380 \
  --listen-client-urls https://10.0.1.10:2379,https://127.0.0.1:2379 \
  --advertise-client-urls https://10.0.1.10:2379 \
  --initial-cluster-token etcd-cluster-1 \
  --initial-cluster infra0=https://10.0.1.10:2380,infra1=https://10.0.1.11:2380,infra2=https://10.0.1.12:2380 \
  --initial-cluster-state new \
  --cert-file=/path/to/infra0.pem \
  --key-file=/path/to/infra0-key.pem \
  --peer-cert-file=/path/to/infra0.pem \
  --peer-key-file=/path/to/infra0-key.pem \
  --trusted-ca-file=/path/to/ca.pem \
  --peer-trusted-ca-file=/path/to/ca.pem \
  --peer-client-cert-auth \
  --client-cert-auth
```

---

## 4. 常用 etcdctl 运维命令

### 4.1 集群状态检查

```bash
# 检查集群健康状态
etcdctl endpoint health --endpoints=10.0.1.10:2379,10.0.1.11:2379,10.0.1.12:2379
# 10.0.1.10:2379 is healthy: ...
# 10.0.1.11:2379 is healthy: ...
# 10.0.1.12:2379 is healthy: ...

# 查看集群成员列表
etcdctl member list
# 8e9e05c52164694d, started, infra0, http://10.0.1.10:2380, http://10.0.1.10:2379

# 查看集群状态（包含 Leader 信息、Raft 索引等）
etcdctl endpoint status --write-out=table \
  --endpoints=10.0.1.10:2379,10.0.1.11:2379,10.0.1.12:2379
```

### 4.2 动态成员管理（运行时重配置）

**重要：** 每次只能添加/删除一个节点，并等待其完成同步。

**添加新成员：**

```bash
# 步骤 1：通知集群有新成员加入
etcdctl member add infra3 --peer-urls=http://10.0.1.13:2380

# 步骤 2：在新节点上使用 existing 状态启动
etcd --name infra3 \
  --initial-advertise-peer-urls http://10.0.1.13:2380 \
  --listen-peer-urls http://10.0.1.13:2380 \
  --listen-client-urls http://10.0.1.13:2379,http://127.0.0.1:2379 \
  --advertise-client-urls http://10.0.1.13:2379 \
  --initial-cluster-token etcd-cluster-1 \
  --initial-cluster "infra0=http://10.0.1.10:2380,infra1=http://10.0.1.11:2380,infra2=http://10.0.1.12:2380,infra3=http://10.0.1.13:2380" \
  --initial-cluster-state existing   # 注意：existing 而非 new
```

**移除成员：**

```bash
# 通过 member ID 移除
etcdctl member remove 8e9e05c52164694d
```

**更新成员的 Peer URL：**

```bash
etcdctl member update 8e9e05c52164694d --peer-urls=http://192.168.0.10:2380
```

### 4.3 Leader 选举

```bash
# 查看当前 Leader
etcdctl endpoint status --write-out=table

# 强制迁移 Leader（将 Leader 从某节点迁移走）
etcdctl move-leader <targetID>
```

### 4.4 快照备份与恢复

```bash
# 创建快照备份
etcdctl snapshot save snapshot.db

# 验证快照
etcdctl snapshot status snapshot.db --write-out=table

# 从快照恢复（需要在所有成员上执行）
etcdctl snapshot restore snapshot.db \
  --name infra0 \
  --initial-cluster infra0=http://10.0.1.10:2380,infra1=http://10.0.1.11:2380,infra2=http://10.0.1.12:2380 \
  --initial-cluster-token etcd-cluster-1 \
  --initial-advertise-peer-urls http://10.0.1.10:2380 \
  --data-dir=/var/lib/etcd-restore

# 在恢复后的数据目录启动 etcd
etcd --data-dir=/var/lib/etcd-restore [其他参数...]
```

---

## 5. 配置参数速查

### 5.1 成员参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--name` | `default` | 节点名称（集群内唯一） |
| `--data-dir` | `${name}.etcd` | 数据目录 |
| `--wal-dir` | `""` | WAL 日志目录（建议独立磁盘） |
| `--snapshot-count` | `100000` | 触发快照的 Raft 条目数 |
| `--heartbeat-interval` | `100` ms | Leader 心跳间隔（ms） |
| `--election-timeout` | `1000` ms | 选举超时（ms），建议 = 10x heartbeat |

### 5.2 集群参数

| 参数 | 说明 |
|------|------|
| `--initial-advertise-peer-urls` | 向集群广播的 Peer URL |
| `--listen-peer-urls` | 监听 Peer 通信的 URL |
| `--advertise-client-urls` | 向客户端广播的 URL |
| `--listen-client-urls` | 监听客户端通信的 URL |
| `--initial-cluster` | 初始集群成员列表（逗号分隔） |
| `--initial-cluster-token` | 集群唯一标识符（防止跨集群交互） |
| `--initial-cluster-state` | `new`（新建）或 `existing`（加入已有集群） |

### 5.3 调优参数

| 参数 | 说明 |
|------|------|
| `--quota-backend-bytes` | 后端存储配额（默认 2 GB，最大 8 GB） |
| `--auto-compaction-retention` | 自动压缩保留时间（小时），如 `1` |
| `--max-snapshots` | 保留的最大快照数（默认 5） |
| `--max-wals` | 保留的最大 WAL 文件数（默认 5） |

---

## 6. 容器部署

### 6.1 Docker 运行

```bash
# 单节点开发环境
docker run -d \
  -p 2379:2379 \
  -p 2380:2380 \
  --name etcd \
  quay.io/coreos/etcd:v3.5.0 \
  /usr/local/bin/etcd \
  --name s1 \
  --data-dir /etcd-data \
  --listen-client-urls http://0.0.0.0:2379 \
  --advertise-client-urls http://0.0.0.0:2379 \
  --listen-peer-urls http://0.0.0.0:2380 \
  --initial-advertise-peer-urls http://0.0.0.0:2380 \
  --initial-cluster s1=http://0.0.0.0:2380 \
  --initial-cluster-token tkn \
  --initial-cluster-state new
```

### 6.2 Kubernetes StatefulSet 部署

在 Kubernetes 中以 StatefulSet 形式部署 etcd 是推荐的生产方案：

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: etcd
  namespace: etcd
spec:
  serviceName: etcd-headless
  replicas: 3
  selector:
    matchLabels:
      app: etcd
  template:
    metadata:
      labels:
        app: etcd
    spec:
      containers:
      - name: etcd
        image: quay.io/coreos/etcd:v3.5.0
        ports:
        - containerPort: 2379
          name: client
        - containerPort: 2380
          name: peer
        env:
        - name: INITIAL_CLUSTER_SIZE
          value: "3"
        - name: SET_NAME
          value: "etcd"
        volumeMounts:
        - name: data
          mountPath: /var/run/etcd
        command:
        - /bin/sh
        - -ec
        - |
          HOSTNAME=$(hostname)
          # ... 启动脚本
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 20Gi
      storageClassName: fast-ssd  # 使用 SSD 存储类
```

---

## 7. 常见故障排查

### 7.1 集群丢失 Quorum

**现象：** 写操作返回 `etcdserver: request timed out`

**原因：** 多数节点宕机，集群失去 Quorum

**恢复方案（仅在无法通过正常方式恢复时使用）：**

```bash
# 在剩余节点上强制以单节点模式启动（会丢失数据一致性保证）
etcd --force-new-cluster --data-dir=/var/lib/etcd
```

> ⚠️ **风险极高**，仅作为最后手段，之后应立即恢复完整集群。

### 7.2 存储空间告警

**现象：** `etcdserver: mvcc: database space exceeded`

**处理步骤：**

```bash
# 1. 压缩历史数据
etcdctl compact $(etcdctl endpoint status --write-out="json" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Status']['header']['revision'])")

# 2. 碎片整理（释放物理空间）
etcdctl defrag --endpoints=10.0.1.10:2379,10.0.1.11:2379,10.0.1.12:2379

# 3. 解除告警
etcdctl alarm disarm
```

### 7.3 单节点重启后无法加入集群

```bash
# 查看成员状态
etcdctl member list

# 若节点数据目录损坏，先移除再重新添加
etcdctl member remove <member-id>
etcdctl member add <name> --peer-urls=<peer-url>
# 然后以 --initial-cluster-state=existing 重新启动
```
