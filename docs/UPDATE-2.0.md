# 2.0.0 更新说明 / Release Notes

**发布日期：2026-10-19**

2.0 是一次**修复与适配**版本：没有新功能，按钮的行为、两次点击确认、模型里那行中文标记都和
1.0 一样。变的是三件事——修掉一个让按钮在真实环境里根本不出现的启动 bug、让回退记录在重启后
完整保留、以及适配 DSH 新版核心的轮次定位方式。

2.0 is a **fix and compatibility** release: no new features. The button, the two-click
confirm, and the in-model marker line all behave exactly as in 1.0. What changed: a startup
bug that kept the button from ever appearing, restart-safe rewind records, and compatibility
with the newer DSH core's turn addressing.

---

## 1. 修复：全新启动后回退按钮永远不出现（最严重）

**Bug fix: the rewind button never appeared after a fresh start.**

这是 1.0 之后某次本地修改引入的回归，也是"插件装着却看不到按钮"的直接原因。

根因是 `ctx.effect` 的用法。cordis 的语义是：**effect 函数体立即执行，它的返回值才是
teardown**（同批插件的写法可作参照，例如 `ctx.effect(() => () => { … })`）。1.0 的写法是
正确的：

```js
ctx.effect(() => injection.stop, '…')   // 返回 teardown，监听器存活
```

有问题的版本把清理工作写成了函数体本身：

```js
ctx.effect(() => { …; injection.stop() }, '…')   // 当场执行 teardown
```

于是每次启动都发生这样的时序：

1. 页面加载，插件模块 `apply()` 先跑（React 还没渲染聊天记录），第一次扫描看到 0 行；
2. 同一个 tick 里 effect 函数体执行，`injection.stop()` 把 MutationObserver 停掉；
3. 聊天记录随后渲染出来——但监听器已经死了，再没有人扫描，按钮永远不会出现。

修复：teardown 改为**返回式**（并保留清理重试定时器的意图）：

```js
ctx.effect(() => () => {
  if (runtime.refreshTimer !== null) {
    clearTimeout(runtime.refreshTimer)
    runtime.refreshTimer = null
  }
  injection.stop()
}, 'dsh-sqy-rewind: injected user-action button')
```

配套加了回归测试：模拟"先 apply（空页面）→ 后渲染聊天行"的真实时序，旧代码必败、新代码全过。

The root cause was a misuse of `ctx.effect`: cordis runs the effect body immediately and
treats its **return value** as the teardown. A local edit turned the returned teardown into
an inline call, so every startup stopped its own MutationObserver in the same tick it
started it. On a fresh page load the module applies before the transcript renders, the first
sweep finds no rows, and rows appearing later are never scanned.

## 2. 修复：重启后已回退的轮次会"冒回来"

**Fix: rewound turns reappeared after a restart.**

DSH 核心的 surface 折叠会丢掉被遮蔽轮次的 `turn/start` 事件，`turnOutline` 投影因此想不起
被回退的那些轮次。1.0 靠折叠后的投影反推隐藏范围，只能恢复到**第一个**被影藏的轮次——重启后
第一轮还藏着，后面的全部冒回来。

现在回退成功时（此时完整投影还在内存里）就把真实轮次范围写进插件自己的
`.rewind-store.json`（按 `sessionId` → `"<startSeq>:<endSeq>"` 两级键名），重启后优先按记录
隐藏。老构建写的标记或记录丢失时，退回保守估算：起始轮取折叠投影能给出的第一个轮，结束轮取
影藏范围之后第一个保留的 `turn/start` 减一。不需要改 DSH 核心，纯插件本地状态。

`.rewind-store.json` 已加入 `.gitignore`——它是运行时数据，不该进仓库。

The surface fold drops the shadowed turns' `turn/start` events, so after a restart the
turnOutline projection only remembers the *first* shadowed turn. The true range is now
recorded at rewind time into a plugin-local `.rewind-store.json` and replayed on reload,
with a conservative estimation as fallback for markers written by older builds.

## 3. 适配：新版核心的轮次定位方式

**Compatibility: turn anchoring for the newer core.**

DSH 核心（2026-10-10 之后的 nightly）不再给每个 surface 节点盖 `data.turn`，只有
`turn/start` 标记还保留。1.0 里"按 `event.data.turn` 找轮次"的写法在新核心上对每个轮都返回
-1，回退会直接失败。

现在改为**两条谓词并行**，按模型可见顺序取先命中者：

1. 锚定 turnOutline 里该轮的 `turn/start` seq，取它之后第一个真正的 `user/message`
   （跳过 replace 载体——上一轮回退或压缩的标记本身就是 `user/message`），仍以
   `seq > entry.seq` 作为健全性门槛；
