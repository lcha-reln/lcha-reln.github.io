---
title: ZooKeeper 命令
tags:
  - ZooKeeper
  - 中间件
  - 运维
categories:
  - 中间件
  - ZooKeeper
abbrlink: 2b7b1ffc
date: 2026-03-11 12:02:00
---

> ZooKeeper 命令行客户端（zkCli）操作手册，涵盖节点增删改查、监听器及四字命令。

## 1. 启动服务与命令行

```bash
# 启动服务
bin/zkServer.sh start

# 启动命令行（不指定地址则默认连接 localhost:2181）
bin/zkCli.sh -server hadoop001:2181
```

---

## 2. 查看节点列表

### 2.1 `ls` 命令

查看某个路径下的目录列表。

```bash
# 语法
ls path

# 示例
[zk: localhost:2181(CONNECTED) 0] ls /
[cluster, controller_epoch, brokers, storm, zookeeper, admin, ...]
```

### 2.2 `ls2` 命令

查看某个路径下的目录列表，比 `ls` 命令列出更多的详细信息（同时展示节点的 Stat 信息）。

```bash
# 语法
ls2 path

# 示例
[zk: localhost:2181(CONNECTED) 1] ls2 /
[cluster, controller_epoch, brokers, ...]
cZxid = 0x0
ctime = Thu Jan 01 08:00:00 CST 1970
mZxid = 0x0
mtime = Thu Jan 01 08:00:00 CST 1970
pZxid = 0x130
cversion = 19
dataVersion = 0
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 0
numChildren = 11
```

---

## 3. 节点的增删改查

### 3.1 `get` 命令

获取节点数据和状态信息。

```bash
# 语法
get path [watch]
```

> `-w` 参数对节点进行事件监听（`get path [watch]` 在当前版本已废弃，使用 `get path -w`）

```bash
[zk: localhost:2181(CONNECTED) 31] get /hadoop
123456      # 节点数据
cZxid = 0x14b
ctime = Fri May 24 17:03:06 CST 2019
mZxid = 0x14b
mtime = Fri May 24 17:03:06 CST 2019
pZxid = 0x14b
cversion = 0
dataVersion = 0
aclVersion = 0
ephemeralOwner = 0x0
dataLength = 6
numChildren = 0
```

**节点 Stat 属性说明：**

| 状态属性 | 说明 |
|---------|------|
| `cZxid` | 数据节点创建时的事务 ID |
| `ctime` | 数据节点创建时的时间 |
| `mZxid` | 数据节点最后一次更新时的事务 ID |
| `mtime` | 数据节点最后一次更新时的时间 |
| `pZxid` | 数据节点的子节点最后一次被修改时的事务 ID |
| `cversion` | 子节点的更改次数 |
| `dataVersion` | 节点数据的更改次数 |
| `aclVersion` | 节点的 ACL 的更改次数 |
| `ephemeralOwner` | 临时节点时为创建该节点的会话 SessionID；持久节点时为 0 |
| `dataLength` | 数据内容的长度 |
| `numChildren` | 数据节点当前的子节点个数 |

> **Zxid（ZooKeeper Transaction Id）**：ZooKeeper 节点的每一次更改都具有唯一的 Zxid，如果 Zxid1 < Zxid2，则 Zxid1 的更改发生在 Zxid2 更改之前。

### 3.2 `stat` 命令

查看节点状态信息，返回值和 `get` 命令类似，但**不会返回节点数据**。

```bash
# 语法
stat path [watch]

# 示例
[zk: localhost:2181(CONNECTED) 32] stat /hadoop
cZxid = 0x14b
...
```

### 3.3 `create` 命令

创建节点并赋值。

```bash
# 语法
create [-s] [-e] path data acl
```

| 参数 | 说明 |
|------|------|
| `-s` | 顺序节点，节点名会自动追加自增序号 |
| `-e` | 临时节点，会话结束或客户端断开连接时自动删除（临时节点不能再创建子节点） |
| `path` | 指定要创建节点的路径 |
| `data` | 要在此节点存储的数据 |
| `acl` | 访问权限，默认 `world`，相当于全世界都能访问 |

```bash
# 创建持久节点
[zk: localhost:2181(CONNECTED) 4] create /hadoop 123456
Created /hadoop

# 创建有序节点（节点名 = 指定名 + 自增序号）
[zk: localhost:2181(CONNECTED) 23] create -s /a "aaa"
Created /a0000000022
[zk: localhost:2181(CONNECTED) 24] create -s /b "bbb"
Created /b0000000023
[zk: localhost:2181(CONNECTED) 25] create -s /c "ccc"
Created /c0000000024

# 创建临时节点
[zk: localhost:2181(CONNECTED) 26] create -e /tmp "tmp"
Created /tmp
```

### 3.4 `set` 命令

修改节点存储的数据。

```bash
# 语法
set path data [version]
```

> `[version]` 可选，版本号可用作**乐观锁**：传入的 `dataVersion` 和当前节点的版本号不符合时，ZooKeeper 会拒绝本次修改。

```bash
[zk: localhost:2181(CONNECTED) 33] set /hadoop 345
...
dataVersion = 1   # 更改后版本号为 1（默认创建时为 0）

# 传入错误版本号，操作会被拒绝
[zk: localhost:2181(CONNECTED) 34] set /hadoop 678 0
version No is not valid : /hadoop
```

### 3.5 `delete` 命令

删除某节点。

```bash
# 语法
delete path [version]
```

