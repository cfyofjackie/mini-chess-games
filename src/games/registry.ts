// 游戏注册表：大厅渲染与路由分发都以此为准，接入新棋只需在这里加一行
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface GameModule {
  /** 路由标识，对应 #/<id> */
  id: string;
  /** 大厅显示名 */
  name: string;
  /** 一句话简介 */
  description: string;
  /** 大厅卡片图标（emoji） */
  icon: string;
  /** 懒加载的游戏入口组件 */
  component: LazyExoticComponent<ComponentType>;
}

export const GAMES: GameModule[] = [
  {
    id: 'peg-solitaire',
    name: '独立钻石',
    description: '跳过邻子，只留一颗，剩得越少越强',
    icon: '🎯',
    component: lazy(() => import('./peg-solitaire')),
  },
  {
    id: 'gomoku',
    name: '五子棋',
    description: '黑白对弈，先连五子者胜（同屏双人）',
    icon: '⚫',
    component: lazy(() => import('./gomoku')),
  },
  {
    id: 'reversi',
    name: '黑白棋',
    description: '夹住翻转，子多者胜（同屏双人）',
    icon: '⚪',
    component: lazy(() => import('./reversi')),
  },
  {
    id: 'chinese-checkers',
    name: '中国跳棋',
    description: '六角星竞速，连跳直奔对岸（同屏双人）',
    icon: '🔴',
    component: lazy(() => import('./chinese-checkers')),
  },
  {
    id: 'xiangqi',
    name: '中国象棋',
    description: '楚河汉界，马炮争锋（同屏双人）',
    icon: '🀄',
    component: lazy(() => import('./xiangqi')),
  },
  {
    id: 'chess',
    name: '国际象棋',
    description: '完整规则：易位·过路兵·升变（同屏双人）',
    icon: '♟️',
    component: lazy(() => import('./chess')),
  },
];

export function getGame(id: string): GameModule | null {
  return GAMES.find((g) => g.id === id) ?? null;
}