2. 同时保留 `event.data.turn === turn` 的直接匹配，兼容旧核心，也覆盖压缩之后的情形：
   当压缩标记只替换更早的轮次时，本轮自己的提问可能已被折叠掉、可见内容以 assistant
   节点开头，此时只有 `data.turn` 还能定位到这一轮的起点。

"按模型可见顺序而不是按 seq 比"这条原有纪律保持不变。两条谓词与既有回归测试
（`tools/verify-entry.mjs`，含两个压缩场景）全部对齐。

The newer core no longer stamps every surface node with `data.turn`, so looking a turn up by
`event.data.turn` returns -1 for every turn. The rewind boundary is now found by **either**
predicate, whichever matches first in surface order: the first real `user/message` after the
turn's `turn/start` seq from turnOutline (skipping replace carriers), **or** a direct
`event.data.turn === turn` match — kept for the old core and for the post-compaction case
where the turn's own prompt has been folded away and the visible turn opens with its
assistant nodes. Both predicates are covered by the existing Host regression tests, including
the two compaction scenarios.

## 4. 加固：用户消息行的轮次号兜底

**Robustness: turn-number fallback for user message rows.**

新版 ui-chat 构建不再保证用户消息行带 `data-chat-turn`（节点的 location 解析不到编号轮次时，
React 会直接省略这个属性）。拿不到轮次号时，现在从它前面紧挨的"轮次过程行"推导：引擎总是先记录
`turn/start` 再记录这一轮的提问，所以前一个兄弟行必然属于同一轮。只采纳最近的、且确实是
`turn-process` 的兄弟行——其他情况一律不猜。

推导出的轮次会**回写**到用户行的 DOM 属性上：回退后的隐藏规则按 `[data-chat-turn]` 藏节点，
不回写的话被回退轮次里你的消息会残留在界面上。

Newer ui-chat builds no longer guarantee `data-chat-turn` on user message rows. The turn is
now derived from the preceding turn-process row (`turn/start` is logged before the turn's
prompt, so that neighbour is always the same turn) and written back onto the flow item, so
the rewind-hiding rules can reach user messages too.

## 5. 加固：会话打开后的有界重试

**Robustness: bounded session-state retry.**

刚打开/切换到的会话在 Host 侧可能还没就绪，第一次 `/api/state` 读到空会让已回退的轮次闪一下
才被藏起来。现在改为廉价、节流、有界（10 次）的重试，直到 Host 回答为止。原来的一次性 guard
换成 `refreshAttempts` + 1.2s 定时器。

A freshly opened session may not be live in the Host yet; the first state read can come back
empty. Reads are now retried — cheap, throttled, bounded at 10 attempts — until the Host
answers.

## 6. 诊断：扫描日志

**Diagnostics: sweep log.**

控制台现在会打一行（情况不变不重复）：

```
dsh-sqy-rewind: sweep rows=6 with=6
dsh-sqy-rewind: sweep rows=3 with=1 skipped kind:steering=1 noTurn=1
```

`rows` 是找到的用户消息行数，`with` 是带上回退按钮的行数，`skipped` 说明其余行为什么被跳过
（`kind:` 开头的不是用户自己的消息，`noTurn` 是推导不出轮次，`noButton` 是行里没有复制按钮）。
按钮再不出现时，这一行就是完整诊断。

One console line per change: rows seen, rows carrying a button, and why the rest were
skipped (`kind:…` is not the user's own message, `noTurn` means no turn could be derived,
`noButton` means the row has no copy control).

---

## 文件变动 / Files changed

| 文件 | 变动 |
|---|---|
| `src/client.js` | 上述第 1、4、5、6 项（浏览器半边） |
| `lib/client.js` | 由 `src/client.js` 经 `build-client.mjs` 重新生成 |
| `entry.js` | 上述第 2、3 项（Host 半边） |
| `package.json` | 版本 `0.1.0` → `2.0.0` |
| `.gitignore` | 忽略运行时数据 `.rewind-store.json` |
| `docs/UPDATE-2.0.md` | 本文件 |

`README.md`、`cordis.patch.yml`、`build-client.mjs`、`tools/`、截图与 LICENSE 均未改动。

## 升级注意 / Upgrade notes

- **无需手动操作**：市场/CLI 装上新版后重启 DSH 即可。旧的 `.rewind-store.json`（如果存在）
  会被继续沿用，格式未变。
- 回退语义、两次点击确认、模型上下文里的那行中文标记均与 1.0 相同。
- 若从 1.0 升级前已经有"装着看不到按钮"的现象，升级后即恢复；控制台出现
  `sweep rows=N with=N` 且 N 等于可见用户消息数，一切正常。
