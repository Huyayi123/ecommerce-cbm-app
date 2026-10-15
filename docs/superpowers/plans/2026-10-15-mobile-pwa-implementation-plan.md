# 移动端 PWA 实施计划

## 目标

在不改变现有网页端业务口径和权限的前提下，为现有 React/Vite/Supabase 应用增加可安装的 PWA、角色化手机导航、移动卡片/详情组件和弱网只读能力。按物流仓库、采购、管理分析的顺序交付；PWA 稳定后再规划 Capacitor APK 封装。

设计依据：`docs/superpowers/specs/2026-10-15-mobile-pwa-design.md`。

## 实施约束

- 本项目只允许修改呈现层和 PWA 外壳。操作流程、功能范围、管理权限、数据可见范围、字段可编辑性、校验规则、计算公式、状态流转、Supabase 数据行为、API 行为和审计记录均不得改变。
- 移动端不得新增、删除、跳过、合并或重新排序任何业务步骤；移动页面只能以不同布局调用现有业务能力。
- 每一阶段必须保持 `npm run build` 通过。
- 桌面端现有左侧导航、宽表、计算和权限行为不得退化。
- 移动组件必须复用现有数据写入函数和业务工具，不复制一套 Supabase 写入逻辑。
- 所有关键写入继续采用在线确认；第一版不实现离线写入队列。
- 管理员“我的采购任务”继续只展示分配给当前邮箱的任务。
- 每个阶段先在独立测试部署验证，再进入下一阶段。

## 不变性验收门槛

每个移动模块交付时，必须使用同一测试账号、同一初始数据和同一输入，分别在电脑端与手机端执行完整流程，并逐项比对：

- 可见记录和可访问模块一致。
- 可编辑与只读字段一致。
- 操作步骤、按钮含义和提交前置条件一致。
- 字段校验、错误提示类别和必填规则一致。
- 计算结果、状态变化和关联表更新一致。
- 删除、审批、提交和批量操作权限一致。
- Supabase 写入内容和审计记录一致。

任一项不一致即视为回归失败。该阶段不得合并、部署或继续扩大适配范围，必须先恢复与网页端一致。

## 阶段 0：建立移动回归基线

### 任务 0.1：记录桌面端基线

涉及文件：

- `README.md`
- `docs/superpowers/specs/2026-10-15-mobile-pwa-design.md`

操作：

1. 记录当前主要角色及可见导航。
2. 记录物流、采购、管理员的核心操作路径。
3. 确认测试环境使用的 Supabase 项目和测试账号不指向生产数据。
4. 建立移动测试设备清单：至少一台 Android Chrome、一台 iPhone Safari，以及桌面 Chrome。

验收：桌面端基线和测试账号可重复使用，后续每阶段能进行同样的回归检查。

### 任务 0.2：补充自动测试入口

涉及文件：

- `package.json`
- `package-lock.json`
- `vite.config.ts`
- 新建 `src/**/*.test.ts` 或 `src/**/*.test.tsx`

操作：

1. 引入 Vitest、jsdom 和 React Testing Library。
2. 添加 `test`、`test:watch` 和 `test:mobile` 脚本。
3. 保留现有 `scripts/test-*.mjs`，在统一的验证命令中继续运行关键脚本。
4. 先为角色导航映射、移动断点判断和本人采购任务过滤建立测试。

验证：

```powershell
npm test -- --run
npm run build
```

## 阶段 1：PWA 基础能力

### 任务 1.1：加入 PWA 构建配置

涉及文件：

- `package.json`
- `package-lock.json`
- `vite.config.ts`
- `index.html`
- 新建 `public/icons/*`
- 新建 `src/components/PwaUpdateNotice.tsx`

操作：

1. 引入 `vite-plugin-pwa`，配置应用名称、短名称、主题色、背景色、显示模式和图标。
2. 生成 192、512 和 maskable 图标，并补齐 iPhone 所需的 apple-touch-icon。
3. 缓存构建产物和应用外壳；不缓存 Supabase 认证响应和写入请求。
4. 使用可控更新策略：检测到新版本时显示刷新提示，不在用户填写表单时强制刷新。
5. 在 `index.html` 中补充 viewport、安全区域和移动主题元数据。

