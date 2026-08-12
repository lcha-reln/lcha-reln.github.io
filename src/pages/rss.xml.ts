import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { SITE } from "../config";
import { getExcerpt, getPostPath, sortPosts } from "../lib/content";

export async function GET(context: { site: URL }) {
  const posts = sortPosts(await getCollection("posts", ({ data }) => !data.draft));
  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: getExcerpt(post, 180),
      link: getPostPath(post),
    })),
  });
}
