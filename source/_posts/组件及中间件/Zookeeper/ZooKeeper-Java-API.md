---
title: ZooKeeper Java API
tags:
  - ZooKeeper
  - Java
  - 中间件
categories:
  - 中间件
  - ZooKeeper
abbrlink: '11315422'
date: 2026-03-11 12:01:00
---

> 介绍 ZooKeeper 官方客户端和 Curator 客户端的使用，涵盖连接、节点增删改查、监听事件和 ACL 权限管理。

## 1. ZooKeeper 官方客户端

### 1.1 客户端简介

客户端和服务端交互遵循以下基本步骤：

1. 客户端连接 ZooKeeper 服务端集群任意工作节点，该节点为客户端分配会话 ID
2. 客户端需要和服务端保持心跳（ping），否则 ZooKeeper 在会话超时时间内未收到请求，会将会话视为过期
3. 只要会话 ID 处于活动状态，就可以执行读写 znode 操作
4. 所有任务完成后，客户端断开连接；如果客户端长时间不活动，ZooKeeper 集合将自动断开连接

ZooKeeper 官方客户端的核心是 **`ZooKeeper` 类**，主要操作如下：

| 方法 | 说明 |
|------|------|
| `connect` | 连接 ZooKeeper 服务 |
| `create` | 创建 znode |
| `exists` | 检查 znode 是否存在及其信息 |
| `getACL` / `setACL` | 获取/设置一个 znode 的 ACL |
| `getData` / `setData` | 获取/设置一个 znode 的数据 |
| `getChildren` | 获取特定 znode 中的所有子节点 |
| `delete` | 删除特定的 znode 及其所有子项 |
| `close` | 关闭连接 |

**Maven 依赖：**

```xml
<dependency>
    <groupId>org.apache.zookeeper</groupId>
    <artifactId>zookeeper</artifactId>
    <version>3.7.0</version>
</dependency>
```

### 1.2 创建连接

ZooKeeper 类构造函数定义如下：

```java
ZooKeeper(String connectionString, int sessionTimeout, Watcher watcher)
```

| 参数 | 说明 |
|------|------|
| `connectionString` | ZooKeeper 集群的主机列表 |
| `sessionTimeout` | 会话超时时间（毫秒） |
| `watcher` | 实现监视机制的回调，当被监控的 znode 状态发生变化时被调用 |

```java
@BeforeAll
public static void init() throws IOException, InterruptedException {
    final String HOST = "localhost:2181";
    CountDownLatch latch = new CountDownLatch(1);
    zk = new ZooKeeper(HOST, 5000, watcher -> {
        if (watcher.getState() == Watcher.Event.KeeperState.SyncConnected) {
            latch.countDown();
        }
    });
    latch.await(); // 等待连接建立
}
```

> `CountDownLatch` 用于停止主进程，直到客户端与 ZooKeeper 集合连接成功。一旦客户端与 ZooKeeper 建立连接，监听器回调被调用并释放锁。

### 1.3 节点增删改查

#### 判断节点是否存在

`exists` 方法：如果指定的 znode 存在，则返回一个 znode 的元数据（`Stat`）。

```java
exists(String path, boolean watcher)
```

```java
Stat stat = zk.exists("/", true);
Assertions.assertNotNull(stat);
```

#### 创建节点

```java
create(String path, byte[] data, List<ACL> acl, CreateMode createMode)
```

| 参数 | 说明 |
|------|------|
| `path` | Znode 路径，如 `/myapp1` |
| `data` | 要存储在指定 znode 路径中的数据 |
| `acl` | 访问控制列表，`ZooDefs.Ids.OPEN_ACL_UNSAFE` 表示所有人都可访问 |
| `createMode` | 节点类型枚举：临时、顺序或两者组合 |

```java
String text = "My first zookeeper app";
zk.create("/mytest", text.getBytes(), ZooDefs.Ids.OPEN_ACL_UNSAFE, CreateMode.PERSISTENT);
```

#### 删除节点

```java
delete(String path, int version)
```

```java
// 传入当前版本号，版本号不匹配时会抛出异常
zk.delete(path, zk.exists(path, true).getVersion());
```

#### 获取节点数据

```java
getData(String path, Watcher watcher, Stat stat)
```

