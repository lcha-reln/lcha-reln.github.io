---
title: ZooKeeper ACL 权限控制
date: 2026-03-11 12:04:00
tags:
  - ZooKeeper
  - 中间件
  - 安全
categories:
  - 中间件
  - ZooKeeper
---

> 为了避免存储在 ZooKeeper 上的数据被其他程序或人为误修改，ZooKeeper 提供了 ACL（Access Control Lists）进行权限控制。ACL 权限可以针对节点设置相关读写等权限，保障数据安全性。

## 1. ACL 组成

ZooKeeper 的 ACL 通过 `[scheme:id:permissions]` 来构成权限列表。

### 1.1 scheme（权限机制）

| scheme | 说明 |
|--------|------|
| `world` | 默认模式，所有客户端都拥有指定的权限。只有一个 id 选项 `anyone`，写法：`world:anyone:[permissions]` |
| `auth` | 只有经过认证的用户才拥有指定的权限。写法：`auth:user:password:[permissions]`；使用该模式时，需要先用 `addauth` 登录，设置权限时的 `user` 和 `password` 将使用登录的用户名和密码 |
| `digest` | 只有经过认证的用户才拥有指定的权限。写法：`digest:user:BASE64(SHA1(password)):[permissions]`，密码必须通过 SHA1 和 BASE64 进行双重加密 |
| `ip` | 限制只有特定 IP 的客户端才拥有指定的权限。写法：`ip:192.168.0.168:[permissions]` |
| `super` | 超级管理员，拥有所有权限，需要修改 ZooKeeper 启动脚本进行配置 |

> `auth` 模式可以理解成 `digest` 模式的一种简便实现：`digest` 模式每次设置都需要书写用户名和加密后的密码，比较繁琐；`auth` 模式可以避免这种麻烦，直接使用已登录的用户信息。

### 1.2 id

代表允许访问的用户。

### 1.3 permissions（权限）

权限组合字符串，由 `cdrwa` 组成：

| 权限字符 | 权限常量 | 说明 |
|---------|---------|------|
| `c` | `CREATE` | 允许创建子节点 |
| `d` | `DELETE` | 允许删除子节点 |
| `r` | `READ` | 允许从节点获取数据并列出其子节点 |
| `w` | `WRITE` | 允许为节点设置数据 |
| `a` | `ADMIN` | 允许为节点设置权限 |

---

## 2. 命令行操作

ZooKeeper ACL 提供了以下几种命令行：

| 命令 | 说明 |
|------|------|
| `getAcl path` | 获取某个节点的 ACL 权限信息 |
| `setAcl path acl` | 设置某个节点的 ACL 权限信息（给**已有**节点赋予权限） |
| `create [-s] [-e] path data acl` | 在**创建节点时**指定权限 |
| `addauth scheme auth` | 输入认证授权信息（注册时输入明文密码，加密形式保存），等价于登录操作 |

**添加认证信息示例：**

```bash
# 格式
addauth scheme auth

# 示例：添加用户名为 test、密码为 root 的用户认证信息
addauth digest test:root
```

---

## 3. 权限设置示例

### 3.1 world 模式

world 是默认模式，创建节点时如果不指定权限，则默认为 world：

```bash
# 创建节点（默认 world 权限）
[zk: localhost:2181(CONNECTED) 32] create /mytest abc
Created /mytest

# 查看默认权限
[zk: localhost:2181(CONNECTED) 4] getAcl /mytest
'world,'anyone
: cdrwa

# 修改节点权限：不允许所有客户端读
[zk: localhost:2181(CONNECTED) 34] setAcl /mytest world:anyone:cwda

# 尝试读取，提示无权访问
[zk: localhost:2181(CONNECTED) 6] get /mytest
org.apache.zookeeper.KeeperException$NoAuthException: KeeperErrorCode = NoAuth for /mytest
```

### 3.2 auth 模式

```bash
# 先登录（添加认证信息）
[zk: localhost:2181(CONNECTED) 36] addauth digest test:root

# 设置权限（user 和 password 使用登录时的用户名和密码，即使指定其他值也无效）
[zk: localhost:2181(CONNECTED) 37] setAcl /mytest auth::cdrwa

# 查看权限（返回的权限类型是 digest，密码经过加密）
[zk: localhost:2181(CONNECTED) 38] getAcl /mytest
'digest,'heibai:sCxtVJ1gPG8UW/jzFHR0A1ZKY5s=
: cdrwa

# 注意：即使指定了 user/password，也会被忽略，使用的始终是登录时的账号信息
[zk: localhost:2181(CONNECTED) 39] setAcl /mytest auth:root:root:cdrwa
[zk: localhost:2181(CONNECTED) 40] getAcl /mytest
'digest,'heibai:sCxtVJ1gPG8UW/jzFHR0A1ZKY5s=  # 仍然是 test 用户
: cdrwa
```

> `auth` 模式设置的权限和 `digest` 模式设置的权限，最终结果的权限模式都是 `digest`。

