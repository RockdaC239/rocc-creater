---
name: selfmedia-harvest
description: Harvest a creator's own self-media works end-to-end when the platform download button is disabled. Enumerate an account's works with a real browser (ego-browser), download each item with yt-dlp using the user's own browser cookies, then extract ASR-ready 16 kHz mono WAV with ffmpeg under a stable date-based naming scheme. Covers 抖音 Douyin, TikTok, B站 Bilibili, 小红书 XiaoHongShu, 微博 Weibo, YouTube and other yt-dlp supported sites. Use when the user asks to 下载/拉取/抓取/爬取/备份 自己在抖音等平台的作品、主页作品、无下载按钮的视频、批量导出已发布作品、把视频转成音频做 ASR 或语音转文字, or mentions 抖音无法下载, 主页抓不到, yt-dlp, self-media backup, extract audio for ASR, 把原视频的音频提取出来.
metadata:
  version: "1.0.0"
  date: "2026-09-16"
  platforms: "douyin, tiktok, bilibili, xiaohongshu, weibo, youtube"
---

# Self-media Work Harvest

把「平台不给下载按钮」的已发布作品，变成可归档的视频 + ASR 就绪的音频。

## 核心认知（先读这三条，能省一小时）

1. **「无法下载」是产品开关，不是加密。** 播放时完整的 mp4 已经发到用户设备上了，只是没给下载按钮。抖音等平台**没有 DRM**，不需要解密。
2. **链接分三层，每层用不同工具**：
    - 账号主页的作品列表 → **真浏览器**（ego-browser）。HTTP 直抓会被风控挡在「验证码中间页」。
    - 单个作品 ID → 从主页 DOM 里取。
    - 视频直链 → **yt-dlp + 用户浏览器 cookie**。抖音的 aweme/detail 接口要求 fresh cookies，但**不要求登录**。
3. **要 ASR 就只要音频。** 二次获取的画质损失完全不影响识别准确率，不要为了「原画」卡住流程。

## 环境自检

    which ffmpeg ffprobe || brew install ffmpeg
    yt-dlp --version        || pip3 install -U yt-dlp
    yt-dlp --list-extractors | grep -iE 'douyin|bilibili|xiaohongshu|tiktok'
    security find-generic-password -s "Chrome Safe Storage" -w >/dev/null && echo "chrome cookies: 可免密读取"

ego-browser 的安装与用法见 ego-browser skill。本流程所有浏览器操作都用它的 heredoc。

## 流程

### 0. 先确认目标范围，别一上来就下全部

如果只是做 ASR，先拿到平台作品清单（标题 / 播放量 / 发布时间），和用户的目标清单对齐，**只下需要的**。一个创作者可能有 87 条作品，而目标只有 12 条。

### 1. 拿到作品 ID

**路径 A — 用户直接给了分享链接**（最省事）：跳到第 3 步。
抖音分享文本形如：

    3.53 L@j.pq 02/07 Kws:/ :5pm "标题..." #tag  https://v.douyin.com/FP7QWf4_Ycc/ 复制此链接，打开Dou音搜索

用正则抠出 v.douyin.com 短链即可。

**路径 B — 只有主页链接**：用 ego-browser 枚举，跑 scripts/fetch-works.js。

需要先知道主页 URL。如果手上只有一条作品链接，可以反查：

    yt-dlp --cookies-from-browser chrome -J '<share-url>' | python3 -c "import sys,json; print(json.load(sys.stdin)['channel_url'])"

枚举命令（细节见 scripts/fetch-works.js）：

    PROFILE_URL='https://www.douyin.com/user/MS4w...' OUT=/tmp/works.json \
      ego-browser nodejs < scripts/fetch-works.js

作品卡片结构（抖音网页版）：ul[data-e2e="scroll-list"] > li > a[href="/video/<ID>"]，
而 li.innerText 里同时有**播放量**和**标题**——这两个字段是后面验证的关键。

### 2. 匹配 + 交叉验证（最容易出错的一步）

用**标题关键词**把主页条目和目标清单对上，再用**播放量**做交叉验证：两边数字接近才说明没抓错。

关键要求：关键词必须足够specific。踩过的坑——用「同居」去匹配，命中了正文里提到「同居生活」的一篇**图文**，下载错了作品；改用「同居是检验」才对。同理，短词（沟通、生活、自我）很容易误命中。

验证通过后再进入下载。

### 3. 用 yt-dlp 下载

