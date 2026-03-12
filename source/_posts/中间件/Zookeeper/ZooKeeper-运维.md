---
title: ZooKeeper 运维指南
date: 2026-03-11 12:03:00
tags:
  - ZooKeeper
  - 中间件
  - 运维
categories:
  - 中间件
  - ZooKeeper
---

> ZooKeeper 单机与集群的部署、配置和验证指南。

## 1. 单点服务部署

### 支持的操作系统

| 操作系统 | 支持场景 |
|---------|---------|
| Linux | 开发和部署，适合演示应用程序 |
| Windows | 仅支持开发 |
| Mac OS | 仅支持开发 |

### 1.1 下载解压

进入官方下载地址：[http://zookeeper.apache.org/releases.html](http://zookeeper.apache.org/releases.html)，选择合适版本。

```bash
tar -zxf zookeeper-3.4.6.tar.gz
cd zookeeper-3.4.6
```

### 1.2 配置环境变量

```bash
vim /etc/profile
```

添加以下内容：

```bash
export ZOOKEEPER_HOME=/usr/app/zookeeper-3.4.14
export PATH=$ZOOKEEPER_HOME/bin:$PATH
```

使配置生效：

```bash
source /etc/profile
```

### 1.3 修改配置

必须创建 `conf/zoo.cfg` 文件，否则启动时会提示没有此文件。可以直接使用提供的模板配置文件：

```bash
cp conf/zoo_sample.cfg conf/zoo.cfg
```

完整配置示例：

```properties
# 基础时间单元（毫秒），用于计算 session 超时等
tickTime=2000

# 集群中，允许从节点连接并同步到 Master 节点的初始化连接时间（tickTime 的倍数）
initLimit=10

# 集群中，Master 与从节点之间发送消息的请求和应答时间长度（心跳机制，tickTime 的倍数）
syncLimit=5

# 数据存储目录（不要使用 /tmp，重启后会被清除）
dataDir=/usr/local/zookeeper/data

# 日志存储目录
dataLogDir=/usr/local/zookeeper/log

# 客户端连接端口
clientPort=2181

# 最大客户端连接数（注释掉则不限制）
#maxClientCnxns=60

# 自动清理快照（保留快照数量）
#autopurge.snapRetainCount=3
# 自动清理任务执行间隔（小时），0 表示禁用自动清理
#autopurge.purgeInterval=1
```

**配置参数说明：**

| 参数 | 说明 |
|------|------|
| `tickTime` | 基础时间单元（毫秒），session 超时时间 = N × tickTime |
| `initLimit` | 允许从节点连接并同步到 Master 节点的初始化连接时间（tickTime 倍数） |
| `syncLimit` | Master 与从节点之间心跳的超时时间（tickTime 倍数） |
| `dataDir` | 数据存储位置 |
| `dataLogDir` | 日志目录 |
| `clientPort` | 客户端连接端口，默认 2181 |

### 1.4 启动服务

```bash
bin/zkServer.sh start
```

成功输出：

```
JMX enabled by default
Using config: /Users/../zookeeper-3.4.6/bin/../conf/zoo.cfg
Starting zookeeper ... STARTED
```

### 1.5 停止服务

```bash
bin/zkServer.sh stop
```

### 1.6 其他服务命令

```bash
bin/zkServer.sh status    # 查看服务状态（Leader/Follower/Standalone）
bin/zkServer.sh restart   # 重启服务
```

---

## 2. 集群服务部署

分布式系统节点数一般要求是**奇数**，且最少为 **3 个节点**，ZooKeeper 也不例外。

> 奇数节点的原因：选举需要过半同意，奇数可以减少节点数量同时保证容错能力。例如：
> - 3 节点集群可容忍 1 个节点故障
> - 5 节点集群可容忍 2 个节点故障

这里规划一个含 3 个节点的最小 ZooKeeper 集群，主机名分别为 `hadoop001`、`hadoop002`、`hadoop003`。

### 2.1 修改配置

在三台机器上修改配置文件 `zoo.cfg`，内容如下：

```properties
tickTime=2000
initLimit=10
syncLimit=5
dataDir=/usr/local/zookeeper-cluster/data/
dataLogDir=/usr/local/zookeeper-cluster/log/
clientPort=2181

# server.{myid}={hostname}:{通讯端口}:{选举端口}
server.1=hadoop001:2287:3387
server.2=hadoop002:2287:3387
server.3=hadoop003:2287:3387
```

> - `server.1` 中的 `1` 是服务器的标识（与 `myid` 文件中的数字对应）
> - `2287` 是集群间通讯端口
> - `3387` 是选举端口

### 2.2 标识节点（myid）

分别在三台主机的 `dataDir` 目录下新建 `myid` 文件，并写入对应的节点标识。ZooKeeper 集群通过 `myid` 文件识别集群节点。

创建存储目录（三台主机均执行）：

```bash
mkdir -vp /usr/local/zookeeper-cluster/data/
```

创建并写入节点标识到 `myid` 文件：

```bash
# hadoop001 主机
echo "1" > /usr/local/zookeeper-cluster/data/myid

# hadoop002 主机
echo "2" > /usr/local/zookeeper-cluster/data/myid

# hadoop003 主机
echo "3" > /usr/local/zookeeper-cluster/data/myid
```

### 2.3 启动集群

分别在三台主机上执行启动命令：

```bash
/usr/app/zookeeper-cluster/zookeeper/bin/zkServer.sh start
```

### 2.4 集群验证

启动后使用 `status` 命令查看集群各个节点状态：

```bash
bin/zkServer.sh status
```

正常情况下，一台显示 `Mode: leader`，其余显示 `Mode: follower`：

```
# Leader 节点输出
Mode: leader

# Follower 节点输出
Mode: follower
```

也可以使用四字命令验证：

```bash
echo stat | nc hadoop001 2181
echo stat | nc hadoop002 2181
echo stat | nc hadoop003 2181
```

---

## 3. 生产环境建议

### 3.1 JVM 配置

修改 `bin/zkEnv.sh`，调整 JVM 内存配置：

```bash
export JVMFLAGS="-Xms2g -Xmx2g"
```

### 3.2 日志配置

修改 `conf/log4j.properties`，调整日志级别和滚动策略，避免日志文件过大。

### 3.3 数据目录规划

- `dataDir`：存储快照数据，建议使用高速磁盘（SSD）
- `dataLogDir`：存储事务日志，**强烈建议**将事务日志目录与快照目录分开放置在不同磁盘上，减少 I/O 竞争

### 3.4 定期清理

ZooKeeper 会生成大量快照文件和事务日志文件，需要定期清理。

**方式一：使用自动清理（推荐）**

```properties
autopurge.snapRetainCount=3     # 保留3个快照
autopurge.purgeInterval=24      # 每24小时清理一次
```

**方式二：使用脚本手动清理**

```bash
# 保留最近 5 个快照
bin/zkCleanup.sh -n 5 /usr/local/zookeeper/data
```

### 3.5 监控指标

通过四字命令获取关键监控指标：

```bash
# 获取服务器状态（包含连接数、延迟、吞吐量等）
echo stat | nc localhost 2181

# 获取服务配置
echo conf | nc localhost 2181

# 获取所有客户端连接详情
echo cons | nc localhost 2181
```

关键指标关注：
- `Latency min/avg/max`：请求延迟
- `Connections`：当前连接数
- `Outstanding`：等待处理的请求数（持续偏高需关注）
- `Node count`：总节点数