### 3.3 digest 模式

```bash
# 指定用户名和加密后的密码（SHA1 + BASE64）
[zk: localhost:2181(CONNECTED) 44] create /spark "spark" digest:heibai:sCxtVJ1gPG8UW/jzFHR0A1ZKY5s=:cdrwa

# 查看权限
[zk: localhost:2181(CONNECTED) 45] getAcl /spark
'digest,'heibai:sCxtVJ1gPG8UW/jzFHR0A1ZKY5s=
: cdrwa
```

**生成加密密码：**

可以使用以下命令生成 SHA1+BASE64 加密后的密码：

```bash
# 使用 Java 工具类生成
echo -n "username:password" | openssl dgst -binary -sha1 | openssl base64
```

或者在代码中使用 ZooKeeper 提供的工具类：

```java
String digest = DigestAuthenticationProvider.generateDigest("username:password");
```

### 3.4 ip 模式

限定只有特定 IP 才能访问：

```bash
# 创建节点，只允许 192.168.0.108 访问
[zk: localhost:2181(CONNECTED) 46] create /hive "hive" ip:192.168.0.108:cdrwa

# 当前主机（不是 192.168.0.108）访问失败
[zk: localhost:2181(CONNECTED) 47] get /hive
Authentication is not valid : /hive
```

设置 ip 限制后，其他 IP 无法访问该节点，可以使用对应 IP 的客户端访问，或通过下面介绍的 `super` 模式绕过限制。

### 3.5 super 模式（超级管理员）

需要修改启动脚本 `zkServer.sh`，在脚本中找到启动 Java 命令的位置，添加超级管理员账户和密码信息：

```bash
"-Dzookeeper.DigestAuthenticationProvider.superDigest=heibai:sCxtVJ1gPG8UW/jzFHR0A1ZKY5s="
```

修改完成后使用 `zkServer.sh restart` 重启服务，之后超级管理员可以绕过所有权限限制访问任意节点：

```bash
# 访问受限节点，先提示无权
[zk: localhost:2181(CONNECTED) 0] get /hive
Authentication is not valid : /hive

# 登录超级管理员账户
[zk: localhost:2181(CONNECTED) 1] addauth digest heibai:heibai

# 成功访问
[zk: localhost:2181(CONNECTED) 2] get /hive
hive
cZxid = 0x158
...
```

---

## 4. Curator 中的 ACL 操作

### 4.1 创建带 ACL 权限的节点

```java
List<ACL> aclList = new ArrayList<>();

// 对密码进行加密
String digest1 = DigestAuthenticationProvider.generateDigest("heibai:123456");
String digest2 = DigestAuthenticationProvider.generateDigest("ying:123456");
Id user01 = new Id("digest", digest1);
Id user02 = new Id("digest", digest2);

// user01 拥有所有权限
aclList.add(new ACL(Perms.ALL, user01));
// user02 只有 DELETE 和 CREATE 权限（使用 | 进行权限组合，按位或）
aclList.add(new ACL(Perms.DELETE | Perms.CREATE, user02));

client.create()
      .creatingParentsIfNeeded()
      .withMode(CreateMode.PERSISTENT)
      .withACL(aclList, true)  // true 表示对子节点也应用该 ACL
      .forPath(nodePath, "data".getBytes());
```

### 4.2 修改节点 ACL

```java
// 注意：这会删除所有原来节点上已有的权限设置
String digest = DigestAuthenticationProvider.generateDigest("admin:admin");
Id user = new Id("digest", digest);
client.setACL()
      .withACL(Collections.singletonList(new ACL(Perms.READ | Perms.DELETE, user)))
      .forPath(nodePath);
```

### 4.3 获取节点 ACL

```java
List<ACL> aclList = client.getACL().forPath(nodePath);
ACL acl = aclList.get(0);
System.out.println(acl.getId().getId()
        + " 是否有删读权限: " + (acl.getPerms() == (Perms.READ | Perms.DELETE)));
```

### 4.4 创建带认证的连接

```java
// 在创建 CuratorFramework 时传入认证信息，等价于 addauth 命令
client = CuratorFrameworkFactory.builder()
        .authorization("digest", "heibai:123456".getBytes())
        .connectString(zkServerPath)
        .sessionTimeoutMs(10000)
        .retryPolicy(retryPolicy)
        .namespace("workspace")
        .build();
```

---

## 5. ACL 权限速查

| 场景 | 命令 / 代码 |
|------|------------|
| 开放所有权限 | `world:anyone:cdrwa` |
| 只读 | `world:anyone:r` |
| 按用户名密码认证（明文） | `addauth digest user:pass` + `setAcl path auth::cdrwa` |
| 按用户名密码认证（加密） | `create path data digest:user:BASE64(SHA1(pass)):cdrwa` |
| 按 IP 限制 | `ip:192.168.1.1:cdrwa` |
| 超级管理员 | 修改启动脚本，添加 `-Dzookeeper.DigestAuthenticationProvider.superDigest=user:pass` |