抖音必须带 cookie，否则会报：

    ERROR: [Douyin] <id>: Fresh cookies (not necessarily logged in) are needed

单条命令：

    yt-dlp --cookies-from-browser chrome --socket-timeout 30 \
      -f "bv*+ba/b" --merge-output-format mp4 \
      -o "videos/RAW_<ID>.%(ext)s" \
      "https://www.douyin.com/video/<ID>"

先干跑验证再下载（省钱省时间）：

    yt-dlp --cookies-from-browser chrome --simulate \
      --print "TITLE=%(title)s" --print "DUR=%(duration)s" \
      --print "EXT=%(ext)s" --print "RES=%(resolution)s" '<url>'

### 4. 批量下载 + 提取 ASR 音频

用 scripts/dl-audio.sh，manifest 是 TAB 分隔的「目标 URL」+「输出文件名（不含扩展名）」：

    printf '%s\t%s\n' 'https://www.douyin.com/video/<ID>' '2026-07-04_1956_同居是检验_76586403' > /tmp/m.tsv
    scripts/dl-audio.sh /tmp/m.tsv videos audio

脚本会：下载 → 转 16 kHz 单声道 PCM WAV → 重命名 → 打印时长和 mean 音量。已存在的音频自动跳过，可安全重跑。

单独提音频的核心命令：

    ffmpeg -hide_banner -loglevel error -y -i in.mp4 \
      -vn -map a:0 -ac 1 -ar 16000 -c:a pcm_s16le out.wav

16 kHz / 单声道 / pcm_s16le 是 Whisper、FunASR、Vosk、Paraformer 的标准输入。
静音自检：ffmpeg -i out.wav -af volumedetect -f null - ，看 mean_volume 应落在 -15 到 -30 dB。

### 5. 命名规范

    YYYY-MM-DD_HHMM_标题片段12字_短ID.ext

- 日期在最前，目录里天然按时间排序。
- 短 ID 保留可回溯性（原视频用 UUID 前 8 位，平台作品用 video id 前 8 位）。
- **有内嵌拍摄时间**（相机原始文件）→ 用拍摄时间；**平台转码后没有拍摄时间** → 用发布时间，并在交付时明确说明两者语义不同（发布时间一定晚于拍摄时间，排序不会错乱）。
- 标题清洗：先去掉空白，再去掉非法字符 \ / : * ? " < > | ，截断后去掉尾部标点。

### 6. 交付

- 用 present 交付音频文件。一次最多 8 个，多文件分多次调用。
- 附一份索引 CSV（序号 / 日期 / 时间 / 来源 / 时长 / 文件名）。
- 明确区分「原视频提取」与「平台抓取」两个来源。

## 收尾（必须）

浏览器任务空间用完要关，单独一个 heredoc，确认全部产出落盘后再调：

    ego-browser nodejs <<'EOF'
    await completeTaskSpace(<taskId>, { keep: false })
    cliLog('closed')
    EOF

默认 keep 为 false。只有用户明确要求保留页面、或任务需要用户在页面上手动操作时才用 keep: true。

## 平台差异速查

| 平台 | 主页枚举方式 | 备注 |
| --- | --- | --- |
| 抖音 Douyin | **必须 ego-browser** | yt-dlp 只支持 /video/<数字>；接口要 fresh cookies 但不要求登录；主页 HTTP 直接返回验证码中间页 |
| TikTok | yt-dlp 原生 @user | 部分 extractor 标注 BROKEN，看 --list-extractors 输出 |
| B站 Bilibili | **yt-dlp 原生** | 有 BilibiliSpaceVideo / SpaceAudio / Series / Collection，主页可直接拉，无需浏览器 |
| 小红书 XiaoHongShu | 建议 ego-browser | 有 extractor 但风控较严 |
| 微博 Weibo | 视目标而定 | 有 extractor |
| YouTube | yt-dlp 原生 | 频道 / 播放列表直接支持 |

结论：**B站和 YouTube 优先用 yt-dlp 原生主页能力；抖音和大部分国内平台需要真浏览器取 ID。**

## 常见坑

见 references/gotchas.md（ESM、模板字符串插值、关键词误匹配、虚拟列表、cookie 读取、文件名清洗等，全是实际踩过的）。

## 可复用脚本

- scripts/fetch-works.js — ego-browser 枚举账号主页作品 → JSON
- scripts/dl-audio.sh — manifest 批量下载 + 提音频 + 命名 + 音量自检
