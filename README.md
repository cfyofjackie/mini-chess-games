# Mini Chess Games · 棋类小游戏合集

**🎮 在线游玩：https://cfyofjackie.github.io/mini-chess-games/**

同一网页里的棋类游戏大厅：大厅选择入口，每种棋独立分包、按需加载。

- **独立钻石**：单人解谜。跳过紧邻的棋子落入空位，被跳过的棋子移除，目标是最后只剩一颗（落在中心即为「天才」）。内置 AI 求解器：随时**提示一步**，或让 AI **自动演示**完整通关路线。
- **五子棋**：15 路同屏双人对弈，黑先白后，横竖斜五连即胜（自由规则）。

现已升级为**游戏大厅**结构（hash 路由 + 注册表），更多棋类（五子棋、跳棋）按 [docs/PLATFORM.md](./docs/PLATFORM.md) 的路线接入。

![技术栈](https://img.shields.io/badge/React_18-Vite_5-TypeScript-5b5bd6)

## 独立钻石玩法

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

## 本地游玩（三步打开）

1. 打开一个终端（PowerShell / Git Bash 均可），进入项目目录：

   ```bash
   cd D:\dev\peg-solitaire
   ```

2. 启动本地服务（第一次使用前需先执行过一次 `npm install`）：

   ```bash
   npm run dev
   ```

3. 看终端里打印的地址，用浏览器打开——默认是 **http://localhost:5173**

- **关闭**：回到终端按 `Ctrl + C`
- **再次游玩**：重复第 2、3 步即可（`npm install` 整台电脑只需做一次）
- 命令挂着没关系：终端窗口开着它就一直运行，关了终端它就停了，下次重开
- 两个模式的区别：`npm run dev` 是日常游玩/开发用的（改动即时生效，无需构建）；`npm run build` + `npm run preview` 是预览"和线上一模一样"的正式版本（改完代码后需先 build）
- 直接双击 `index.html` 打不开（浏览器对本地文件的模块加载限制），必须走上面的服务方式

## 项目结构

```
src/
├── games/
│   ├── registry.ts        # 游戏注册表（大厅与路由的唯一数据源）
│   ├── peg-solitaire/     # 独立钻石：engine/ + solver/ + ui/
│   └── gomoku/            # 五子棋：engine/ + ui/
├── hub/                   # 游戏大厅
├── App.tsx                # hash 路由分发（大厅 / 各游戏）
└── main.tsx
```

架构与设计细节见 [DESIGN.md](./DESIGN.md)；多棋类游戏大厅的规划见 [docs/PLATFORM.md](./docs/PLATFORM.md)。

## 部署到 GitHub Pages

线上地址：**https://cfyofjackie.github.io/mini-chess-games/**

1. 推送到 GitHub 仓库 `cfyofjackie/mini-chess-games`
2. 仓库 **Settings → Pages → Source** 选择 **GitHub Actions**（已配置）
3. 之后每次 push 到 `main`，工作流会自动跑测试、构建并发布

构建使用相对路径（`base: './'`），无需按仓库名调整配置。
