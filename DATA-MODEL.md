# NT账本 · 数据模型契约

> 这份文档定义「数据怎么组织、怎么算、什么绝对不允许」。
> 任何改动如果违反这里的条款，即使功能看起来正常，也算 bug。
> 界面设计规范（颜色、间距、弹窗样式）见 [`DESIGN-RULES.md`](DESIGN-RULES.md)。

**状态：设计已定稿，工程未动工。**

---

## 一、总则：谁是真数据

```
┌──────────────────────────────────────────────┐
│  流水 transactions     ← 唯一事实源（含未来计划）│
│  账户 accounts         ← 配置（维度表）          │
│  规则 rules            ← 固定收支 / 分期 / 债权    │
└──────────────────────────────────────────────┘
              ↓ 只读派生
   汇总 / 分类 / 查询 / Money Way   ← 全是视图
```

| 表 | 性质 | 能否从流水推导 |
|---|---|---|
| `state.transactions` | **事实表**：已发生的 + 已排定的未来 | 它是源头 |
| `state.accounts` | **维度表**：类型/分类/简码/账单日 | ❌ 必须人工维护 |
| `state.rules` | **规则表**：反复发生的模式 | ❌ 是另一类事实 |
| 汇总 / 分类 / 查询 | 视图 | ✅ 全部算出 |

**三条铁律**：

1. 任何「金额」都必须能在流水里找到出处。
2. 视图层**不允许有自己的存储**。
3. 规则改了**只影响未来**，绝不改写已确认的历史。

---

## 二、期初：B2 模型（期初也是一条流水）

### 2.1 定义

```js
{
  id:      '__opening__acc_xxx',
  date:    '2026-01-01',
  from:    '__OPENING__',       // 虚拟账户
  to:      '交行储',
  amount:  '5000',
  note:    '期初',
  opening: true,                // 关键标记
  status:  'confirmed'
}
```

### 2.2 虚拟账户

```js
const OPENING_ACCOUNT = {
  id: '__OPENING__', name: '期初余额',
  cat: '权益类',        // 会计恒等式：资产 = 负债 + 权益
  hidden: true
};
```

**用 id 标记，不用名字**。改名不影响逻辑。

### 2.3 迁移（一次性、幂等）

```js
if (!localStorage.getItem('opening_migrated_v1')) {
  for (const acc of state.accounts) {
    const op = Number(acc.opening) || 0;
    if (!op) continue;
    if (state.transactions.some(t => t.opening && t.to === acc.name)) continue;
    state.transactions.push({ /* 期初流水 */ });
  }
  localStorage.setItem('opening_migrated_v1', '1');
  save();
}
```

迁移后 `acc.opening` 保留但**只读**，不再参与计算。

---

## 三、分期：流水的属性（`inst` 字段）

### 3.1 定义

```js
{
  date: '2026-03-15', from: '交行信1', to: '家电', amount: '12000',
  inst: {
    periods:    12,          // 期数
    firstMonth: '2026-04',
    inherited:  false        // false = 账本内新发生；true = 期初继承
  }
}
```

### 3.2 已还期数：按日期推算，**不存字段**

```js
function paidPeriods(tx, today = new Date()) {
  const start = new Date(tx.inst.firstMonth + '-01');
  const months = (today.getFullYear() - start.getFullYear()) * 12
               + (today.getMonth() - start.getMonth());
  return Math.max(0, Math.min(tx.inst.periods, months));
}
```

**存了就要维护、就会忘记、就会变死表。按日期算永远正确。**

### 3.3 两种分期

| | 新分期 | 期初继承 |
|---|---|---|
| `inherited` | `false` | `true` |
| `periods` 含义 | 总期数 | **期初时的剩余期数** |
| 本金在流水里 | ✅ | ❌（发生在账本之前） |

### 3.4 手续费单独记

手续费是真实成本，**必须单独一条普通流水**，不塞进 `inst`。

### 3.5 提前结清

```js
inst: { ..., settledAt: '2026-10-15' }
```

---

## 四、规则：固定收支 / 债权 / 应付款

### 4.1 数据结构

```js
state.rules = [{
  id: 'rule_001',
  kind: 'recurring' | 'installment' | 'receivable' | 'payable',
  from: '招行储', to: '房租',
  amount: '3000',
  freq: 'monthly',
  dayOfMonth: 1,
  startDate: '2026-01-01',
  endDate: null,
  sourceTxId: 'tx_101',     // 从哪条流水登记来的
  enabled: true
}]
```

### 4.2 规则 → 未来的计划流水

时间推进时，规则按 `freq` 生成 `status: 'planned'` 的流水（见第五章）。

### 4.3 勾选同步：按「变动了几个维度」判断

**去重键只有「目的」（`to`）** —— 金额和渠道都不参与匹配。

