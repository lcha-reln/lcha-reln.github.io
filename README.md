# RE/LN · Signal Grid

基于 Astro、Pages CMS 与 GitHub Pages 的静态技术博客。主题名为 **Signal Grid / 信号矩阵**：用实时消息与集群拓扑的视觉语言组织技术内容，同时保持长篇中文阅读体验。

## 本地开发

```bash
pnpm install
pnpm dev
```

完整校验与生产构建：

```bash
pnpm check
pnpm build
pnpm preview
```

## 内容编辑

新博客的文章保存在 `src/content/posts/`。旧站的 `source/_posts/` 仅作为历史备份保留，不会被 Astro 加载，也不会出现在新站中。

- 在线编辑：打开 [Pages CMS](https://app.pagescms.org)，授权 GitHub 后选择本仓库与 `source` 分支。
- 本地编辑：直接修改 `src/content/posts/**/*.md`。
- 图片：Pages CMS 会上传到 `public/images/posts/`，正文地址使用 `/images/posts/...`。
- 新文章：填写 `permalink` 作为稳定英文短链，发布后尽量不要修改。

Pages CMS 的字段与媒体规则位于 `.pages.yml`。

## 发布

`.github/workflows/deploy.yml` 会在 `source` 分支更新后构建并发布 GitHub Pages。首次启用时，在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。

当前站点是 GitHub 用户站 `lcha-reln.github.io`，因此 Astro 不需要设置 `base`。未来绑定自定义域名时，更新 `astro.config.mjs` 的 `site` 并添加 `public/CNAME` 即可。

## 主要结构

```text
src/
  components/       页面组件、搜索和 Mermaid 运行时
  layouts/          全局页面框架
  lib/content.ts    路由、摘要、专题与排序的唯一逻辑入口
  pages/            首页、专题、归档、文章、RSS
  styles/           Signal Grid 主题与长文排版
src/content/posts/  新博客的 Markdown 内容源
public/images/posts Pages CMS 图片目录
```

旧 Hexo 内容与配置暂时保留在 `source/` 和 `_config*.yml` 中用于归档，但新的构建链不会读取它们。
