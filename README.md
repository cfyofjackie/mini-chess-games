# 独立钻石 · Peg Solitaire

经典单人益智棋的网页版：跳过紧邻的棋子落入空位，被跳过的棋子移除，目标是最后只剩一颗（落在中心即为「天才」）。

内置 AI 求解器：随时**提示一步**，或让 AI **自动演示**完整通关路线。

![技术栈](https://img.shields.io/badge/React_18-Vite_5-TypeScript-5b5bd6)

## 玩法

- 点击棋子选中，高亮位置即所有可落空位，点击空位完成跳跃；触屏同样适用
- 棋子只能沿横竖方向跳过紧邻的一颗棋子
- 无法移动时游戏结束，按剩余棋子数评级：天才（剩 1 且在中心）→ 大师 → 高手 → 优秀 → 良好 → 还不错 → 继续努力
- 工具栏支持悔棋、提示、自动演示、重新开始

## 快速开始

```bash
npm install
npm run dev       # 开发，默认 http://localhost:5173
npm test          # 引擎与求解器单元测试（Vitest）
npm run build     # 类型检查 + 产物构建（dist/）
npm run preview   # 本地预览构建产物
```

## 项目结构

```
src/
├── engine/     # 纯逻辑：位棋盘、走法规则、评分（可独立测试）
├── solver/     # DFS 求解器 + Web Worker（提示 / 自动演示）
└── ui/         # React 界面：棋盘、状态机、工具栏、终局弹窗
```

架构与设计细节见 [DESIGN.md](./DESIGN.md)；多棋类游戏大厅的规划见 [docs/PLATFORM.md](./docs/PLATFORM.md)。

## 部署到 GitHub Pages

1. 推送到 GitHub 仓库（建议名 `peg-solitaire`）
2. 仓库 **Settings → Pages → Source** 选择 **GitHub Actions**
3. 之后每次 push 到 `main`，工作流会自动跑测试、构建并发布到
   `https://<你的用户名>.github.io/peg-solitaire/`

构建使用相对路径（`base: './'`），无需按仓库名调整配置。
