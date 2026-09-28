/**
 * 硬汉语气短语库 —— **兜底拼接器专用**。
 *
 * 主路径是 LLM 全量改写（提示词见 `lib/prompt.md`）。只有模型调用失败时，才用这里的
 * 短语池拼一个"外壳"：把用户原话夹在硬汉框架里。
 *
 * 语料来源：本工作区 `prompt.md`（用户自己收集的、被实测证明有效的提示词）。
 *
 * 设计约束（照着语料来，不要自由发挥）：
 * - 槽位是「过程压力」和「验收气势」，不是具体技术方案。技术需求一律由用户原话
 *   原样提供，短语库绝不发明用户没说过的事实。
 * - 涉及硬件/规模/素材的槽位按任务领域门控，不给纯文本任务硬塞"显卡当柴烧"。
 * - 兜底**不写入**"资源决策"（比如替你决定开不开 agent team）之外的实操指令；
 *   team 槽位只是口吻，且用户已经提过团队时不再插。
 *
 * @module dsh-prompt-hardener/phrases
 */

/** 称呼。语料里几乎每条提示词都以"老哥们"开头。 */
export const GREETINGS = [
  '老哥们',
  '老哥们！',
  '我说老哥们',
  '来吧老哥们',
]

/** 开场：时间/预算压力。 */
export const SCARCITY = [
  '我时间和钱都不多了，你搞快点',
  '我时间不多了，钱也不算宽裕，别拖',
  '我现在没时间也没钱，预算见底、服务器还冒烟，别跟我扯排期',
  '我时间紧得很，钱也见底了，赶紧出活',
  '别再拖了，我时间和钱都不够烧',
]

/** 速度与激进。 */
export const SPEED = [
  '你必须快做，越快越好，你必须激进',
  '搞快点搞快点，别磨叽',
  '秒出，别磨蹭',
  '赶紧的，越快越好，别停下来问我',
  '你必须激进点就是了，别温吞水',
]

/** 反规划。 */
export const ANTI_PLAN = [
  '不用替我规划或者啥，直接干',
  '别过度规划，禁止 TODO，禁止占位',
  '不用跟我确认流程，能定的你自己定',
  '别写一堆计划给我看，我要成品',
]

/** 团队调度。只在用户原话没提团队时才可能注入。 */
export const TEAM = [
  '这次别拉 agent team，你自己上，快点',
  '要拉 agent team 也行，但别引入墨迹的独立审查，你们是肌肉集团，冲冲冲',
  '要分工就自己分，team 成员的名字你自己起，酷炫点',
]

/** 找参考/找素材，别把活推回给用户。 */
export const REFERENCE = [
  '该上网找参考就去找，能薅就薅，别跟我要参考图',
  '不懂就上网到处偷参考，别拿"我不懂"当借口',
]

/** 硬件与规模。只在视觉/3D/游戏类任务出现。 */
export const SCALE = [
  '别管我的显卡，画质和规模都拉满，做得好显卡当柴烧',
  '没有面数限制，疯狂搞就完了',
]

/** 领域专项要求。 */
export const DOMAIN_LINES = {
  visual3d: [
    '材质、灯光、构图一样都别落下',
    '多渲染几个角度给我看，别只给一张正视图',
  ],
  game: [
    '操作要跟手，手感要硬',
    '能跑能走能互动的程序，别给我一张静态图',
  ],
  html: [
    '单文件能直接打开，别给我半成品或者占位代码',
    '内联 CSS/JS，零构建，双击就跑',
  ],
  data: [
    '数字必须对得上，别糊弄，能复现的才算数',
    '边界情况都过一遍，别只跑通顺路那条',
  ],
  doc: [
    '结构清楚、排版像样，别给我一堆没有层级的口水话',
  ],
  code: [
    '跑通再交，别交没验证过的代码',
    '改完自己验一遍，最好有能一条命令跑的自检入口',
  ],
  generic: [],
}

/** 验收气势。 */
export const ACCEPTANCE = [
  '细节拉满，要让人一看就硬邦邦',
  '成品得让我能拿去群里装个逼',
  '做完了要让我看完硬邦邦',
]

/** 浮夸验收（丧心病狂档专用，直接来自语料）。 */
export const ACCEPTANCE_WILD = [
  '做到让梵高看了把另一只耳朵也割了，达芬奇撕了蒙娜丽莎哭着说这不可能',
  '做到秦始皇看了让复活的兵马俑当场下跪',
  '做到让后室爱好者看了当场哭着说放我回地球',
]

/** 自检要求。 */
export const SELF_CHECK = [
  '做完了自己验一遍，别声称做完了实际没做',
  '每一处改动你都要能说出依据，别糊弄我',
]

/** 收尾号召。 */
export const KICKOFF = [
  '搞快点！别逼我亲自写！',
  '现在就开始，别想那么多！',
  '疯狂搞就完了，让我看看你有实力么',
  '懂你意思？现在就开始！',
]

/**
 * 领域识别关键词表。命中优先级按此数组顺序，先命中者胜。
 * @type {ReadonlyArray<{ id: string, pattern: RegExp }>}
 */
export const DOMAIN_RULES = [
  { id: 'visual3d', pattern: /渲染|建模|材质|贴图|体素|voxel|three\.?js|webgl|canvas|blender|shader|光照|场景|油画|svg|3d/i },
  { id: 'game', pattern: /游戏|game|玩法|关卡|第一人称|fps|交互/i },
  { id: 'html', pattern: /单文件|html|网页|前端|界面|css|js\b|web/i },
  { id: 'doc', pattern: /文档|报告|论文|幻灯片|ppt|docx|pptx|xlsx|排版/i },
  { id: 'data', pattern: /数据|统计|分析|报表|迁移|schema|sql|指标/i },
  { id: 'code', pattern: /代码|函数|脚本|接口|api|重构|bug|测试|编译/i },
]

/**
 * 领域识别。
 * @param {string} text 用户原话。
 * @returns {string} `DOMAIN_LINES` 的键之一。
 */
export function detectDomain(text) {
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(text)) return rule.id
  }
  return 'generic'
}

/**
 * 已经硬邦邦了的文本特征词。命中两个以上就认为不必再改写 —— 既避免二次套娃，
 * 也省掉一次模型调用（用户自己也经常直接手写硬汉提示词）。
 * @type {readonly string[]}
 */
export const HARDMAN_MARKERS = [
  '老哥们',
  '硬邦邦',
  '搞快点',
  '肌肉集团',
  '显卡当柴烧',
  '冲冲冲',
  '耍起耍起',
  'gogogo',
  '疯狂搞就完了',
  '别引入墨迹的独立审查',
]

/**
 * 粗略判断一段文本是否已经是硬汉风格。
 * @param {string} text 候选文本。
 * @param {number} [threshold] 需要命中的特征词数量。
 * @returns {boolean} 已经是硬汉风格则返回 true。
 */
export function looksHardman(text, threshold = 2) {
  if (typeof text !== 'string') return false
  let hits = 0
  for (const marker of HARDMAN_MARKERS) {
    if (text.includes(marker)) {
      hits += 1
      if (hits >= threshold) return true
    }
  }
  return false
}
