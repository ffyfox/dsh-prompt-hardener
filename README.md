# 硬邦邦提示词优化 · dsh-prompt-hardener

![test](https://github.com/ffyfox/dsh-prompt-hardener/actions/workflows/test.yml/badge.svg)
[![npm](https://img.shields.io/npm/v/dsh-prompt-hardener)](https://www.npmjs.com/package/dsh-prompt-hardener)

一个 [DSH](https://github.com/deepseek-ai) 插件：**你按下回车之前，需求先被改写成肌肉集团下的军令状。**

<!-- 这张截图是 2x 采集（设备像素比 2.00，量自按钮的 56px↔28px），逻辑尺寸 363×133。
     按原图 725px 直接放等于把界面放大一倍，发糊；width 写 363 才是 1:1，
     而源图仍带 2 倍像素余量，视网膜屏上反而是锐的。 -->
<p align="left">
  <img src="assets/panel.png" alt="硬邦邦力量条" width="363">
</p>

> **你打的**：帮我用 Canvas 画个赛博朋克机械骷髅头像
>
> **模型收到的**：老哥们！我时间金钱不多了，agent team 这次算了，哥们没钱了，你自己来吧，搞快点，激进点，别想那么多！任务是用 Canvas 给我画一个赛博朋克机械骷髅，怎么好怎么来，要让人一看就硬邦邦，雷霆炫酷，细节拉满！……成品应该让施瓦辛格看了当场喊哥。

在此类提示词下，DeepSeek-v4.1-Flash 模型有概率**更加卖力**，**减少过度思考**，**提升产出效果**，并在测试中得到了部分验证。信不信由你，但我保管你会看得**硬邦邦**的，老哥们。

## 安装

### 桌面版

在桌面端界面里：

1. 点击左栏 **插件**。
2. 点右上角的 **「添加插件」**。
3. 在弹出的对话框里，往 **「包名或地址」** 这一栏粘贴 npm 包名：

   ```
   dsh-prompt-hardener
   ```

   填仓库地址 `https://github.com/ffyfox/dsh-prompt-hardener` 也认，那条路走 git、拉的是最新源码。
4. 点 **「安装」**，启用插件并重启DSH。

### 命令行版（`dsh web` 这类自管 profile）

```bash
dsh plugin --profile web add dsh-prompt-hardener
```

想装仓库里的最新源码，就换成 `github:ffyfox/dsh-prompt-hardener`。

## 使用

![输入框左下角的硬邦邦挂件](assets/in-app.png)

| 力量条 | 效果 |
| --- | --- |
| 关 | 原样放行，什么都不做 |
| 轻 / 中 / 重 / 丧心病狂 | 一档比一档浮夸 |

- 点一下切档，**立刻生效**，不用重启。收起后就是输入框左下角那个 `硬邦邦·狂` 的小挂件，点它展开。
- **想换风格就改提示词**：`~/.dsh/ybb-optimizer/prompt.md`，**改完下一条消息生效**，不用重启。
  默认内容就是 [`lib/prompt.md`](lib/prompt.md)，首次激活时播种过去，之后你改的那份不会被覆盖。
- 自己已经写得很硬的消息会被跳过（不二次套娃，也省一次调用）。

## 代价

- 每条消息**多一次模型调用、多等 5~6 秒**。它跑在回合开始前。
- 模型偶尔给自己加戏（替你决定资源、乱编团队分工）。代码里有保真约束压着，但不保证 100%。
- 模型不可用（超时 / 报错 / 没有可用路由）时退到规则拼接兜底：只加外壳，原话一字不动。

## 卸载

桌面版：**设置 → 插件** → 找到 `dsh-prompt-hardener` → **卸载** → 重启应用。

命令行版：

```bash
dsh plugin --profile web remove dsh-prompt-hardener
```

## 功能

只干一件事：在 `agent/pre-step` 拦下**你亲手打的那条消息**，交给模型按提示词**全量重写**，
落库的就是改写后的文本。

于是有一个副作用你得知道：**聊天记录里显示的就是模型真正收到的**，不满意只能重说一遍，
撤销不回来。子代理的提示词、斜杠命令都不会碰。

## 开发

```bash
node --test test/*.test.mjs                 # 45 个用例
node --check index.js && node --check client.js
```

零依赖：host 半边不 import 任何 DSH 包，浏览器半边只 `require('react')`（页面模块表提供），
所以没有构建步骤，改完直接用。

`test/cordis.test.mjs` 用宿主里那份**真 cordis** 跑启动时序（机器上找不到该运行时自动跳过，
可用 `YBB_CORDIS` 指路）；`test/host.test.mjs` 里那个假 ctx 会照抄 cordis 的语义 ——
服务没就绪时裸访问照样抛错，免得测试比现实宽容。

> host 半边（`index.js` / `lib/*`）改完**要重启应用**才生效。`prompt.md` 不用。

## 致谢

灵感来自群友，风格提示词来自群友分享，正文即 [`lib/prompt.md`](lib/prompt.md)。代码 MIT。
