export const SITE = {
  title: "RE-LN / Signal Grid",
  shortTitle: "RE/LN",
  description: "把实时消息、分布式一致性与交易系统讲清楚。",
  author: "lcha-reln",
  locale: "zh-CN",
  url: "https://lcha-reln.github.io",
  github: "https://github.com/lcha-reln/lcha-reln.github.io",
  cms: "https://app.pagescms.org",
};

export type SeriesKey =
  | "aeron"
  | "etcd"
  | "zookeeper"
  | "trading"
  | "availability"
  | "performance"
  | "meta";

export const META_SERIES = {
  key: "meta",
  title: "站点指南",
  eyebrow: "SIGNAL GRID",
  description: "关于这个博客的内容结构、编辑流程与发布方式。",
  color: "cyan",
  index: "00",
} as const;

export const SERIES = [
  {
    key: "aeron",
    title: "Aeron",
    eyebrow: "REAL-TIME TRANSPORT",
    description: "从 Media Driver 到 Cluster，拆开低延迟消息系统的每一层。",
    color: "cyan",
    index: "01",
  },
  {
    key: "etcd",
    title: "etcd",
    eyebrow: "DISTRIBUTED STATE",
    description: "理解 Raft、MVCC、Watch，以及生产集群的安全与运维。",
    color: "violet",
    index: "02",
  },
  {
    key: "zookeeper",
    title: "ZooKeeper",
    eyebrow: "COORDINATION",
    description: "从数据模型、Watch 到 ACL 和运维的完整协调系统路线。",
    color: "lime",
    index: "03",
  },
  {
    key: "trading",
    title: "交易系统",
    eyebrow: "MARKET MECHANICS",
    description: "订单簿、保证金、强平与衍生品机制的业务和技术视角。",
    color: "amber",
    index: "04",
  },
  {
    key: "availability",
    title: "高可用架构",
    eyebrow: "RESILIENCE",
    description: "围绕故障、恢复、一致性与演进建立可落地的系统方法。",
    color: "coral",
    index: "05",
  },
  {
    key: "performance",
    title: "高性能组件",
    eyebrow: "MECHANICAL SYMPATHY",
    description: "Agrona、Disruptor 与零分配、无锁编程的工程实践。",
    color: "blue",
    index: "06",
  },
] as const;
