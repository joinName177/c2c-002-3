# c2c-002 · 情绪植物园

Vue 3 + TypeScript + Vite 纯前端情绪记录与虚拟植物花园。每日记录情绪会种下一株对应植物，连续记录让植物从种子、发芽、开花到结果；断签后保留枯萎标本，并提供生长时间轴和情绪生态年报。数据保存在浏览器 `localStorage`。

## 分层

- 核心层 `src/core`：情绪记录、连续天数、植物生长阶段、枯萎判断、生态年报
- 端口层 `src/ports`：花园快照仓储接口
- 适配器层 `src/adapters`：浏览器本地存储实现
- 界面层 `src/ui`：Vue 页面与原生 CSS 视图

## 命令

```bash
npm install
npm run dev
npm run build
docker compose up --build
```

访问 `http://localhost:8102`。