测试：

- manifest 字段和图标存在。
- 生产构建生成 service worker。
- 离线重新打开时能显示应用外壳。
- 登录、退出及密码重置不被旧缓存干扰。

验证：

```powershell
npm run build
npm run preview
```

### 任务 1.2：实现网络和数据新鲜度提示

涉及文件：

- 新建 `src/hooks/useOnlineStatus.ts`
- 新建 `src/components/NetworkStatusBanner.tsx`
- 新建 `src/utils/mobileCache.ts`
- `src/App.tsx`

操作：

1. 监听浏览器在线状态并在离线时显示固定提示。
2. 为允许缓存的只读数据记录最后成功加载时间。
3. 页面展示缓存数据时明确显示“离线数据”和更新时间。
4. 退出登录时按用户清理敏感缓存和表单草稿。
5. 写入函数保持现有在线调用，不加入自动回放队列。

测试：离线提示、恢复在线、缓存更新时间和退出清理。

## 阶段 2：移动设计系统与角色化导航

### 任务 2.1：消除全局桌面最小宽度

涉及文件：

- `src/styles.css`

操作：

1. 将 `body` 的 `min-width: 1080px` 限制到桌面断点内。
2. 新增移动设计变量：安全区域、底部导航高度、触控目标、页面间距和卡片圆角。
3. 在不修改各业务表格桌面宽度的前提下，确保应用外壳在 320px 宽度不产生全页横向滚动。
4. 为软键盘、固定底栏和 iPhone 安全区域预留空间。

测试：320、375、390、430、768、1080 和 1440px 视口快照与人工检查。

### 任务 2.2：抽离导航配置

涉及文件：

- 新建 `src/navigation.ts`
- 新建 `src/utils/mobileNavigation.ts`
- 新建 `src/components/MobileBottomNav.tsx`
- 新建 `src/components/MobileMoreMenu.tsx`
- `src/App.tsx`

操作：

1. 将当前 `PageKey`、`navItems` 和角色可见性判断抽成可测试配置。
2. 定义物流、采购、管理员/所有者和查看者的四入口移动导航。
3. 桌面端继续渲染当前侧边导航；移动端渲染底部导航。
4. “全部功能/更多”只展示该角色在网页端已有权限访问的模块。
5. 保持 `ACTIVE_PAGE_STORAGE_KEY` 行为，并处理角色切换后无权访问的旧页面键。

测试：

- 各角色移动入口符合设计。
- 管理员包含“我的采购任务”。
- 物流账号不获得管理页面入口。
- 深链接或本地存储不能绕过页面权限。

## 阶段 3：通用移动组件

### 任务 3.1：卡片列表和详情壳层

涉及文件：

- 新建 `src/components/mobile/MobileListPage.tsx`
- 新建 `src/components/mobile/MobileRecordCard.tsx`
- 新建 `src/components/mobile/MobileDetailSheet.tsx`
- 新建 `src/components/mobile/MobileFilterPanel.tsx`
- 新建 `src/hooks/useMobileViewport.ts`
- `src/styles.css`

操作：

1. 实现通用标题、计数、搜索、筛选、空状态和加载状态。
2. 卡片支持状态标签、关键指标、主操作和进入详情。
3. 详情使用整页或底部抽屉，但必须支持浏览器返回键和焦点恢复。
4. 表单控件触控高度不少于 44px，数值输入使用合适的移动键盘类型。
5. 桌面组件继续使用现有表格，不强制改写为卡片。

测试：键盘导航、触控尺寸、返回键、筛选状态和长列表滚动。

### 任务 3.2：统一在线写入状态

涉及文件：

- 新建 `src/hooks/useOnlineMutation.ts`
- 新建 `src/components/MutationStatus.tsx`
- `src/utils/errors.ts`

操作：