- `watcher`：当指定 znode 的数据改变时，ZooKeeper 会通过监听器回调进行通知（一次性通知）

```java
byte[] data = zk.getData(path, false, null);
String text = new String(data);
```

#### 设置节点数据

```java
setData(String path, byte[] data, int version)
```

> 每当数据更改时，ZooKeeper 会更新 znode 的版本号。

#### 获取子节点

```java
getChildren(String path, Watcher watcher)
```

- `watcher`：当指定 znode 被删除或 znode 下的子节点被创建/删除时，ZooKeeper 会进行通知（一次性通知）

```java
List<String> actualList = zk.getChildren(path, false);
```

---

## 2. Curator 客户端

### 2.1 Curator 客户端简介

Curator 是 Netflix 开源的 ZooKeeper 客户端框架，提供了更高级别的抽象，简化了 ZooKeeper 的操作，并解决了官方客户端的很多痛点（如自动重连、链式 API 等）。

**Maven 依赖：**

```xml
<dependency>
    <groupId>org.apache.curator</groupId>
    <artifactId>curator-recipes</artifactId>
    <version>5.1.0</version>
</dependency>
```

### 2.2 创建连接

```java
@BeforeAll
public static void init() {
    // 重试策略：重试3次，每次间隔5000ms
    RetryPolicy retryPolicy = new RetryNTimes(3, 5000);
    client = CuratorFrameworkFactory.builder()
                                    .connectString("localhost:2181")
                                    .sessionTimeoutMs(10000)
                                    .retryPolicy(retryPolicy)
                                    .namespace("workspace") // 指定命名空间，所有操作路径以 /workspace 开头
                                    .build();
    client.start();
}
```

### 2.3 节点增删改查

#### 判断节点是否存在

```java
Stat stat = client.checkExists().forPath(path);
```

#### 查看服务状态

```java
CuratorFrameworkState state = client.getState();
// state == CuratorFrameworkState.STARTED
```

#### 创建节点

```java
client.create()
      .creatingParentsIfNeeded()          // 如果父节点不存在，自动创建
      .withMode(CreateMode.PERSISTENT)    // 节点类型
      .withACL(ZooDefs.Ids.OPEN_ACL_UNSAFE)
      .forPath(path, "Hello World".getBytes(StandardCharsets.UTF_8));
```

#### 删除节点

```java
client.delete()
      .guaranteed()                     // 如果删除失败，会继续执行直到成功
      .deletingChildrenIfNeeded()       // 如果有子节点，则递归删除
      .withVersion(stat.getVersion())   // 版本号不匹配时拒绝删除并抛出 BadVersion 异常
      .forPath(path);
```

#### 获取节点数据

```java
byte[] data = client.getData().forPath(path);
```

#### 设置节点数据

```java
client.setData()
      .withVersion(client.checkExists().forPath(path).getVersion())
      .forPath(path, "new data".getBytes(StandardCharsets.UTF_8));
```

#### 获取子节点

```java
List<String> children = client.getChildren().forPath(path);
```

### 2.4 监听事件

#### 创建一次性监听

和 ZooKeeper 原生监听一样，使用 `usingWatcher` 注册的监听是一次性的，触发一次后销毁：

```java
client.getData().usingWatcher(new CuratorWatcher() {
    public void process(WatchedEvent event) {
        System.out.println("节点 " + event.getPath() + " 发生了事件：" + event.getType());
    }
}).forPath(path);

// 修改两次数据，但监听器只会触发第一次
client.setData().withVersion(...).forPath(path, "第一次修改".getBytes(...));
client.setData().withVersion(...).forPath(path, "第二次修改".getBytes(...));
// 输出: 节点 /mytest 发生了事件：NodeDataChanged
```

#### 创建永久监听

Curator 提供了创建永久监听的 API：

```java
CuratorCache curatorCache = CuratorCache.builder(client, path).build();
PathChildrenCacheListener pathChildrenCacheListener = (framework, event) -> {
    System.out.println("节点 " + event.getData().getPath() + " 发生了事件：" + event.getType());
};
CuratorCacheListener listener = CuratorCacheListener.builder()
        .forPathChildrenCache(path, client, pathChildrenCacheListener)
        .build();
curatorCache.listenable().addListener(listener);
curatorCache.start();
```