```js
function resolveCheckbox(tx) {
  const cands = state.rules.filter(r => r.to === tx.to && r.enabled);
  if (!cands.length) return { action: 'create' };

  let best = null;
  for (const r of cands) {
    const sameFrom = r.from === tx.from;
    const sameAmt  = Number(r.amount) === Number(tx.amount);
    const diff = (sameFrom ? 0 : 1) + (sameAmt ? 0 : 1);
    if (diff <= 1) {
      // 渠道相同优先（付款渠道比金额稳定）
      if (!best || (sameFrom && !best.sameFrom)) best = { rule: r, diff, sameFrom };
    }
  }
  if (best) return { action: 'update', rule: best.rule };
  return { action: 'create', reason: 'both-changed' };
}
```

| 变动 | 维度 | 动作 | 提示 |
|---|---|---|---|
| 只变金额 | 1 | **替换** | `固定收支 32 条更新成功` |
| 只变渠道 | 1 | **替换** | `固定收支 32 条更新成功` |
| **渠道 + 金额都变** | 2 | **新增** | `固定收支 38 条新增成功` |
| 完全一样 | 0 | 替换（无变化） | `固定收支 32 条更新成功` |

**序号是规则表里的行号（1-based）**，会随增删变化。

**不加额外提示**：新增后若旧的仍在启用，由用户自己去固定收支表处理。

---

## 五、流水表三段式（界面契约）

### 5.1 三段定义

| 段 | 状态 | 内容 | 编辑 | 删除 | 控件 |
|---|---|---|---|---|---|
| **① 期初** | `opening: true` | 账本开始时的状态 | ❌ | ❌ 灰色 | 无 |
| **② 当前** | `status: 'confirmed'` | 已确认的事实**（含确定的未来）** | ✅ | ✅ | **☑ 登记为固定收支** |
| **③ 计划** | `status: 'planned'` | 规则演算出的未来 | ❌ 只读 | ❌ | **▲ 提前确认** |

**关键：第二段的日期可以是未来** —— 只要确认过，它就是「确定的未来」，**计入余额**（权责发生制）。

### 5.2 渲染顺序

```
① 期初行
② 当前行（含未来日期的 confirmed）
   —— 20 行空行（手动录入区）——
③ 计划行（灰色、只读）
```

**「上移」不需要移动数据**：

```js
const past      = txs.filter(t => t.opening);
const confirmed = txs.filter(t => !t.opening && t.status !== 'planned');
const planned   = txs.filter(t => t.status === 'planned');
// 渲染时按这个顺序拼接即可
```

`status` 一变，下次渲染自然换段。

### 5.3 两个控件的方向

| 控件 | 位置 | 方向 | 含义 |
|---|---|---|---|
| **☑ 勾选框** | 第二段每行 | 流水 → 规则 | 「这笔是常态，登记/更新到固定收支」 |
| **▲ 小三角** | 第三段每行 | 计划 → 确认 | 「这个计划我认了，提前确认」 |

**形状和位置都不同，不会混淆。**

### 5.4 到期自动固化

```js
function settleDue(today = todayISO()) {
  let n = 0;
  for (const t of state.transactions) {
    if (t.status === 'planned' && t.date && t.date <= today) {
      t.status = 'confirmed';
      t.autoSettled = true;
      n++;
    }
  }
  if (n) save();
  return n;
}
```

**启动时跑一次，幂等**。不需要后台任务。

### 5.5 演算月份

```
③ 计划  [演算 12] 个月
```

改月份 → 只删 `status: 'planned'` 且 `origin: 'rule'` 的，重新生成。
**手工预排的 planned 不受影响。**

### 5.6 空行数量

| 设备 | 空行 |
|---|---|
| 桌面 | 20 行 |
| 手机 | 8 行 |

填了内容后立即补回。

### 5.7 第三段不提供删除

它只是规则的投影，删了下次演算会重建。要让某笔不再发生，去改规则。

---

## 六、口径：余额与「其中分期」不叠加

### 6.1 唯一的余额

```
余额 = 区间期初（Σ date < start）+ 区间内收支
```

### 6.2 「其中分期」是拆解

```
序  账户名称     当前结余      其中分期      说明
 3  交行信1     -¥31,278      ¥10,500      21 期 × ¥500 未还
```

| 概念 | 公式 | 性质 |
|---|---|---|
| 当前结余 | `区间期初 + 区间内转入 − 区间内转出` | 唯一的钱 |
| 其中分期 | `Σ(剩余期数 × 每期金额)` | **拆解说明，不参与加减** |
| ~~真实欠款~~ | ~~余额 - 其中分期~~ | ❌ **不存在，会重复计算** |

### 6.3 区间期初：**算出来的**，不是那条期初流水

这是 B2 模型必须补的条款。选定的统计区间，「期初」不能取那条 `opening` 流水。

```
账本期初    = 那条 __OPENING__ 流水（固定，只在账本起点有意义）
区间期初    = Σ (date < 区间开始日) 的所有 confirmed 流水   ← 动态算出
区间余额    = 区间期初 + 区间内转入 − 区间内转出
```

**为什么必须这样**：

如果直接把期初流水当区间期初，选「2026-10」时那条 `2026-01-01` 的流水根本不在区间里，会被漏掉，结果就变成「10 月的净收支」而不是「到 10 月底的总余额」——原来的对账结果会全变。

### 6.4 任意时点余额（B2 的副产品）

有了「区间期初 = 累计到某日」，就顺带获得一个新能力：

