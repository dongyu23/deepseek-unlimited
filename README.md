# DeepSeek Chat-Demo Plus

让 [chat-demo](https://cdn.deepseek.com/chat-demo)（DeepSeek 官方 API demo 页）用上**任意 Anthropic 兼容的第三方模型**，并保持与官网一致的使用体验。

这是从 [dongyu23/deepseek-enhance](https://github.com/dongyu23/deepseek-enhance) 里抽出来的独立项目——原 fork 同时适配主站与 demo 页，本项目只保留 demo 页的第三方模型适配（约 2400 行 → 单文件 138KB），不依赖主站那一套（背景/气泡/防撤回/LaTeX 等）。

## 能做什么

| 能力 | 说明 |
|---|---|
| **第三方模型** | 端点 / Key / 模型名三项覆盖，Base URL 或完整地址都认（`https://api.stepfun.com/step_plan` 这种文档原样填法也能自动补全） |
| **原生形状的搜索** | 第三方端点不认识 DeepSeek 的服务端工具，桥接把它拆成独立的「搜索腿」执行，结果按官方形状（server_tool_use / web_search_tool_result）渲染，含「N 个网页」来源面板 |
| **两种搜索计费** | `native`=DeepSeek 模型驱动搜索（含模型 token 费）；`searchapi`=直调搜索 API，只按次付费（$0.75/1000），不经模型 |
| **搜索参数全透传** | `count`(1~50，条数不影响费用) / `need_content`(带回网页正文) / `ori_question`(原始问题，改善意图理解)，以及 `site:` `lang:` `after:` `before:` 等全套搜索语法——见 [DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search) |
| **会话自动起名** | 官方端点起名腿 / 自定义模型起名 / 关掉，三选一 |
| **图片与文件** | 文本文件内联；图片转 base64 内联（第三方端点不认 DeepSeek 的 file 引用）；可在设置里按模型是否多模态分别处理 |
| **上下文占用环** | 输入框旁实时显示 占用/窗口 百分比，悬浮面板给构成占比与缓存命中率；端点不回 usage 时按请求体估算并标注 |
| **其它** | 会话搜索、粘贴长文本自动转 txt、标签页标题跟随会话名 |

## 与官网的差异（已知）

- 工具块不会被服务端清洗：连续搜索时上下文涨得比官网快（官网由 DeepSeek 服务端自清洗）
- 刷新页面无法续传未完成的生成（官方站可以）
- 搜索是客户端串行循环，延迟高于官网单次请求内的服务端并行搜索

## 安装

1. 装 [Tampermonkey](https://www.tampermonkey.com/)
2. 从 [Releases](https://github.com/dongyu23/deepseek-chat-demo-plus/releases) 或本仓库装 `deepseek-chat-demo-plus.user.js`
3. 打开 chat-demo → 设置 → **自定义模型** → 填端点/Key/模型名，打开总开关

## 与 deepseek-enhance 共存

两个脚本可以同时安装，互不冲突（命名空间相互独立）：

- deepseek-enhance 里**开着** `demoCustom` → 由它接管，本项目自动待机
- deepseek-enhance 里**关着** `demoCustom` → 它在 demo 页完全 inert，由本项目接管

## 开发

```bash
node build.js     # 拼接 src/ → deepseek-chat-demo-plus.user.js
```

源码结构：`src/core/`（配置/选择器/工具/i18n）+ `src/modules/`（demoapi 设置与请求改写、demobridge 工具桥接、ctxring 占用环、demosearch/demopastetxt/tabtitle、toolbar 工具条定位）。

## License

MIT