#### 监听子节点

```java
// 第三个参数代表除了节点状态外，是否还缓存节点内容
PathChildrenCache childrenCache = new PathChildrenCache(client, path, true);
/*
 * StartMode 初始化方式:
 *   NORMAL: 异步初始化
 *   BUILD_INITIAL_CACHE: 同步初始化
 *   POST_INITIALIZED_EVENT: 异步并通知，初始化之后会触发 INITIALIZED 事件
 */
childrenCache.start(PathChildrenCache.StartMode.POST_INITIALIZED_EVENT);

childrenCache.getListenable().addListener(new PathChildrenCacheListener() {
    public void childEvent(CuratorFramework client, PathChildrenCacheEvent event) {
        switch (event.getType()) {
            case INITIALIZED:
                System.out.println("childrenCache 初始化完成");
                break;
            case CHILD_ADDED:
                // 即使是之前已经存在的子节点，也会触发该监听
                System.out.println("增加子节点: " + event.getData().getPath());
                break;
            case CHILD_REMOVED:
                System.out.println("删除子节点: " + event.getData().getPath());
                break;
            case CHILD_UPDATED:
                System.out.println("被修改的子节点路径: " + event.getData().getPath());
                System.out.println("修改后的数据: " + new String(event.getData().getData()));
                break;
        }
    }
});
```

### 2.5 ACL 权限管理

```java
public class AclOperation {

    private CuratorFramework client;
    private static final String zkServerPath = "192.168.0.226:2181";
    private static final String nodePath = "/mytest/hdfs";

    @Before
    public void prepare() {
        RetryPolicy retryPolicy = new RetryNTimes(3, 5000);
        client = CuratorFrameworkFactory.builder()
                .authorization("digest", "heibai:123456".getBytes()) // 等价于 addauth 命令
                .connectString(zkServerPath)
                .sessionTimeoutMs(10000).retryPolicy(retryPolicy)
                .namespace("workspace").build();
        client.start();
    }

    /** 新建节点并赋予权限 */
    @Test
    public void createNodesWithAcl() throws Exception {
        List<ACL> aclList = new ArrayList<>();
        // 对密码进行加密
        String digest1 = DigestAuthenticationProvider.generateDigest("heibai:123456");
        String digest2 = DigestAuthenticationProvider.generateDigest("ying:123456");
        Id user01 = new Id("digest", digest1);
        Id user02 = new Id("digest", digest2);
        aclList.add(new ACL(Perms.ALL, user01));
        // 使用 | 进行权限组合（按位或）
        aclList.add(new ACL(Perms.DELETE | Perms.CREATE, user02));

        client.create().creatingParentsIfNeeded()
                .withMode(CreateMode.PERSISTENT)
                .withACL(aclList, true)
                .forPath(nodePath, "abc".getBytes());
    }

    /** 给已有节点设置权限（会删除所有原有权限设置） */
    @Test
    public void setAcl() throws Exception {
        String digest = DigestAuthenticationProvider.generateDigest("admin:admin");
        Id user = new Id("digest", digest);
        client.setACL()
                .withACL(Collections.singletonList(new ACL(Perms.READ | Perms.DELETE, user)))
                .forPath(nodePath);
    }

    /** 获取权限 */
    @Test
    public void getAcl() throws Exception {
        List<ACL> aclList = client.getACL().forPath(nodePath);
        ACL acl = aclList.get(0);
        System.out.println(acl.getId().getId()
                + "是否有删读权限: " + (acl.getPerms() == (Perms.READ | Perms.DELETE)));
    }
}
```

---

## 3. 官方客户端 vs Curator 对比

| 对比项 | 官方客户端 | Curator |
|--------|-----------|---------|
| 连接管理 | 需手动处理重连 | 自动重连，内置重试策略 |
| API 风格 | 回调式，较繁琐 | 链式 API，简洁易用 |
| 监听 | 一次性 Watch，需手动重注册 | 提供永久监听机制 |
| 节点创建 | 不支持递归创建父节点 | `creatingParentsIfNeeded()` 自动创建父节点 |
| 删除 | 不支持递归删除 | `deletingChildrenIfNeeded()` 递归删除 |
| 适用场景 | 轻量级使用，或学习底层原理 | 生产环境推荐使用 |