1. 封装处理中、成功、失败和重试状态，不改变底层业务函数签名。
2. 离线时禁止关键写入并保留表单草稿。
3. 对权限、校验、网络和服务端错误使用不同中文提示。
4. 批量操作显示成功数和失败数，失败项保持选中。

测试：重复点击、离线提交、超时、部分失败和重试。

## 阶段 4：物流仓库移动端

### 任务 4.1：物流工作台与待入仓卡片

涉及文件：

- `src/pages/HaichuanWorkflowPage.tsx`
- `src/pages/LogisticsLoadingPage.tsx`
- 新建 `src/pages/mobile/MobileLogisticsDashboard.tsx`
- 新建 `src/pages/mobile/MobileInboundList.tsx`
- 新建 `src/pages/mobile/MobileInboundDetail.tsx`
- `src/utils/haichuanStorage.ts`
- `src/styles.css`

操作：

1. 复用现有 `HaichuanData` 和待入仓数据源，计算今日待办、异常和最近操作。
2. 将待入仓行映射为卡片，详情显示计划数量、实际数量、差异和备注。
3. 数量不一致时要求填写差异说明；不覆盖计划数量。
4. 继续调用现有 `confirmHaichuanReceipt` 等写入函数。
5. 普通物流账号不显示管理员库存控制。

测试：正常收货、部分收货、数量差异、权限、失败重试和数据刷新。

### 任务 4.2：库存与装柜移动流程

涉及文件：

- `src/pages/HaichuanWorkflowPage.tsx`
- `src/pages/LogisticsLoadingPage.tsx`
- 新建 `src/pages/mobile/MobileWarehouseInventory.tsx`
- 新建 `src/pages/mobile/MobileLoadingBatches.tsx`
- 新建 `src/pages/mobile/MobileLoadingBatchDetail.tsx`
- `src/utils/logistics.ts`
- `src/utils/haichuanStorage.ts`

操作：

1. 库存卡片支持 SKU、批次和状态查询。
2. 装柜按批次展示总数、CBM、确认进度和异常。
3. 支持批量确认和单条数量修正。
4. 审批和库存调整继续按现有角色权限渲染。
5. 提交成功后刷新采购池、在途库存、物流批次和海川数据。

验证：

```powershell
node scripts/test-haichuan-warehouse-controls.mjs
node scripts/test-logistics-loading-types.mjs
npm test -- --run
npm run build
```

## 阶段 5：采购移动端

### 任务 5.1：我的采购任务卡片

涉及文件：

- `src/pages/MyPurchaseOrdersPage.tsx`
- 新建 `src/pages/mobile/MobileMyPurchaseOrders.tsx`
- 新建 `src/pages/mobile/MobilePurchaseOrderDetail.tsx`
- 新建 `src/utils/myPurchaseOrderVisibility.ts`
- `src/utils/purchaseRecords.ts`

操作：

1. 抽离“分配给当前邮箱”的过滤函数，并由桌面表格与移动列表共同使用。
2. 保持待采购、待补充、已提交等现有状态口径。
3. 卡片显示图片、SKU、厂家、建议数量、批次和状态。
4. 详情复用现有默认值、箱规、混装、数量、金额和 CBM 计算。
5. 管理员和所有者仍只看到分配给本人的任务，但保留网页端更完整的字段编辑能力。

测试：管理员、采购、查看者三类账号的可见记录和字段权限。

### 任务 5.2：草稿、校验和提交采购池

涉及文件：

- `src/pages/MyPurchaseOrdersPage.tsx`
- `src/pages/mobile/MobilePurchaseOrderDetail.tsx`
- `src/utils/purchasePoolFlows.ts`
- `src/utils/purchaseRecords.ts`
- `src/App.tsx`

操作：

1. 抽离并复用当前提交前的数量、金额和状态校验。
2. 草稿按用户和记录 ID 保存，成功提交或退出登录后清理。
3. 提交中锁定按钮，失败时保持草稿和当前页面。
4. 成功后刷新采购记录和采购池，并回到已提交分组。

验证：

```powershell
node scripts/test-purchase-record-calculations.mjs
node scripts/test-purchase-pool-flows.mjs
node scripts/test-purchase-order-imports.mjs
npm test -- --run
npm run build
```

