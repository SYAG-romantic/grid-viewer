# vendor 依赖记录

本地化的第三方库。升级时按此表替换文件，并同步更新 SHA-256。

| 文件 | 来源 | 版本 | 大小 | SHA-256 |
|---|---|---|---|---|
| ol.css | https://cdn.jsdelivr.net/npm/ol@10.11.0/ol.css | OpenLayers 10.11.0 | 6,343 字节 | abc8afd72cc10bd29cc143f443bae4a6804bd3cb3fb262e6b6a6bc6c924ea34f |
| ol.js | https://cdn.jsdelivr.net/npm/ol@10.11.0/dist/ol.js | OpenLayers 10.11.0（UMD 全局构建） | 1,070,771 字节 | a4e607e98b56846d543e2131161720845c7a80170d5f00aa2bc8b6c4e0f9194a |
| xlsx.full.min.js | https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js | SheetJS 0.18.5 | 881,727 字节 | c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99 |

## 说明

- **ol.js 末尾保留了 `//# sourceMappingURL=ol.js.map`**，`ol.js.map` 未下载。打开浏览器开发者工具时 Network 面板会出现一条 404，不影响任何功能。若要消除，把 map 文件放入本目录即可。
- 三个文件均未做任何修改，与官方发行版逐字节一致，可用 SHA-256 校验。
- OpenLayers 原引用为浮动版本 `ol@10`（会跟随 CDN 上最新的 10.x）。本地化时解析到的具体版本是 **10.11.0**，已锁定。今后不会因上游发版导致行为变化，升级需手动替换并验证。
- **xlsx 0.18.5 已知问题**：这是 npm 上最后一个公开版本，之后 SheetJS 迁至自有源。该版本有公开的原型污染与 ReDoS 记录（后续 0.19 / 0.20 系列修复）。本项目只用到 `XLSX.read` / `XLSX.utils` / `XLSX.writeFile`，若升级需实测导出结果。
