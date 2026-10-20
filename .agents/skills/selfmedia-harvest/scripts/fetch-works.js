// selfmedia-harvest :: ego-browser profile enumerator
//
// Run (stdin heredoc style, matches ego-browser conventions):
//
//   PROFILE_URL='https://www.douyin.com/user/MS4w...' OUT=/tmp/works.json \
//     ego-browser nodejs < scripts/fetch-works.js
//
// Output JSON: { n, items: [ { i, href, text } ] }
//   href  -> the work URL (Douyin: /video/<id>)
//   text  -> card text, usually containing 播放量 + 标题 (used for cross-validation)
//
// Tip: get the profile URL from any single work:
//   yt-dlp --cookies-from-browser chrome -J '<share-url>' \
//     | python3 -c "import sys,json; print(json.load(sys.stdin)['channel_url'])"
//
// Cleanup (dedicated later heredoc):
//   ego-browser nodejs <<'EOF'
//   await completeTaskSpace(<taskId>, { keep: false })
//   EOF

const fs = await import('node:fs')   // ESM runtime: do NOT use require() with top-level await

const PROFILE_URL = process.env.PROFILE_URL || ''
const OUT = process.env.OUT || '/tmp/works.json'
const SPACE = process.env.SPACE || 'selfmedia-harvest'
const SCROLLS = parseInt(process.env.SCROLLS || '12', 10)

if (!PROFILE_URL) {
  throw new Error('PROFILE_URL is required. Example: PROFILE_URL=https://www.douyin.com/user/MS4w... ego-browser nodejs < scripts/fetch-works.js')
}

const task = await useOrCreateTaskSpace(SPACE)
cliLog('task space id: ' + task.id)

await openOrReuseTab(PROFILE_URL, { wait: true, timeout: 40 })
cliLog('pageInfo: ' + JSON.stringify(await pageInfo()))
cliLog('CHECK: page title should be the creator profile, NOT a captcha middle page')

const countJs = "(() => { const ul = [...document.querySelectorAll('ul')].find(u => u.getAttribute('data-e2e') === 'scroll-list'); return ul ? ul.querySelectorAll('li').length : -1 })()"

cliLog('items before scroll: ' + JSON.stringify(await js(countJs)))

for (let i = 0; i < SCROLLS; i++) {
  await scroll({ dy: 1400 })
  await wait(1.2)
}
await wait(1.5)
cliLog('items after scroll: ' + JSON.stringify(await js(countJs)))

const dataJs = "(() => { const ul = [...document.querySelectorAll('ul')].find(u => u.getAttribute('data-e2e') === 'scroll-list'); if (!ul) return { n: 0, items: [] }; const items = [...ul.querySelectorAll('li')].map((li, i) => { const a = li.querySelector('a'); return { i: i, href: a ? a.href : null, text: (li.innerText || '').slice(0, 200) } }); return { n: items.length, items: items } })()"

const data = await js(dataJs)
fs.writeFileSync(OUT, JSON.stringify(data, null, 2))

cliLog('wrote ' + OUT + '  items=' + data.n)
cliLog('NEXT: match titles + play counts against the target list, then run scripts/dl-audio.sh')
cliLog('NOTE: the list is lazy-loaded. If n is short, the first screen may still cover what you need - match first, scroll later.')
