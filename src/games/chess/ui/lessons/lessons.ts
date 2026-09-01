// 新手学堂 8 关数据（docs/games/chess.md 第十一节关卡表）：
// ①认识棋盘与棋子 ②兵的走法 ③兵的升变 ④将死的概念 ⑤王车易位 ⑥吃过路兵 ⑦捉子与保护 ⑧综合小测。
// 全部局面用引擎 position() 构造器描述（pieces + options），任务判定用 goals.ts 的工厂闭包，
// 可在测试里用 makeMove 逐手驱动验证（每关"完成任务→通过 / 错误着法→不通过"）。
// 学堂里黑白双方都由学员操纵（轮到谁就走谁），无 AI 对手——纯闯关教学。
import {
  captureGoal,
  castleGoal,
  checkmateGoal,
  enPassantGoal,
  promoteGoal,
  reachGoal,
  sequenceGoal,
} from './goals';
import type { Lesson } from './types';

export const LESSONS: Lesson[] = [
  // ---------- 第 1 关：认识棋盘与棋子 ----------
  {
    id: 'board-pieces',
    title: '认识棋盘与棋子',
    intro: '棋盘 8×8 共 64 格，每格都有坐标（列 a–h，行 1–8，白方在下）。先和马、后打个照面。',
    stages: [
      {
        brief:
          '马走"日"字，而且能越过挡路的棋子。\n点击白马（b1），让它跳到 c3——先点子，再点带圆点的落点。',
        position: {
          pieces: [
            ['b1', 'N'],
            ['e1', 'K'],
            ['g8', 'k'],
            // 一枚黑兵垫底：避免 K+N vs K 触发引擎"子力不足判和"打断练习
            ['a7', 'p'],
          ],
        },
        goal: reachGoal('c3'),
        complete: '好样的！马走日字，还能越过挡路的棋子。',
      },
      {
        brief:
          '后是全盘最强的子，横、竖、斜任意距离都能走。\n点击白后（d1），沿斜线走到 h5。',
        position: {
          pieces: [
            ['d1', 'Q'],
            ['g1', 'K'],
            ['a8', 'k'],
          ],
        },
        goal: reachGoal('h5'),
        complete: '完成！后的斜线一眼望到底——它一共有 8 个方向的走法。',
      },
    ],
  },

  // ---------- 第 2 关：兵的走法 ----------
  {
    id: 'pawn-moves',
    title: '兵的走法',
    intro: '兵只能向前直进，吃子却必须斜前——规则最特殊的一枚子，分三步练熟。',
    stages: [
      {
        brief: '第一步：直进一格。\n白兵在 e3（不在起始位置），只能向前走一格到 e4。',
        position: {
          pieces: [
            ['e3', 'P'],
            ['e1', 'K'],
            ['e8', 'k'],
          ],
        },
        goal: sequenceGoal([['e3', 'e4']]),
        complete: '直进一格达成！兵不能后退，走每一步都要想好。',
      },
      {
        brief:
          '第二步：起始两格。\n兵还在起始位置（白方第 2 行）时，可以选择直进两格。把 e2 的兵走到 e4。',
        position: {
          pieces: [
            ['e2', 'P'],
            ['e1', 'K'],
            ['e8', 'k'],
          ],
        },
        goal: sequenceGoal([['e2', 'e4']]),
        complete: '起始两格达成！注意：中间格（e3）必须为空才能跳两格。',
      },
      {
        brief:
          '第三步：斜吃。\n兵吃子必须斜前方一格，直进遇到敌子反而走不动。\n黑兵站在 d6——用 e5 的白兵斜进吃掉它！',
        position: {
          pieces: [
            ['e5', 'P'],
            ['d6', 'p'],
            ['g1', 'K'],
            ['a8', 'k'],
          ],
        },
        goal: captureGoal('d6'),
        complete: '斜吃达成！兵是唯一"斜走必须吃"的棋子。',
      },
    ],
  },

  // ---------- 第 3 关：兵的升变 ----------
  {
    id: 'pawn-promotion',
    title: '兵的升变',
    intro: '兵走到对方底线必须升变为后 / 车 / 象 / 马之一——小兵也能变皇后。',
    stages: [
      {
        brief:
          '把 b7 的白兵推进到底线 b8。\n会弹出升变选择浮层——推荐选"后"（选别的也行，随时可取消重选）。',
        position: {
          pieces: [
            ['b7', 'P'],
            ['f1', 'K'],
            ['h6', 'k'],
          ],
        },
        goal: promoteGoal('b8'),
        complete: '升变成功！兵变成了新棋子，之后按它的走法继续战斗。',
      },
    ],
  },

  // ---------- 第 4 关：将死的概念 ----------
  {
    id: 'checkmate-basics',
    title: '将死的概念',
    intro:
      '将军＝攻击对方王；将死＝对方王被将军且无路可逃，游戏立刻结束。本关你同时操纵双方（轮到谁就走谁），亲手完成将死。',
    stages: [
      {
        brief:
          '先来一手杀：白王 b6 已守住 a7、b7、c7 三格，黑王被困在 b8。\n点击白车（h1），直上 h8——将死！',
        position: {
          pieces: [
            ['b6', 'K'],
            ['h1', 'R'],
            ['b8', 'k'],
          ],
        },
        goal: checkmateGoal(),
        complete: '将死！黑王被将军，逃格全被占/受攻，又吃不到车——这就是将死。',
      },
      {
        brief:
          '王车配合三步杀（黑方也由你走，照提示来）：\n① 白王上前 g6，守住 g7 / h7 / f7；\n② 黑王只能退 g8；\n③ 车 a8 沉底——将死！\n着法：f6→g6，h8→g8，a7→a8。',
        position: {
          pieces: [
            ['f6', 'K'],
            ['a7', 'R'],
            ['h8', 'k'],
          ],
        },
        goal: checkmateGoal(),
        complete: '王车配合的"杀王网"搭好了：王守住关键格，车完成绝杀。',
      },
    ],
  },

  // ---------- 第 5 关：王车易位 ----------
  {
    id: 'castling',
    title: '王车易位',
    intro:
      '易位＝王向车方向横移两格，车跳到王旁边——一手同时完成"王躲进角落 + 车出动"。条件：王车均未动过、之间无子、王不在将军中、经过与到达格不受攻。',
    stages: [
      {
        brief:
          '短易位：王 e1 与车 h1 之间（f1、g1）无子，路径不受攻。\n点击白王（e1），走到 g1——车会自动跟到 f1。',
        position: {
          pieces: [
            ['e1', 'K'],
            ['h1', 'R'],
            ['e8', 'k'],
            ['h8', 'r'],
          ],
        },
        goal: castleGoal('short'),
        complete: '短易位完成！王躲进角落，车也出动了——一举两得。',
      },
      {
        brief:
          '长易位：往另一侧（后翼）也可以易位。\n点击白王（e1），走到 c1——车会自动跟到 d1。',
        position: {
          pieces: [
            ['e1', 'K'],
            ['a1', 'R'],
            ['e8', 'k'],
            ['a8', 'r'],
          ],
        },
        goal: castleGoal('long'),
        complete: '长易位完成！同样的规则，两侧都适用。',
      },
    ],
  },

  // ---------- 第 6 关：吃过路兵 ----------
  {
    id: 'en-passant',
    title: '吃过路兵',
    intro:
      '对方兵从起始位置直进两格时，会"路过"与你兵相邻的格——仅限下一手，你的兵可以斜进吃掉它。机会即逝！',
    stages: [
      {
        brief:
          '黑兵刚从 d7 直进两格到 d5，越过了 d6（过路格）。\n用 e5 的白兵斜进到 d6——把路过的黑兵吃掉！',
        position: {
          pieces: [
            ['e5', 'P'],
            ['d5', 'p'],
            ['g1', 'K'],
            ['e8', 'k'],
          ],
          options: { enPassant: 'd6' },
        },
        goal: enPassantGoal(),
        complete: '吃过路兵！注意被吃的黑兵其实站在 d5——这就是"机会即逝"的一手。',
      },
      {
        brief:
          '换你执黑：白兵刚从 b2 直进两格到 b4，越过了 b3。\n用 c4 的黑兵斜下到 b3——吃掉它！（点击轮到走子的黑兵）',
        position: {
          pieces: [
            ['c4', 'p'],
            ['b4', 'P'],
            ['g1', 'K'],
            ['g8', 'k'],
          ],
          options: { current: 2, enPassant: 'b3' },
        },
        goal: enPassantGoal(),
        complete: '黑方同样可以吃过路兵——这条规则对两色一视同仁。',
      },
    ],
  },

  // ---------- 第 7 关：捉子与保护 ----------
  {
    id: 'capture-defense',
    title: '捉子与保护',
    intro:
      '"保护"＝有己方棋子能吃回来。用有保护的子去吃无保护的子，才不吃亏；反过来，有保护的子被吃也别怕——反吃回来。',
    stages: [
      {
        brief:
          '白马 e3 有 d2、f2 两个兵保护；黑象 f5 孤立无保护。\n点击白马，吃掉 f5 的象！',
        position: {
          pieces: [
            ['e1', 'K'],
            ['e3', 'N'],
            ['d2', 'P'],
            ['f2', 'P'],
            ['f5', 'b'],
            ['e8', 'k'],
          ],
        },
        goal: captureGoal('f5'),
        complete: '马吃象成功——就算黑方想反吃也无子可来。这就是"有保护吃无保护"。',
      },
      {
        brief:
          '黑象 b4 正捉着你的马 c3——但马有 b2 兵保护，所以被吃也别怕。\n照提示走（黑方也由你操纵）：黑象吃马 b4→c3，再 b2 兵反吃 b2→c3（顺带解将）。',
        position: {
          pieces: [
            ['e1', 'K'],
            ['c3', 'N'],
            ['b2', 'P'],
            ['b4', 'b'],
            ['e8', 'k'],
          ],
          // 轮到黑方先走（黑象吃马是提示剧本的第一手，黑方也由学员操纵）
          options: { current: 2 },
        },
        goal: sequenceGoal([
          ['b4', 'c3'],
          ['b2', 'c3'],
        ]),
        complete: '反吃成功！有保护的子被吃，吃回来不吃亏——保护就是底气。',
      },
    ],
  },

  // ---------- 第 8 关：综合小测 ----------
  {
    id: 'mixed-quiz',
    title: '综合小测',
    intro: '毕业考试！连续完成 3 个混合任务：吃子、易位、将死。全对即出师。',
    stages: [
      {
        brief: '第 1 题（吃子）：白象 c3 沿斜线对准了 e5 的黑兵——吃掉它！',
        position: {
          pieces: [
            ['e1', 'K'],
            ['c3', 'B'],
            ['e5', 'p'],
            ['e8', 'k'],
          ],
        },
        goal: captureGoal('e5'),
        complete: '第 1 题完成：象沿斜线吃子。',
      },
      {
        brief: '第 2 题（易位）：条件齐备——完成一次短易位（点击王 e1 走到 g1）。',
        position: {
          pieces: [
            ['e1', 'K'],
            ['h1', 'R'],
            ['e8', 'k'],
            ['h8', 'r'],
            ['d3', 'P'],
            ['d6', 'p'],
          ],
        },
        goal: castleGoal('short'),
        complete: '第 2 题完成：王车易位一手到位。',
      },
      {
        brief:
          '第 3 题（将死）：白后 d1、白王 b6，黑王被困 b8。\n用后完成绝杀——提示：d1→d8。',
        position: {
          pieces: [
            ['b6', 'K'],
            ['d1', 'Q'],
            ['b8', 'k'],
          ],
        },
        goal: checkmateGoal(),
        complete: '🎓 毕业了！三道题全部完成——你已掌握入门所需的基本功，回对局试试身手吧。',
      },
    ],
  },
];
