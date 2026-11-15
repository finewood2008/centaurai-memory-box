# 空间 Drive API

应用在 Electron 主进程通过 `host.drive` 访问当前万象用户在当前盒子上的个人空间。同一用户的万象应用共享该 Drive。应用默认文件夹用于组织文件，文件与回收站仍遵循当前用户的空间权限。

以下示例可在 Electron 主进程的 ESM 模块（`.mjs`）中使用。

```js
import {fromEnvironment} from '@centaurai/wanx-host-sdk';

const host = fromEnvironment();
if (!host) throw new Error('请从万象打开应用');
await host.context();

const folder = await host.drive.ensureAppFolder({displayName: '我的应用'});
const file = await host.drive.upload({
  parent: folder.id,
  name: '报告.txt',
  data: '万象应用输出',
});

const chunks = [];
for await (const chunk of host.drive.read(file.id)) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8');
```

| SDK 方法 | HTTP（相对 `/api/personal-space`） |
| --- | --- |
| `overview()` | `GET /overview` |
| `ensureAppFolder({displayName})` | `POST /app-folders` |
| `list({parent, trash})` | `GET /files` |
| `stat(id)` | `GET /files/{item_id}` |
| `mkdir({parent, name})` | `POST /folders` |
| `move({id, parent, name})` | `PATCH /files/{item_id}` |
| `trash(id)` | `DELETE /files/{item_id}` |
| `restore(id)` | `POST /trash/{item_id}/restore` |
| `purge(id)`（永久删除） | `DELETE /trash/{item_id}` |
| `upload({parent, name, data, size, uploadId})` | 组合创建、写块和完成接口 |
| `read(id)` | `GET /files/{item_id}`、`GET /files/{item_id}/content` |
| `createUpload({uploadId, parent, name, size})` | `POST /uploads` |
| `uploadStatus(uploadId)` | `GET /uploads/{upload_id}` |
| `writeChunk(uploadId, {offset, data})` | `PUT /uploads/{upload_id}?offset=…` |
| `completeUpload(uploadId, {digest})` | `POST /uploads/{upload_id}/complete` |
| `cancelUpload(uploadId)` | `DELETE /uploads/{upload_id}` |

`parent` 缺省或为空字符串时表示根目录。上传接受字符串、字节数组和声明了 `size` 的异步字节流，按 4 MiB 分块并校验 SHA-256。同名上传保留两份文件。恢复上传时使用同一个 `uploadId`、相同文件名和目录，从第一个字节重新提供完整内容，SDK 从盒端已保存的偏移继续发送。读文件时完整消费迭代器可验证整文件摘要，大文件可逐块写入目标流。

SDK 类型可从包根导入，例如 `import type {DriveClient, DriveEntry} from '@centaurai/wanx-host-sdk'`。HTTP 参数和响应见 [空间 Drive OpenAPI](octop-modules/personal-space.openapi.json) 的 `x-wanx-application-contract`，空间对象见 [JSON Schema](schemas/space.v1.schema.json)，错误码见 [错误合同](errors.v1.json)。切换盒子、退出账号或会话失效时，当前 Drive 随 Host 会话结束。旧盒子缺少空间能力时，`overview()` 可返回 `SPACE_UPGRADE_REQUIRED`。
