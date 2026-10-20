# 踩坑清单

全部是实际跑通这个流程时踩到的坑，按遇到顺序排列。

## 1. 主页不要用 HTTP 直抓

curl / wget / requests 请求 www.douyin.com/user/... 会返回一个 6393 字节的「验证码中间页」。
iesdouyin.com 和 m.douyin.com 的分享页只返回混淆 JS，没有任何数据。
必须用 ego-browser 这种**会执行 JS、带完整浏览器指纹**的真浏览器。

## 2. yt-dlp 不支持抖音主页

抖音提取器的 _VALID_URL 只匹配 douyin.com/video/<数字>，传主页 URL 会直接报 Unsupported URL。
所以顺序永远是：**浏览器拿 ID → yt-dlp 逐个下载**。

## 3. Fresh cookies 报错

    ERROR: [Douyin] <id>: Fresh cookies (not necessarily logged in) are needed

这不是「要登录」，而是接口没拿到有效 cookie（源码判断的是 s_v_web_id 是否存在）。
加 --cookies-from-browser chrome 即可，无需登录。

先确认 Chrome cookie 能免密读取，避免弹钥匙串授权框卡住：

    security find-generic-password -s "Chrome Safe Storage" -w >/dev/null && echo "可读"

## 4. ego-browser heredoc 是 ESM

require() 和 top-level await 同时出现会报：

    ReferenceError: Cannot determine intended module format because both 'require' and top-level await are present

改用动态 import：

    const fs = await import('node:fs')

## 5. 别把 shell 的花括号变量写进模板字符串

如果通过代码拼 bash 命令，并且用模板字符串，shell 的花括号变量会被当成 JS 插值，
轻则变量变空，重则直接抛 ReferenceError（例如 DUR is not defined）。

对策二选一：
- 脚本里一律用 $VAR 形式，不用花括号形式；
- 或者先把脚本写进文件，再执行文件。

## 6. 关键词必须specific

用「同居」去匹配目标清单，结果命中了正文里提到「同居生活」的一篇**图文**，下载错了作品。
改成「同居是检验」才正确。

同理，短词（沟通、生活、自我、看脸、激素）都容易误命中长正文。宁可多打几个字。

## 7. 用播放量交叉验证

主页卡片文本里同时带**播放量**和标题。把它和用户手上的 Excel / 清单逐条对比，
数字接近才算匹配正确。这一步几乎零成本，却能挡住所有错配。

实例：抓到的 837 / 1197 / 4005 对应 Excel 的 835 / 1197 / 4005。

## 8. 懒加载列表，滚动不一定有用

抖音主页首屏就返回了 54 个 li；连续滚动多轮后仍是 54（虚拟列表，或不再触发加载）。
**先拿现有列表去匹配，别急着滚到底。** 往往首屏已经覆盖了所需作品。

## 9. 平台转码会抹掉拍摄时间

抖音下载下来的 mp4 只有 encoder=Lavf58.76.100，没有 creation_time，也没有机型和 GPS。
所以无法从下载文件反推拍摄时间，只能用平台的**发布时间**命名。
相机原始文件（如 iPhone 的 MOV）则保留 creation_time，可以用**拍摄时间**。

两者语义不同，交付时要讲清楚；但发布时间一定晚于拍摄时间，时间线排序不会错乱。

## 10. 文件名清洗

macOS 上 ASCII 冒号会在 Finder 里显示成斜杠，必须去掉：

    \ / : * ? " < > |

以及空白和首尾标点。中文标点没问题。同时保留短 ID（原始 UUID 前 8 位 / video id 前 8 位）便于回溯。

## 11. 限流与重试

批量下载之间 sleep 1~2 秒（脚本内置 SLEEP 环境变量）。
单条失败多是临时风控，**重跑即可**——脚本是幂等的，已完成的音频会自动跳过。

## 12. -f "bv*+ba/b" 需要 ffmpeg 合并

音视频分离的格式靠 ffmpeg 合并，没装会失败。
抖音常返回 HEVC(bytevc1)，ffmpeg 能正常解码，不用额外处理。

## 13. 只要 ASR 就别下原画

16 kHz 单声道对 ASR 完全够用。为了「原画」去折腾录屏、虚拟声卡、中转站是浪费。
反过来，只有当平台确实拿不到、且用户能录屏时，才退回录屏方案。

## 14. 交付限制

present 一次最多 8 个文件，超过会被拒绝，多文件要分批调用。

## 15. 浏览器任务空间要收尾

枚举完成后用**独立 heredoc** 调 completeTaskSpace(taskId, { keep: false })，别留着占标签页。
若中途用户接管了浏览器控制权，**不要抢回来**，先问用户。
