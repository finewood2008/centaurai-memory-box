# 万象工坊：品牌、界面与项目管理

本次为个人版工坊本机开发更新；未提交代码、未发布正式版，企业版开物的品牌和布局不改。

## 品牌

- 名称：万象工坊，英文 WanX Workshop。
- 图标：深靛蓝圆角底，象牙白的立体「工」，琥珀色方块象征应用持续被打磨。
- 参考现有星图、万象 AI 浏览器、半人马环图标的陶瓷质感、立体造型与光照；不复制它们的符号。
- 原始 PNG：`apps/builder/ui/assets/wanx-workshop-v1.png`。保留透明背景，客户端打包时同步到 `assets/app-icons/workshop-v1.png`，工作台由 Vite 直接引用同一源图。
- 生成方式：内置 image_gen，无 CLI/API 回退。

## 页面

使用深靛蓝标题区、琥珀色主要入口、浅色工作区。项目选中状态增加品牌色和侧边标记；移除应用页重复的大标题，让预览更早出现在首屏。工作台使用同一图标，版本历史延续深蓝标题和清晰卡片。

项目：列表、搜索、全部／已删除、重命名、恢复、永久清理。项目移入已删除只收起开发工作区，已安装应用继续运行。永久清理需先移入已删除；已安装应用仍依赖项目时阻止永久清理。

版本：显示大小及保护原因。保护最新成果、当前采用版、已安装版，以及失败重试或进行中修改所需的基线。清理保留最小版本和字段兼容审计；移除历史源码、编译结果、开发缓存及重复响应快照，回收 SQLite 页面。业务记录不随清理删除。

## 图标生成提示词

```text
Use case: logo-brand. Create ONE production app icon for 万象工坊 (WanX Workshop), a personal AI application-customization studio. The three input images are STYLE REFERENCES ONLY: match their polished tactile 3D app-icon family, ceramic ivory forms, rich colors, careful bevels, soft studio lighting. Do not copy their constellation, cursor, browser window, circular ring or orb symbols. New symbol: a bold elegant abstract Chinese 工 constructed from three interlocking ivory ceramic modular bars, like a small precisely crafted architectural assembly. Make the letterform instantly simple and readable at 32 pixels, with generous negative space. A single small warm amber cube hovering at upper right suggests an application being reshaped; a tiny restrained highlight at the joint suggests intelligent crafting. Central 工 fills about 65% of a rich midnight-indigo rounded-square tile; subtle blue-violet depth and a small warm amber reflected light. Tile is front-facing with very slight dimensional relief, not isometric scene. High-end macOS productivity icon, confident, memorable, beautifully manufactured, not childish. Matte satin ceramic, clean edges, no busy texture. The rounded square occupies 90% of a square canvas, transparent outside the tile, gentle compact shadow. No text, no lettering besides the abstract 工-shaped symbol, no wordmark, no border frame around whole canvas, no sheet with alternatives, no UI mockup, no tools such as hammer or gear.
```

回收站支持“清空回收站”：确认后批量彻底删除可清理项目，释放源码、版本与开发缓存占用。已安装应用依赖的项目保留并说明原因；失败项可重试，成功项不重复执行，业务数据保留。
