# 「我的 AI」连接 Codex 验收

2026-11-15 在 Windows 客户端通过「我的 AI → 连接资料」按钮对应的客户端接口启用 Codex。桌面操作工具启动失败，因此由该接口完成连接，随后在新 Codex 会话使用原生 `wanx-memobox` MCP 工具对真实盒子进行两轮只读验收。记忆、星图和空间的所有调用均省略 `task_id`。

## 验收步骤与结果

1. **记忆**。用 `memory_search` 检索「空间 自动备份」，从命中中取 `memoryId`，调用 `memory_read`。返回非空 `body`，通过。
2. **星图**。用 `starlink_warehouses` 列出两个可读仓库，分别传入各仓库的 `warehouseId` 调用 `starlink_search`。首轮检索「系统」和「产品」均返回零条命中。
   - 补验时在两个仓库中按完整文件名 `来自半人马AI创始人的一封信_手机版.pdf` 调用 `starlink_search`。共返回 4 条命中，其中 3 条标题与完整文件名一致。
   - 从标题完全一致的命中中取 `evidenceId`，连同该命中所属的 `warehouseId` 调用 `starlink_evidence`。返回非空 `text`，通过。
3. **空间**。先调用不带 `folderId` 的 `space_list` 列出根目录，再把返回的目录 ID 作为 `folderId` 继续列出子目录。选取普通 `.md` 文件，把其 `fileId` 传给 `space_read`。返回非空 `text`，通过。

两轮调用均未报错。三项均确认能在省略 `task_id` 时读到非空正文。验收只执行读取，记录仅保留复现步骤与结果。
