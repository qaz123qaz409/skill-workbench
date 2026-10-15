/**
 * 内置工作流 SOP 模板。
 * 格式规范参考 strands-agents/agent-sop（AWS 开源）：
 * Overview / Parameters / Steps+Constraints(RFC2119) / If-Otherwise 条件步 /
 * 负向约束带原因 / 终止与升级 / 输出契约 / Troubleshooting。
 * 该结构经 SOP-Bench 验证对 LLM 执行多步 SOP 的决策点/校验/升级最友好。
 */
export interface SopTemplate {
  key: string
  name: string
  scenario: string
  skills: string[]
  sop: string
}

export const SOP_TEMPLATES: SopTemplate[] = [
  {
    key: 'full-check',
    name: '串联全检型（条件追查）',
    scenario: '从主状态出发，按结果动态追查关联能力，产出全检结论',
    skills: ['入驻管理查询', 'MA查询', 'VA查询'],
    sop: `# 商户入驻全检

## Overview
目标：对商户做端到端全检，产出可直接答复用户的全检结论。
适用：用户询问入驻进度、商户全貌、上线前检查时使用。

## Parameters
- merchant_id (required): 商户ID/邮箱/名称任意一种
约束：
- 你 MUST 在开始前确认必填参数已具备；缺失时 MUST 一次性向用户索要，不得逐个追问

## Steps
### 1. 入驻状态确认
调用「入驻管理查询」，参数 merchantId 取 {{merchant_id}}。
约束：
- 你 MUST 从输出中记录入驻状态与邮箱字段
- If 状态为 frozen 或 rejected，你 MUST 进入步骤2追查关联
- If 状态为 active，你 MUST 跳到步骤3确认收款能力

### 2. 邮箱关联核实（条件步）
调用「MA查询」，参数 email 取步骤1输出的邮箱字段。
约束：
- If 步骤1输出无邮箱，你 MUST NOT 编造邮箱（因为编造会污染结论并可能查到他人账户），在结论中注明「无法核实关联」
- 你 MUST 记录 MA 状态

### 3. 收款能力检查（条件步）
调用「VA查询」，参数取前序输出的账号字段。
约束：
- If VA 列表为空，你 MUST 在结论中注明「VA 未开通」
- 你 SHOULD 记录 VA 数量与币种

## 终止与升级
- 各适用步骤执行完毕后 MUST finish 产出结论
- If 任一能力执行失败，你 MUST NOT 用相同参数重复调用（因为无意义的重试只浪费步数），注明失败项后 finish

## 输出契约
结论 MUST 包含：入驻状态 / 异常项（含查询失败项）/ 建议动作

## Troubleshooting
- 查询无结果：换用另一种标识（邮箱/名称）重试一次
- 想调的能力不在白名单：MUST NOT 调用，在结论中说明未覆盖项`,
  },
  {
    key: 'root-cause',
    name: '异常根因追查型',
    scenario: '从用户报告的异常出发，先复现再交叉佐证，给出根因假设',
    skills: ['AE工作站其他信息查询', 'MA查询'],
    sop: `# 异常根因追查

## Overview
目标：定位用户所报异常的根因，给出证据链与处理建议。
适用：用户报告账号/资金/状态异常，需要追查原因时。

## Parameters
- target_id (required): 异常对象的标识（店铺ID/邮箱）
- symptom (required): 用户描述的异常现象

## Steps
### 1. 异常复现与现状采集
调用「AE工作站其他信息查询」，参数 sellerId 取 {{target_id}}。
约束：
- 你 MUST 对照 {{symptom}} 核对输出中的账号状态、保证金、绑定信息
- 你 MUST 记录与症状一致或不一致的字段

### 2. 交叉佐证（条件步）
If 步骤1发现邮箱或账户关联线索，调用「MA查询」核实该邮箱的关联状态。
Otherwise 跳过本步并在结论中说明缺少佐证。
约束：
- 你 MUST NOT 仅凭单一来源下根因结论（因为单源可能是缓存或脏数据）

### 3. 根因归纳
基于步骤1-2的证据归纳根因假设。
约束：
- If 证据不足，你 MUST 给出「待核实」结论并列出还需人工查什么，不得臆断

## 终止与升级
- 证据链闭合或步数将尽时 MUST finish
- If 疑似风控/冻结类根因，MUST 在建议动作中注明「转人工风控核实」

## 输出契约
结论 MUST 包含：现状字段摘录 / 根因假设（含置信度）/ 证据来源步骤 / 建议动作

## Troubleshooting
- 标识查无此户：MUST 向用户确认标识类型后换标识重试一次`,
  },
  {
    key: 'cross-check',
    name: '多源交叉核对型',
    scenario: '同一对象查两个来源，比对差异并列出分歧项',
    skills: ['MCC信息_公司网址查询', '入驻管理查询'],
    sop: `# 多源交叉核对

## Overview
目标：对同一商户从两个独立来源取数比对，产出一致性核对结论。
适用：需要验证商户信息真实性/一致性的场景。

## Parameters
- merchant_key (required): 商户名/商户ID/邮箱

## Steps
### 1. 来源A取数
调用「MCC信息_公司网址查询」，参数 merchantName 取 {{merchant_key}}。
约束：
- 你 MUST 记录公司名、网址、MCC 等关键字段

### 2. 来源B取数
调用「入驻管理查询」，参数取 {{merchant_key}}。
约束：
- 你 MUST 记录主体名称、注册区域等关键字段

### 3. 比对与分歧列表
逐字段比对两源输出。
约束：
- 你 MUST 列出所有分歧字段及两源各自取值
- If 两源主体名称不一致，你 MUST 标记为高风险分歧

## 终止与升级
- 比对完成 MUST finish
- If 任一来源查询失败，MUST 注明「单源核对」并降级输出

## 输出契约
结论 MUST 包含：一致项摘要 / 分歧项列表（字段+两源取值）/ 风险评级 / 建议动作

## Troubleshooting
- 模糊搜索命中多条：MUST 选择主体名称最匹配的一条并注明`,
  },
  {
    key: 'trace',
    name: '单据链路追踪型',
    scenario: '按单号查单据状态，异常时沿链路补查关联信息',
    skills: ['Voyager订单查询', 'MA查询'],
    sop: `# 单据链路追踪

## Overview
目标：追踪单据当前状态，状态异常时补查关联信息并给出处理建议。
适用：用户咨询订单/单据进度或异常。

## Parameters
- order_id (required): 单号

## Steps
### 1. 单据状态查询
调用「Voyager订单查询」，参数 orderId 取 {{order_id}}。
约束：
- 你 MUST 记录订单状态、金额、时间线字段

### 2. 异常补查（条件步）
If 状态为失败/取消/超时，调用「MA查询」核实下单账户关联状态。
Otherwise 直接 finish。
约束：
- 你 MUST NOT 对正常状态单据过度追查（因为会增加无谓调用）

## 终止与升级
- 状态正常或补查完成 MUST finish
- If 涉及退款/资金异常，MUST 在建议动作中注明转人工处理

## 输出契约
结论 MUST 包含：单据状态 / 异常项 / 建议动作

## Troubleshooting
- 单号查无：MUST 提示用户核对单号格式（Voyager 订单号前缀）`,
  },
  {
    key: 'blank',
    name: '空白骨架（仅格式规范）',
    scenario: '只带格式骨架，自由填写业务内容',
    skills: [],
    sop: `# [工作流名称]

## Overview
目标：[一句话目标]
适用：[什么时候用]

## Parameters
- param_a (required): [描述]
约束：
- 你 MUST 在开始前确认必填参数齐备，缺失时一次性索要

## Steps
### 1. [起始步骤]
调用「[原子能力准确名称]」，参数 [x] 取 {{param_a}}。
约束：
- 你 MUST 记录输出中的 [关键字段]
- If [条件]，你 MUST [动作]；Otherwise [替代动作]

### 2. [条件追查步骤]
[描述]
约束：
- 你 MUST NOT [禁止动作]（因为 [原因]）

## 终止与升级
- [何时 MUST finish]
- If [能力执行失败]，MUST NOT 同参重试，注明失败项后 finish

## 输出契约
结论 MUST 包含：[要素1] / [要素2] / 建议动作

## Troubleshooting
- [常见异常]：[处理方式]`,
  },
]
