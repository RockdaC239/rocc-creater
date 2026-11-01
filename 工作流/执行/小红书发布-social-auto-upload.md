# 小红书视频发布：当前执行方式

适用于用户已确认发布材料与本次发布权限的任务。2026-11-02 已真实提交一条私密测试笔记，官方笔记管理显示“仅自己可见、审核中”。不代表审核通过、定时发布或全自动统一 CLI 已验收。

## 固定运行环境

- 上游：social-auto-upload，固定 commit `3847fff01f5434a8a32829833163cd6723cabc59`。
- 已安装的持久目录：`/Users/rocc/.local/share/rocc-creater/publishing/social-auto-upload`。不要再引用旧 `/tmp/rocc-social-auto-upload-20261101`，不要每次重装。
- Python：该目录 `.venv/bin/python`（3.12），另安装标准 `playwright==1.58.0`；浏览器使用标准 Playwright + 本机 Chrome，禁止恢复 Patchright、stealth 注入或签名服务。
- 复用会话：`/Users/rocc/.local/share/rocc-creater/publishing/sessions/xiaohongshu_rocc.json`，权限 0600，不输出内容、不提交仓库。工具旧账号副本在持久目录 `cookies/xiaohongshu_rocc.json`。
- 仓库内可复现补丁：[小红书隔离适配](../../工具/发布适配/social-auto-upload-小红书测试.patch)，用 `git apply --unidiff-zero <补丁路径>` 应用于上面的固定上游版本；补丁本身不包含本轮交互补充的封面/权限/发布按钮新定位，仍需执行下述步骤。
- 本机补丁副本：`/Users/rocc/.local/share/rocc-creater/publishing/小红书测试适配.patch`。该补丁移除反检测及自动发布循环，使 `XiaoHongShuVideo.upload(playwright)` 返回停在提交前的 Page；不是原版 CLI 开箱支持私密。

## 输入与授权

每次明确视频、封面、账号、标题（当前实现最多 20 字符）、正文、话题、立即或定时时间、可见范围。两平台分别准备文案。用户明确确认本次材料和权限后才能点击发布；测试授权不能用于下一期正式内容。

本轮验证过立即发布和仅自己可见；公开、定时、话题候选关联需要按实际页面核验，不以已验证宣称。X 与小红书权限分开设置。抖音由用户自行发布。

## 执行步骤

1. 先看本项目发布记录。已经提交、审核中、发布成功或结果未知的同一任务都禁止盲目重发。只有确定尚未提交的失败可重试。
2. 使用已有会话；失效才登录。登录命令使用持久环境的 Python 运行仓库 `sau_cli.py xiaohongshu login --account rocc --headed`（工作目录为上面的持久目录）。用户扫码或安全验证后保存会话。不要每次扫码或额外开浏览器单独 check。
3. 复用 `uploader.xiaohongshu_uploader.main.XiaoHongShuVideo` 的视频上传与 `fill_meta`，传已确认的 `title/file_path/desc/tags/publish_date/account_file/thumbnail_path`。`account_file` 使用仓库外持久会话路径，`headless=False`，`debug=False`。通过有总时限的异步调用运行 `page = await app.upload(playwright)`，保持同一浏览器继续完成提交。
4. **封面必须按当前界面处理**：原版等“上传封面”会超时，原版失败后会悄悄用首帧，不能直接接受。当前界面点击 `div.upload-cover` 或 `div.cover-plugin-preview div.default.pointer` 打开编辑器；图片输入框为 `input[type=file][accept*="image"]`，上传指定封面后点准确文字“完成”。没有保存成功则停下来，不用默认封面代替。第一次或界面变化时观察当前 DOM，避免盲套旧定位。
5. 可见范围入口为 `.d-select-description`。限定该选择器再点击当前值“公开可见”，从菜单选择本次确认的权限（私密测试为“仅自己可见”）。页面还有多个同名预览文本，不能只用不限定范围的“公开可见”定位。一次读取选择器最终文本、标题输入框、正文、账号进行程序断言；正常路径不用逐项截图和反复读整个页面。
6. 发布按钮是 **`xhs-publish-btn` 自定义元素**，当前 `button:has-text("发布")` 和普通 `get_by_text("发布")` 都不能定位到内部按钮。读取它的 `submit-disabled` / `submit-loading` 确认可提交；需要视觉交互时只截当前页，按当次截图中的发布按钮原生点击。上次 1280×720 的 (700,675) 只是历史坐标，禁止下一次直接复用；不得把“暂存离开”误当发布。
7. 点击前先持久化“提交中”及视频/封面 SHA256、账号、文案、权限、授权来源。只点击一次，等待官方 `**/publish/success**` 路径；该页面会迅速回到上传入口，不能因回到入口就再次发布。
8. 点击“笔记管理”，找到本次标题和时间，记录官方条目显示的权限与审核状态。上传、提交、审核、实际发布分别记录；审核中不能标全流程已完成。结果未知时先查管理列表，禁止循环点击或重跑上传。
9. 通过 `await page.context.storage_state(path=...)` 更新仓库外会话，恢复文件 0600；完成后关闭本次启动的浏览器。出错保留诊断截图、错误与下一步；不打印会话数据。

## 已验证案例

- 视频：`内容项目/2026-10-29_口播试剪/发布/Heavy默认样式_响度验证_末10秒_HDR.mp4`。
- 封面：`内容项目/2026-10-30_封面模板校准/封面排布还原_v2_纯白.png`。
- 标题：仅自己可见｜口播发布测试。
- 平台时间：2026-11-02 00:12；官方条目标记“仅自己可见、审核中”。
- 状态记录：本期 `发布/小红书私密发布测试_2026-11-02.json`；截图：`发布/发布验证/小红书私密测试_2026-11-02.png`。

当前是复用上游上传实现、按此文档执行的 Agent 流程，尚未封装成一次调用的统一发布 CLI。后续优化只替换本环节，不改造剪辑、封面或 Notion 流程。