```
2026-06-30 那天，招行储有多少钱？
= Σ (date ≤ 2026-06-30 且 status='confirmed') 该账户的流水
```

字段期初做不到这件事（只有「起点」和「现在」两个状态）。

**算法（前缀和，避免每次重算）**：

```js
function buildTimeline(accountName) {
  const isDebit = ['资产类', '费用类'].includes(catOf(accountName));
  let bal = 0;
  return state.transactions
    .filter(t => t.status === 'confirmed')
    .filter(t => t.to === accountName || t.from === accountName)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(t => {
      const inflow  = t.to   === accountName ? Number(t.amount) : 0;
      const outflow = t.from === accountName ? Number(t.amount) : 0;
      bal += isDebit ? inflow - outflow : outflow - inflow;
      return { date: t.date, balance: bal, tx: t };
    });
}

function balanceAt(accountName, date) {
  const line = buildTimeline(accountName);
  // 二分找最后一个 date ≤ 目标日 的位置
  let lo = 0, hi = line.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (String(line[mid].date) <= date) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? line[ans].balance : 0;
}
```

期初流水（`from = '__OPENING__'`）天然被算作「流入」，不需要特判。

**用途**：

| 用途 | 是否必做 |
|---|---|
| 汇总表选定区间时算区间期初 | **必做**（隐式，用户无感） |
| 「某天各账户余额」快照页 | 可选 |

### 6.5 参与 / 不参与

| 数据 | 参与余额 | 参与「其中分期」 |
|---|---|---|
| 普通流水（confirmed） | ✅ | ❌ |
| 期初流水 | ✅ | 带 inst 则 ✅ |
| 计划流水（planned） | ❌ | ❌ |
| 分期本金 | ✅（一次） | ✅ |

---

## 七、校验规则

| 编号 | 校验 | 不通过说明 |
|---|---|---|
| V1 | 每个有余额的账户必须能追溯到期初流水或流水链 | 余额凭空出现 |
| V2 | 流水的 `from`/`to` 必须能在账户表里找到，或等于 `__OPENING__` | 「对不上的名称」 |
| V3 | 新分期（`inherited: false`）的本金 = 这条流水金额 | 分期本金对不上 |
| V4 | 期初分期（`inherited: true`）**跳过 V3** | 本金在账本之前 |
| V5 | `periods` 正整数、`firstMonth` 合法月份 | 数据损坏 |
| V6 | `settledAt` 存在时，`paidPeriods` 不小于 `periods` | 结清了但期数没走完 |

**警告项**（不阻止使用）：

- 分期含「未来月份」（`firstMonth` 晚于今天）
- 某账户 `其中分期 > |余额|`
- 账户改名后历史流水仍是旧名

---

## 八、边界与已知代价

### 8.1 存名字，不存 id

流水 `from`/`to` 存**账户名**。

| 好处 | 代价 |
|---|---|
| 导出直观可读 | **改名会让历史流水断链** |
| 无 join | 校验会报「对不上的名称」 |

**这是有意的取舍**。虚拟账户 `__OPENING__` 是唯一用 id 的例外。

### 8.2 第二段含未来日期 → 余额会被提前扣减

用户确认了「12 月房租」，10 月看余额就已经扣掉了。
**这是权责发生制的必然结果，不是 bug。**

界面上未来日期的行要有「未来」标识。

### 8.3 规则与历史的边界

改规则 → 只重建 `planned`，`confirmed` 一条不动。

---

## 九、落地顺序（每步可独立上线、独立回滚）

| 步 | 做什么 | 风险 | 可上线 |
|---|---|---|---|
| 1 | 流水加 `inst` / `status` / `origin` / `ruleId` 字段 | 极低 | ✅ |
| 2 | 期初迁移（字段 → 期初流水） | 低（幂等） | ✅ |
| 3 | `computeStats` 去掉 `+ opening` | 中 | ✅ |
| 4 | 新建 `state.rules`，`state.fixed` 迁进去 | 低 | ✅ |
| 5 | 流水表三段式渲染 + 20 行空行 | 中 | ✅ |
| 6 | ☑ 勾选 → 规则（按变动维度判断） | 中 | ✅ |
| 7 | ▲ 提前确认 + 到期自动固化 | 低 | ✅ |
| 8 | 演算月份设置 | 低 | ✅ |
| 9 | 汇总表加「其中分期」列 | 低 | ✅ |
| 10 | 校验页补 V1~V6 | 低 | ✅ |

**第 1、2 步做完，现有账本完全不变**（新字段没人用），但底层能力已具备。

---

## 十、一句话版本

> **流水是唯一事实源，分三段：期初（历史）/ 当前（已确认，含确定的未来）/ 计划（规则演算，只读）。期初是一条对手方为虚拟权益账户的流水；分期是流水的 `inst` 字段，已还期数按日期推算不存盘；固定收支是规则，勾选时按「变动了几个维度」决定替换还是新增（0~1 变替换，2 变新增）；余额只算已确认的，`其中分期` 是拆解不是追加；区间期初是「区间开始前的累计余额」动态算出，因此任意时点的余额都可查。**

---

*设计定稿，工程待启动。*
