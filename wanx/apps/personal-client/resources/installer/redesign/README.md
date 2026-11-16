# 安装器静态素材

仅用于半人马AI记忆盒子的安装过程。保留现有半人马图标，使用暖白、棕灰和清晰留白，不包含轮播或视频。

维护者生成命令：

```sh
python3 tools/generate-installer-presentation.py
```

需要 Pillow 和中文字体。macOS 会查找系统 PingFang SC，也可使用 `--font /path/to/font.ttf`。打包直接读取已提交素材，无需 Python 或字体依赖。

| 素材 | 像素尺寸 | 用途 |
| --- | --- | --- |
| windows-mark.bmp | 160 × 160 | 原生欢迎页产品标识 |
| windows-header.bmp | 150 × 57 | NSIS 页头标识 |
| windows-sidebar.bmp | 164 × 314 | 原生完成／卸载页侧图 |
| mac-dmg.png | 760 × 480 | DMG 基础背景 |
| mac-dmg@2x.png | 1520 × 960 | 相同设计的 Retina 背景 |

DMG 中的实际应用和 Applications 图标由 Finder 绘制。背景预留中心 `(204,270)` 和 `(556,270)`、图标尺寸 96 px，不绘制替代图标；中间仅显示拖动方向。`mac-dmg.png` 传给打包器，由其自动寻找同名 `@2x` 素材。