> - `[version]` 可选，版本号不匹配时不会执行删除操作
> - `delete` 命令**不能删除带有子节点的节点**
> - 如果想要删除节点及其子节点，使用 `deleteall path`

```bash
[zk: localhost:2181(CONNECTED) 36] delete /hadoop 0
version No is not valid : /hadoop   # 版本号无效

[zk: localhost:2181(CONNECTED) 37] delete /hadoop 1   # 传入正确版本号，删除成功
```

---

## 4. 监听器（Watcher）

针对每个节点的操作，都会有一个监听者（watcher）。

**监听器特点：**
- 当监听的某个对象（znode）发生了变化，则触发监听事件
- ZooKeeper 中的监听事件是**一次性的**，触发后立即销毁，需要重新注册
- 父节点、子节点的增删改都能够触发监听者

**触发事件类型：**

| 操作类型 | 触发事件 |
|---------|---------|
| 创建父节点 | `NodeCreated` |
| 修改节点数据 | `NodeDataChanged` |
| 删除节点 | `NodeDeleted` |
| 创建子节点 | `NodeChildrenChanged` |
| 删除子节点 | `NodeChildrenChanged` |
| 修改子节点 | 不触发事件 |

### 4.1 监听节点数据变化：`get path -w`

```bash
[zk: localhost:2181(CONNECTED) 4] get /hadoop -w
[zk: localhost:2181(CONNECTED) 5] set /hadoop 45678
WATCHER::
WatchedEvent state:SyncConnected type:NodeDataChanged path:/hadoop
```

> `get path [watch]` 在当前版本已废弃，使用 `get path -w`

### 4.2 监听节点状态变化：`stat path -w`

```bash
[zk: localhost:2181(CONNECTED) 7] stat /hadoop -w
[zk: localhost:2181(CONNECTED) 8] set /hadoop 112233
WATCHER::
WatchedEvent state:SyncConnected type:NodeDataChanged path:/hadoop
```

> `stat path [watch]` 在当前版本已废弃，使用 `stat path -w`

### 4.3 监听子节点变化：`ls path -w`

```bash
[zk: localhost:2181(CONNECTED) 9] ls /hadoop -w
[]
[zk: localhost:2181(CONNECTED) 10] create /hadoop/yarn "aaa"
WATCHER::
WatchedEvent state:SyncConnected type:NodeChildrenChanged path:/hadoop
```

> `ls path [watch]` 在当前版本已废弃，使用 `ls path -w`

---

## 5. 辅助命令

| 命令 | 说明 |
|------|------|
| `help` | 查看所有命令帮助信息 |
| `history` | 查看最近 10 条历史记录 |
| `quit` | 退出命令行 |
| `close` | 关闭当前连接 |

---

## 6. ZooKeeper 四字命令

使用前需要安装 `nc` 命令（`yum install nc`），使用格式：`echo <cmd> | nc <host> <port>`

| 命令 | 功能描述 |
|------|---------|
| `conf` | 打印服务配置的详细信息 |
| `cons` | 列出连接到此服务器的所有客户端的完整连接/会话详细信息（接收/发送包数量、会话 ID、操作延迟等） |
| `dump` | 列出未完成的会话和临时节点（只适用于 Leader 节点） |
| `envi` | 打印服务环境的详细信息 |
| `ruok` | 测试服务是否处于正确状态，正确则返回 "imok" |
| `stat` | 列出服务器和连接客户端的简要详细信息 |
| `wchs` | 列出所有 watch 的简单信息 |
| `wchc` | 按会话列出服务器 watch 的详细信息 |
| `wchp` | 按路径列出服务器 watch 的详细信息 |

**使用示例：**

```bash
[root@hadoop001 bin]# echo stat | nc localhost 2181
Zookeeper version: 3.4.13-2d71af4dbe22557fda74f9a9b4309b15a7487f03,
built on 06/29/2018 04:05 GMT
Clients:
 /0:0:0:0:0:0:0:1:50584[1](queued=0,recved=371,sent=371)
 /0:0:0:0:0:0:0:1:50656[0](queued=0,recved=1,sent=0)
Latency min/avg/max: 0/0/19
Received: 372
Sent: 371
Connections: 2
Outstanding: 0
Zxid: 0x150
Mode: standalone
Node count: 167
```

> 更多四字命令参阅官方文档：[ZooKeeper Administrator's Guide](https://zookeeper.apache.org/doc/current/zookeeperAdmin.html)

---

## 7. 常用命令速查

```bash
# 服务管理
bin/zkServer.sh start|stop|restart|status

# 连接
bin/zkCli.sh -server host:2181

# 节点操作
ls /                                          # 列出根节点子节点
ls /path -w                                   # 监听子节点变化
get /path                                     # 获取节点数据
get /path -w                                  # 获取数据并监听变化
stat /path                                    # 查看节点状态
create /path "data"                           # 创建持久节点
create -e /path "data"                        # 创建临时节点
create -s /path "data"                        # 创建有序节点
create -s -e /path "data"                     # 创建有序临时节点
set /path "newdata"                           # 修改节点数据
set /path "newdata" 1                         # 乐观锁修改（指定版本号）
delete /path                                  # 删除节点（无子节点）
deleteall /path                               # 递归删除节点及子节点

# ACL
getAcl /path                                  # 查看节点权限
setAcl /path world:anyone:cdrwa              # 设置权限
addauth digest user:password                  # 添加认证信息

# 四字命令
echo ruok | nc localhost 2181                 # 健康检查
echo stat | nc localhost 2181                 # 状态信息
echo conf | nc localhost 2181                 # 配置信息
```
