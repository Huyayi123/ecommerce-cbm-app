# 电商采购装柜立方数计算 App

React + TypeScript + Vite 前端 MVP，用于维护 SKU 体积资料、上传采购报表、分配采购人，并按 68 CBM 柜容基准和 70 CBM 建议目标计算装柜量。当前版本支持 Supabase Auth 登录、多人云端同步和采购记录共享。

## 初始化与运行

```bash
npm install
npm run dev
```

开发服务启动后打开终端提示的本地地址，通常是 `http://localhost:5173`。

生产构建：

```bash
npm run build
npm run preview
```

## Supabase 配置

1. 新建 Supabase 项目。
2. 打开 Supabase SQL Editor。
3. 执行项目根目录的 [supabase.sql](</c:/Users/HYY/Documents/New project/supabase.sql>)。
4. 在 Supabase Project Settings 中复制 Project URL 和 anon public key。
5. 复制 `.env.example` 为 `.env.local`：

```bash
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

6. 重启开发服务：

```bash
npm run dev
```

新注册用户默认是 `viewer`。需要管理员时，在 Supabase SQL Editor 中执行：

```sql
update public.profiles
set role = 'admin'
where email = '你的邮箱@example.com';
```

角色权限：

- `admin`：查看、新增、编辑、删除全部共享数据
- `buyer`：查看、新增、编辑、导入数据，不能删除
- `viewer`：只读查看

## localStorage 迁移

登录后页面顶部会显示“本机数据迁移”。`admin` 和 `buyer` 可以点击 `导入本机旧数据`，把旧版本保存在浏览器 localStorage 的数据导入 Supabase。

会导入：

- SKU 资料
- 采购 / 海运在途记录
- 装柜计算临时行

## Vercel 部署

1. 将项目推送到 GitHub。
2. 登录 Vercel，选择 `Add New Project`。
3. 导入该 GitHub 仓库。
4. Framework Preset 选择 `Vite`。
5. Build Command 使用：

```bash
npm run build
```

6. Output Directory 使用：

```bash
dist
```

7. 在 Vercel Project Settings -> Environment Variables 添加：

```bash
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

8. 重新 Deploy。

Supabase Auth 如果开启邮箱确认，需要在 Supabase Authentication -> URL Configuration 中配置 Vercel 域名。

## 采购报表格式

支持 `.xlsx`、`.xls`、`.csv`。第一张表需要包含以下字段：

- `SKU`，也兼容 `货号`、`产品编码`、`商品编码`
- `采购数量`，也兼容 `数量`、`qty`
- `采购单价`，也兼容 `单价`、`价格`、`purchasePrice`

也可以上传月销量表生成采购数，表头至少包含：

- `SKU`
- `月销量`，也兼容 `销售数量`、`销量`、`salesQuantity`

## SKU 资料库导入格式

支持 `.xlsx`、`.xls`、`.csv`，第一张表建议包含以下字段：

- `SKU`
- `产品名称`
- `英文名`
- `厂家名`
- `店铺`
- `采购人`
- `单箱长 cm`
- `单箱宽 cm`
- `单箱高 cm`
- `每箱数量`
- `总数量`
- `总立方 CBM`
- `备注`

导入时会自动计算 `单箱体积 CBM` 和 `单个产品体积 CBM`。如果有 `总数量` 和 `总立方 CBM`，会优先按 `单个产品体积 CBM = 总立方 CBM ÷ 总数量` 计算；如果没有这两个字段，则按 `单箱体积 CBM ÷ 每箱数量` 计算。如果导入表格里的 SKU 已存在，会覆盖更新该 SKU；如果不存在，会新增。

## 功能结构

- 顶部导航拆为四个页面：`SKU 资料库`、`装柜计算`、`采购 / 在途库存`、`月销量采购建议`
- `src/types.ts`：SKU、采购行、计算结果、柜容汇总类型定义
- `src/utils/calculations.ts`：单箱 CBM、单品 CBM、采购行 CBM、柜容状态计算
- `src/utils/fileParsers.ts`：Excel/CSV 上传解析，基于 `xlsx`
- `src/utils/exporters.ts`：计算结果导出 Excel/CSV
- SKU 资料库也支持导出 Excel/CSV，导出字段包含英文名和厂家名
- SKU 资料库使用 `店铺` 替代原来的 `类目`，并新增 `采购人`
- SKU 资料库支持从 Excel/CSV 导入，同 SKU 会覆盖更新，不同 SKU 会新增
- 计算结果里的采购数量和采购单价可以直接编辑，修改后会实时重新计算总 CBM 和总金额
- 采购记录会保存在浏览器 localStorage，作为海运在途采购报表；到货后批量标记为 `已到货`，不直接删除历史数据
- `src/utils/storage.ts`：SKU 资料 localStorage 持久化
- `src/components/SkuManager.tsx`：SKU 新增、编辑、删除
- `src/components/PurchaseUploader.tsx`：采购报表上传
- `src/components/SummaryCards.tsx`：目标柜容、总 CBM、剩余空间、使用率和状态
- `src/components/ResultsTable.tsx`：逐 SKU 计算结果与异常提醒
- `src/pages/ContainerCalculatorPage.tsx`：装柜计算页，支持保存为采购记录
- `src/pages/PurchaseInventoryPage.tsx`：采购 / 海运在途库存页，支持筛选、编辑、批量到货和历史状态
- `src/pages/SalesSuggestionPage.tsx`：月销量生成采购建议页，支持发送到装柜计算

## 导出规则

SKU 资料库、采购 / 在途库存、装柜计算结果和操作记录都支持导出 Excel/CSV。

导出文件命名规则：

```text
模块名_YYYYMMDD_HHMMSS.xlsx
模块名_YYYYMMDD_HHMMSS.csv
```

例如：

```text
SKU体积资料库_20260512_154500.xlsx
采购在途库存_20260512_154520.xlsx
```

## 重复 SKU 规则

- 上传采购表时，同 SKU 且采购单价相同，会自动合并采购数量
- 保存采购 / 在途库存时，同 SKU、同单价、状态为 `海运在途` 的记录会自动合并
- 同 SKU 但采购单价不同，不自动合并，会提示人工确认

## 操作记录

系统会记录关键操作：

- 谁新增了 SKU
- 谁修改了 SKU
- 谁修改了采购价格
- 谁标记到货
- 谁批量标记到货
- 操作时间

操作记录保存在 Supabase 的 `audit_logs` 表，并可在 `采购 / 在途库存` 页面底部查看和导出。

## 计算规则

- 单箱体积 CBM = 长 × 宽 × 高 ÷ 1,000,000
- 单个产品体积 CBM = 单箱体积 ÷ 每箱数量
- 预计箱数 = 采购数量 ÷ 每箱数量
- 总 CBM = 预计箱数 × 单箱体积
- 总金额 = 采购数量 × 采购单价

状态规则：

- 低于 68 CBM：未满柜，建议继续加货
- 68-70 CBM：达到装柜要求，70 CBM 附近更理想
- 超过 70 CBM：超过建议目标，需确认柜容或调整采购数量