## 阶段 6：管理分析移动端

### 任务 6.1：管理概览和待办

涉及文件：

- 新建 `src/pages/mobile/MobileManagementDashboard.tsx`
- 新建 `src/utils/managementSummary.ts`
- `src/pages/RepricingAlertsPage.tsx`
- `src/pages/ProfitAnalysisPage.tsx`
- `src/pages/MonthlyProfitPage.tsx`
- `src/App.tsx`

操作：

1. 从现有数据计算月度利润、在途 CBM、价格预警和待办数量。
2. 展示高优先级预警、异常 SKU 和待确认批次。
3. 提供简化趋势和 Top SKU；完整明细继续跳转现有模块。
4. 管理员底部“我的采购任务”复用阶段 5 的移动组件和网页端权限。

测试：摘要计算、角色可见性、空数据和部分数据源失败。

### 任务 6.2：其余管理模块移动入口

涉及文件：

- `src/pages/AdAnalysisPage.tsx`
- `src/pages/CommissionPage.tsx`
- `src/pages/PurchasePoolPage.tsx`
- `src/pages/PurchaseInventoryPage.tsx`
- `src/pages/SalesSuggestionPage.tsx`
- `src/pages/ContainerCalculatorPage.tsx`
- `src/components/SkuManager.tsx`
- `src/styles.css`

操作：

1. 为只读摘要和必要审批增加卡片视图。
2. 对暂未完整适配的复杂页面提供明确的“建议使用电脑端”提示，但不隐藏已有权限。
3. 逐页消除全页面横向滚动；确需宽表的区域使用局部滚动。
4. 检查文件选择、下载和导出在 Android/iPhone 上的基本行为。

## 阶段 7：完整验证与 PWA 发布

### 任务 7.1：自动化与桌面回归

执行：

```powershell
npm test -- --run
node scripts/test-stock-months.mjs
node scripts/test-selection-aware-export.mjs
node scripts/test-repricing-alerts.mjs
node scripts/test-purchase-record-calculations.mjs
node scripts/test-purchase-pool-flows.mjs
node scripts/test-purchase-order-imports.mjs
node scripts/test-profit-calculations.mjs
node scripts/test-logistics-loading-types.mjs
node scripts/test-haichuan-warehouse-controls.mjs
npm run build
```

桌面端人工回归：登录、导航、宽表、筛选、导入导出、采购提交、物流确认和管理员模块。

### 任务 7.2：真实设备验收

Android 和 iPhone 分别验证：

- 添加到主屏幕和独立窗口启动。
- 登录保持、退出和密码恢复。
- 四入口底部导航和浏览器返回键。
- 竖屏、横屏、键盘弹出和安全区域。
- 弱网查看、断网提示、恢复在线和失败重试。
- 物流收货与装柜、采购任务提交、管理员概览和本人采购任务。
- 新版本提示和刷新后的状态恢复。

验收通过后再部署到正式 PWA 地址。

## 阶段 8：APK 封装前置检查

本阶段只在 PWA 稳定后启动。

涉及文件：

- `package.json`
- `capacitor.config.ts`
- 新建 Android 工程目录

前置条件：

- PWA 在 Android Chrome 的核心流程已经稳定运行。
- 所有 Supabase 回调地址、深链接和认证恢复流程已验证。
- 文件选择、下载、网络状态和安全区域在 Android WebView 中有明确测试结果。

操作：引入 Capacitor、生成 Android 工程、配置应用标识和图标，验证登录及全部关键流程。APK 封装不得创建第二套业务实现。

## 提交策略

每个任务独立提交，建议顺序：

1. `test: add mobile regression harness`
2. `feat: add installable PWA shell`
3. `feat: add mobile navigation and shared cards`
4. `feat: add mobile logistics workflow`
5. `feat: add mobile purchase workflow`
6. `feat: add mobile management dashboard`
7. `test: complete mobile PWA regression coverage`

每次提交只包含对应任务文件，不混入工作区已有的无关修改或导出文件。
