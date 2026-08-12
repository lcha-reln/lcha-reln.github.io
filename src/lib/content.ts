import type { CollectionEntry } from "astro:content";
import { META_SERIES, SERIES, type SeriesKey } from "../config";

export type Post = CollectionEntry<"posts">;

export function normalizeList(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function getPostSlug(post: Post): string {
  return post.data.permalink.replace(/^\/+|\/+$/g, "");
}

export function getPostPath(post: Post): string {
  return `/posts/${getPostSlug(post)}/`;
}

export function sortPosts(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function getExcerpt(post: Post, maxLength = 132): string {
  if (post.data.description) return post.data.description;

  const body = post.body ?? "";
  const source = body
    .split("<!-- more -->")[0]
    .replace(/^---[\s\S]*?---/, "")
    .replace(/<div class=["']mermaid["']>[\s\S]*?<\/div>/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[\*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (source.length <= maxLength) return source;
  return `${source.slice(0, maxLength).trim()}…`;
}

export function readingMinutes(post: Post): number {
  const body = post.body ?? "";
  const plain = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "");
  const code = (body.match(/```[\s\S]*?```/g) ?? []).join("").length;
  return Math.max(1, Math.ceil(plain.length / 500 + code / 1200));
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function getSeriesKey(post: Post): SeriesKey {
  const text = [
    post.data.title,
    ...normalizeList(post.data.tags),
    ...normalizeList(post.data.categories),
    post.id,
  ]
    .join(" ")
    .toLowerCase();

  if (text.includes("signal grid") || text.includes("站点指南")) return "meta";
  if (text.includes("aeron")) return "aeron";
  if (text.includes("etcd")) return "etcd";
  if (text.includes("zookeeper")) return "zookeeper";
  if (text.includes("金融") || text.includes("交易") || text.includes("合约")) return "trading";
  if (text.includes("高可用") || text.includes("序列号")) return "availability";
  return "performance";
}

export function getSeries(post: Post) {
  const key = getSeriesKey(post);
  if (key === "meta") return META_SERIES;
  return SERIES.find((series) => series.key === key) ?? SERIES[5];
}

export function getPostsInSeries(posts: Post[], key: SeriesKey): Post[] {
  return sortPosts(posts.filter((post) => getSeriesKey(post) === key));
}
