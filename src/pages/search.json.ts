import { getCollection } from "astro:content";
import { getExcerpt, getPostPath, getSeries, normalizeList, sortPosts } from "../lib/content";

export const prerender = true;

export async function GET() {
  const posts = sortPosts(await getCollection("posts", ({ data }) => !data.draft));
  return new Response(
    JSON.stringify(
      posts.map((post) => ({
        title: post.data.title,
        description: getExcerpt(post, 150),
        url: getPostPath(post),
        tags: normalizeList(post.data.tags),
        series: getSeries(post).title,
      })),
    ),
    { headers: { "Content-Type": "application/json; charset=utf-8" } },
  );
}
