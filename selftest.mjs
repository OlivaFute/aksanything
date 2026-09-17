/*
 * selftest.mjs — 划词提问组件自检
 *
 * 在已启动 ask-server 的前提下运行：
 *   node ask-server.mjs        # 另一个窗口先起服务
 *   node selftest.mjs
 * 截图输出到 .cache/shots/
 *
 * 环境变量：
 *   BASE=...      指定服务地址，默认 http://127.0.0.1:8899
 *   SKIP_AI=1     跳过真实 AI 调用（只验 UI，快）
 *   CHANNEL=msedge  用本机已装的 Edge，跳过 Chromium 下载
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 工具目录：截图、浏览器内核等运行数据都在这里（不污染工作区）
const ROOT = HERE
const BASE = process.env.BASE || 'http://127.0.0.1:8899'
const OUT = path.join(ROOT, '.cache', 'shots')
fs.mkdirSync(OUT, { recursive: true })

const LOCAL_BROWSERS = path.join(ROOT, '.cache', 'ms-playwright')
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS
}

const { chromium } = await import('playwright')

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   ' + extra : ''))
}

// CHANNEL=msedge 直接用本机已装的 Edge（Windows 自带），跳过 Chromium 下载。
// 仓库里不含 Chromium（.cache/ 已 gitignore，首次用桥接时按需下载 ~150MB），
// 只想跑一遍 UI 自检时用这个能省一次下载。
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}),
})
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

/** 在指定容器内选中含 needle 的文字并触发划词（用于卡片 / 抽屉内部）。带重试，避免渲染时序抖动。 */
async function selectIn(containerSel, needle, len, tries = 4) {
  let lastErr = ''
  for (let i = 0; i < tries; i++) {
    const ok = await page
      .evaluate(
        ([sel, needle, len]) => {
          const roots = Array.from(document.querySelectorAll(sel))
          if (!roots.length) return '容器不存在：' + sel
          let node = null
          for (const root of roots) {
            const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
            let n
            while ((n = walk.nextNode())) {
              if (n.nodeValue.includes(needle)) { node = n; break }
            }
            if (node) break
          }
          if (!node) return '容器内找不到「' + needle + '」'
          const start = node.nodeValue.indexOf(needle)
          const r = document.createRange()
          r.setStart(node, start)
          r.setEnd(node, start + len)
          const s = window.getSelection()
          s.removeAllRanges()
          s.addRange(r)
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          return true
        },
        [containerSel, needle, len]
      )
      .catch((e) => e.message)
    if (ok === true) {
      await page.waitForTimeout(260)
      return
    }
    lastErr = String(ok)
    await page.waitForTimeout(320)
  }
  throw new Error(lastErr || '划词失败')
}

/** 选中页面上含 needle 的段落里的一段文字，并触发划词 */
async function selectText(needle, offset, len) {
  await page.evaluate(
    ([needle, offset, len]) => {
      const p = Array.from(document.querySelectorAll('.wrap p, .wrap li, .wrap td')).find((el) =>
        (el.textContent || '').includes(needle)
      )
      if (!p) throw new Error('找不到包含「' + needle + '」的元素')
      let node = null
      const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null)
      let n
      while ((n = walk.nextNode())) {
        if (n.nodeValue.includes(needle)) { node = n; break }
      }
      if (!node) node = p.firstChild
      const start = Math.max(0, node.nodeValue.indexOf(needle) + offset)
      const r = document.createRange()
      r.setStart(node, start)
      r.setEnd(node, Math.min(node.nodeValue.length, start + len))
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    },
    [needle, offset, len]
  )
  await page.waitForTimeout(220)
}

try {
  // 从目录动态取第一门课 —— 课程会按分类移动，写死路径迟早失效
  const st = await (await fetch(BASE + '/api/state')).json()
  const url = BASE + decodeURIComponent(st.catalog[0].url)
  console.log('\n打开 ' + url + '\n')
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)

  /* ---------- 基础 ---------- */
  check('ask-ai.js 已加载', await page.evaluate(() => !!window.__askAI))
  check('样式已注入', (await page.locator('#askx-style').count()) === 1)
  check('抽屉已构建', (await page.locator('.askx-drawer').count()) === 1)
  check('初始没有卡片（按需创建）', (await page.locator('.askx-card').count()) === 0)

  const btnLabels = await page.locator('.askx-bubble button').allInnerTexts()
  check('气泡为四个动作', btnLabels.length === 4, btnLabels.join(' / '))
  check(
    '动作名称正确',
    btnLabels.join(',') === '解释这个词,解释这段,引用,新建问题',
    btnLabels.join(',')
  )

  /* ---------- 解释这个词 → 就地卡片 ---------- */
  await selectText('景深极浅', 0, 4)
  const bubbleOn = (await page.locator('.askx-bubble.on').count()) === 1
  check('划词后气泡浮出', bubbleOn)

  await page.locator('.askx-bubble button[data-a="define"]').click()
  await page.waitForTimeout(700)
  check('点「解释这个词」弹出卡片', (await page.locator('.askx-card').count()) === 1)
  const cardTitle = await page.locator('.askx-card-title').first().innerText()
  check('卡片标题是选中的词', cardTitle.trim() === '景深极浅', cardTitle)
  check('未打开右侧抽屉', (await page.locator('.askx-drawer.open').count()) === 0)
  check('卡片自带「深入解释」按钮', (await page.locator('.askx-card [data-c="deep"]').count()) >= 1)
  await page.screenshot({ path: path.join(OUT, '01-解释这个词-卡片.png') })

  /* ---------- 卡片可拖动 ---------- */
  const before = await page.locator('.askx-card').first().boundingBox()
  const head = await page.locator('.askx-card-head').first().boundingBox()
  await page.mouse.move(head.x + 60, head.y + 12)
  await page.mouse.down()
  await page.mouse.move(head.x + 60 - 180, head.y + 12 + 90, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(220)
  const after = await page.locator('.askx-card').first().boundingBox()
  const moved = Math.abs(after.x - before.x) > 60 && Math.abs(after.y - before.y) > 40
  check('卡片可拖动', moved, `Δx=${Math.round(after.x - before.x)} Δy=${Math.round(after.y - before.y)}`)
  await page.screenshot({ path: path.join(OUT, '02-卡片拖动后.png') })

  /* ---------- 卡片内再划词 → 形成树状层叠 ---------- */
  await page.evaluate(() => {
    const b = document.querySelectorAll('.askx-card-body')[0]
    if (b) b.textContent = '景深是光学系统能同时保持足够清晰度的物方轴向范围。'
  })
  await selectIn('.askx-card-body', '光学系统', 4)
  await page.locator('.askx-bubble button[data-a="define"]').click()
  await page.waitForTimeout(800)
  const cardCount = await page.locator('.askx-card').count()
  check('卡片内划词会新增卡片，父卡片保留', cardCount === 2, String(cardCount))
  check('新卡片标记为第 1 层', (await page.locator('.askx-card.lv1').count()) === 1)
  check('父卡片标题未变', (await page.locator('.askx-card-title').first().innerText()).trim() === '景深极浅')
  await page.screenshot({ path: path.join(OUT, '09-树状卡片.png') })

  await page.locator('.askx-card-x').first().click()
  await page.waitForTimeout(300)
  check('关闭父卡片会级联收起子卡片', (await page.locator('.askx-card').count()) === 0)

  /* ---------- 提问树（左下角入口） ---------- */
  check('左下角有提问树入口', (await page.locator('.askx-tree-btn').count()) === 1)
  const badge = (await page.locator('.askx-tree-badge').innerText()).trim()
  check('入口徽章显示节点数', Number(badge) === 2, badge)

  await page.locator('.askx-tree-btn').click()
  await page.waitForTimeout(380)
  check('点击后向上弹出面板', (await page.locator('.askx-tree.on').count()) === 1)
  const rows = await page.locator('.askx-tn').count()
  check('卡片收起后节点仍留在树里', rows === 2, String(rows))

  const treeText = await page.locator('.askx-tree-body').innerText()
  check('树里有父节点「景深极浅」', treeText.includes('景深极浅'), treeText.replace(/\n/g, ' / '))
  const indented = await page.evaluate(() => {
    const rs = [...document.querySelectorAll('.askx-tn')]
    if (rs.length < 2) return false
    return parseFloat(rs[1].style.paddingLeft) > parseFloat(rs[0].style.paddingLeft)
  })
  check('子节点有缩进（体现层级）', indented)
  await page.screenshot({ path: path.join(OUT, '12-提问树.png') })

  await page.locator('.askx-tn').first().click()
  await page.waitForTimeout(500)
  check('点树节点可重新打开卡片', (await page.locator('.askx-card').count()) >= 1)
  const restored = (await page.locator('.askx-card-title').first().innerText()).trim()
  check('恢复的是对应节点', restored === '景深极浅', restored)

  // 清理内存与本地存档，避免上一轮残留影响持久化测试
  await page.evaluate(() => {
    window.__askAI.closeAllCards()
    Object.keys(localStorage)
      .filter((k) => k.startsWith('askx:tree:'))
      .forEach((k) => localStorage.removeItem(k))
    window.__askAI.state.nodes.length = 0
    window.__askAI.showTree(false)
  })
  await page.waitForTimeout(250)

  /* ---------- 持久化：刷新后仍在 ---------- */
  // 造两个有父子关系的节点
  await selectText('景深极浅', 0, 4)
  await page.locator('.askx-bubble button[data-a="define"]').click()
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    const TXT = '景深是光学系统能同时保持足够清晰度的物方轴向范围。'
    const b = document.querySelector('.askx-card-body')
    if (b) b.textContent = TXT
    const t = document.querySelector('.askx-card-title')
    if (t) t.textContent = '景深'
    // 上面只改了 DOM，**必须同时写进 state**：持久化的 serializeNodes() 取的是
    // n.brief / n.deep，不看 DOM。SKIP_AI 模式下没有真实回答，不补这一句的话
    // 「恢复的节点内容仍在」会必然失败 —— 那是自检自己的漏洞，不是产品行为。
    const ns = window.__askAI.nodes()
    const n = ns[ns.length - 1]
    if (n) {
      n.term = '景深'
      n.brief = TXT
    }
  })
  await selectIn('.askx-card-body', '光学系统', 4)
  await page.locator('.askx-bubble button[data-a="define"]').click()
  await page.waitForTimeout(900)
  await page.evaluate(() => window.__askAI.closeAllCards())
  await page.waitForTimeout(700) // 等防抖写入

  const stored = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('askx:tree:'))
    if (!keys.length) return null
    const d = JSON.parse(localStorage.getItem(keys[0]))
    return { key: keys[0], ver: d.v, n: (d.nodes || []).length }
  })
  check('提问树已写入 localStorage', !!(stored && stored.n >= 2), JSON.stringify(stored))

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  const afterReload = await page.evaluate(() => window.__askAI.state.nodes.length)
  check('刷新后节点恢复', afterReload >= 2, String(afterReload))
  check('恢复的卡片是收起状态', (await page.locator('.askx-card').count()) === 0)

  await page.locator('.askx-tree-btn').click()
  await page.waitForTimeout(400)
  const reloadedRows = await page.locator('.askx-tn').count()
  check('刷新后树里仍有节点', reloadedRows >= 2, String(reloadedRows))
  const reloadedText = await page.locator('.askx-tree-body').innerText()
  check('恢复的是同一批节点', reloadedText.includes('景深'), reloadedText.replace(/\n/g, ' / '))
  await page.screenshot({ path: path.join(OUT, '13-刷新后恢复.png') })

  // 点开恢复的节点，内容应还在
  await page.locator('.askx-tn').first().click()
  await page.waitForTimeout(450)
  const restoredBody = (await page.locator('.askx-card-body').first().innerText()).trim()
  check('恢复的节点内容仍在', restoredBody.length > 5, restoredBody.slice(0, 40))

  // 清理本地存档，免得影响后续测试
  await page.evaluate(() => {
    window.__askAI.closeAllCards()
    Object.keys(localStorage)
      .filter((k) => k.startsWith('askx:tree:'))
      .forEach((k) => localStorage.removeItem(k))
    window.__askAI.state.nodes.length = 0
    window.__askAI.showTree(false)
  })
  await page.waitForTimeout(300)

  /* ---------- 边界：请求还没回来就收起卡片，不应抛错 ---------- */
  const pageErrs = []
  page.on('pageerror', (e) => pageErrs.push(e.message))
  await selectText('景深极浅', 0, 4)
  await page.locator('.askx-bubble button[data-a="define"]').click()
  await page.waitForTimeout(350)
  await page.evaluate(() => window.__askAI.closeAllCards()) // 中途收起（el 置 null）
  await page.waitForTimeout(2500)
  check('生成中收起卡片不抛错', pageErrs.length === 0, pageErrs.join(' | '))
  await page.evaluate(() => {
    window.__askAI.state.nodes.length = 0
    window.__askAI.showTree(false)
  })
  await page.waitForTimeout(200)

  /* ---------- 引用 ---------- */
  await selectText('景深极浅', 0, 4)
  await page.locator('.askx-bubble button[data-a="quote"]').click()
  await page.waitForTimeout(400)
  check('点「引用」打开抽屉', (await page.locator('.askx-drawer.open').count()) === 1)
  check('引用区出现 1 条', (await page.locator('.askx-quote-item').count()) === 1)

  await selectText('干涉条纹', 0, 4)
  await page.locator('.askx-bubble button[data-a="quote"]').click()
  await page.waitForTimeout(400)
  check('再引用一段 → 2 条', (await page.locator('.askx-quote-item').count()) === 2)

  const chipTxt = await page.locator('.askx-chip').allInnerTexts()
  check('上下文标签含引用计数', chipTxt.some((s) => s.includes('引用 2')), chipTxt.join(' / '))
  await page.screenshot({ path: path.join(OUT, '03-引用与抽屉.png') })

  /* ---------- 多任务 tab ---------- */
  const tabsBefore = await page.locator('.askx-tab').count()
  await selectText('轴向响应曲线', 0, 6)
  await page.locator('.askx-bubble button[data-a="new"]').click()
  await page.waitForTimeout(450)
  const tabsAfter = await page.locator('.askx-tab').count()
  check('「新建问题」多出一个 tab', tabsAfter === tabsBefore + 1, `${tabsBefore} → ${tabsAfter}`)
  const newQuotes = await page.locator('.askx-quote-item').count()
  check('新任务的引用独立于任务 1', newQuotes === 1, `任务1=2 / 任务2=${newQuotes}`)
  check('新任务 tab 高亮', (await page.locator('.askx-tab.on').innerText()).trim() === '2')

  const tabBox = await page.locator('.askx-tab').first().boundingBox()
  const tab2Box = await page.locator('.askx-tab').nth(1).boundingBox()
  check('tab 竖向排列', Math.abs(tabBox.x - tab2Box.x) < 6 && tab2Box.y > tabBox.y, `y: ${Math.round(tabBox.y)} → ${Math.round(tab2Box.y)}`)

  await page.locator('.askx-tab').first().click()
  await page.waitForTimeout(350)
  check('切回任务 1 → 引用恢复为 2 条', (await page.locator('.askx-quote-item').count()) === 2)
  await page.screenshot({ path: path.join(OUT, '04-多任务tab.png') })

  /* ---------- 卡片 / 抽屉内的文字也能划选 ---------- */
  await selectText('景深极浅', 0, 4)
  await page.locator('.askx-bubble button[data-a="define"]').click()
  await page.waitForTimeout(650)
  await page.evaluate(() => {
    const b = document.querySelector('.askx-card-body')
    if (b) b.textContent = '景深是光学系统能同时保持足够清晰度的物方轴向范围，超出它就迅速模糊。'
    const t = document.querySelector('.askx-card-title')
    if (t) t.textContent = '景深'
  })
  await page.waitForTimeout(220)

  const zBubble = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.askx-bubble')).zIndex))
  const zDrawer = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.askx-drawer')).zIndex))
  const zCard = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.askx-card')).zIndex))
  check('气泡层级高于抽屉与卡片', zBubble > zDrawer && zBubble > zCard, `bubble=${zBubble} drawer=${zDrawer} card=${zCard}`)

  await selectIn('.askx-card-body', '景深是光学系统', 7)
  check('卡片内划词浮出气泡', (await page.locator('.askx-bubble.on').count()) === 1)
  const cardSrc = await page.evaluate(() => window.__askAI.state.sourceFrom)
  check('卡片划词标记为 card 来源', cardSrc === 'card', cardSrc)
  await page.screenshot({ path: path.join(OUT, '07-在卡片里划词.png') })

  await page.locator('.askx-bubble button[data-a="quote"]').click()
  await page.waitForTimeout(420)
  const quoted = await page.locator('.askx-quote-item').count()
  check('卡片里的文字可被引用', quoted >= 1, String(quoted))

  await selectIn('.askx-quote-item span', '景深是光学系统', 7)
  const drawerSrc = await page.evaluate(() => window.__askAI.state.sourceFrom)
  check('抽屉内划词标记为 drawer 来源', drawerSrc === 'drawer', drawerSrc)

  const bubblePos = await page.evaluate(() => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return null
    return {
      bubbleTop: document.querySelector('.askx-bubble').getBoundingClientRect().top,
      selTop: sel.getRangeAt(0).getBoundingClientRect().top,
      bubbleOn: document.querySelector('.askx-bubble').classList.contains('on'),
    }
  })
  check(
    '抽屉内划词时气泡在选区上方',
    bubblePos && bubblePos.bubbleOn && bubblePos.bubbleTop < bubblePos.selTop,
    bubblePos ? `气泡 ${Math.round(bubblePos.bubbleTop)} / 选区 ${Math.round(bubblePos.selTop)}` : 'no bubble'
  )

  await page.locator('.askx-card-x').click()
  await page.waitForTimeout(200)

  /* ---------- 配置页 ---------- */
  await page.goto(BASE + '/config', { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  check('配置页可打开', (await page.locator('#provs').count()) === 1)
  const provCount = await page.locator('.prov').count()
  check('列出三条线路', provCount === 3, String(provCount))

  // API Key 字段只在 api 线路下出现，先切过去
  await page.locator('.prov').filter({ hasText: 'DeepSeek' }).first().click()
  await page.waitForTimeout(400)
  const onLabel = await page.locator('.prov.on').innerText()
  check('点击后选中态转移到该线路', onLabel.includes('DeepSeek'), onLabel.split('\n')[0])
  const hasKeyField = await page.evaluate(() =>
    !![...document.querySelectorAll('label.row .k')].find((e) => e.textContent.includes('API Key'))
  )
  check('API Key 输入框存在', hasKeyField)
  const keyType = await page.evaluate(() => {
    const l = [...document.querySelectorAll('label.row')].find((e) => e.textContent.includes('API Key'))
    return l ? l.querySelector('input').type : ''
  })
  check('Key 字段是 password 类型', keyType === 'password', keyType)
  await page.screenshot({ path: path.join(OUT, '05-配置页.png') })

  const cfgApi = await page.evaluate(async () => {
    const r = await fetch('/api/config', { headers: { 'x-ask-token': window.__TOKEN_PROBE || 'wrong' } })
    return r.status
  })
  check('配置接口拒绝无效 token', cfgApi === 401, 'HTTP ' + cfgApi)

  /* ---------- 本地 KaTeX 资源 ---------- */
  const kJS = await page.evaluate(() => fetch('/assets/katex/katex.min.js', { method: 'HEAD' }).then((r) => r.status))
  check('本地 KaTeX katex.min.js 可访问', kJS === 200, 'HTTP ' + kJS)
  const kCSS = await page.evaluate(() => fetch('/assets/katex/katex.min.css', { method: 'HEAD' }).then((r) => r.status))
  check('本地 KaTeX katex.min.css 可访问', kCSS === 200, 'HTTP ' + kCSS)
  const kFont = await page.evaluate(() =>
    fetch('/assets/katex/fonts/KaTeX_Main-Regular.woff2', { method: 'HEAD' }).then((r) => r.status)
  )
  check('本地 KaTeX 字体可访问', kFont === 200, 'HTTP ' + kFont)

  /* ---------- 真实解释链路（可选） ---------- */
  if (!process.env.SKIP_AI) {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)
    await selectText('景深极浅', 0, 4)
    await page.locator('.askx-bubble button[data-a="define"]').click()
    console.log('\n  …已请求「解释这个词」，等待卡片填充（最多 120 秒）')
    let txt = ''
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      await page.waitForTimeout(1500)
      txt = ((await page.locator('.askx-card-body').innerText().catch(() => '')) || '').trim()
      if (txt.length > 20) break
    }
    check('卡片收到定义内容', txt.length > 20, JSON.stringify(txt.slice(0, 90)))
    await page.screenshot({ path: path.join(OUT, '06-定义结果.png') })

    /* ---------- 深入解释（详细版，实测要 60~90 秒） ---------- */
    await page.locator('.askx-card [data-c="deep"]').first().click()
    console.log('  …已请求「深入解释」，等待详细版（最多 180 秒）')
    let deep = ''
    let btnText = ''
    const t1 = Date.now()
    while (Date.now() - t1 < 180000) {
      await page.waitForTimeout(1500)
      deep = ((await page.locator('.askx-card-body').first().innerText().catch(() => '')) || '').trim()
      btnText = ((await page.locator('.askx-card [data-c="deep"]').first().innerText().catch(() => '')) || '').trim()
      if (btnText === '返回简版') break
    }
    check('深入解释返回更长的内容', deep.length > txt.length, `${txt.length} 字 → ${deep.length} 字`)
    check('按钮切换为「返回简版」', btnText === '返回简版', btnText)
    const katexNodes = await page.evaluate(() => document.querySelectorAll('.askx-card-body .katex').length)
    check('详细版里的公式被 KaTeX 渲染', katexNodes > 0, katexNodes + ' 个 .katex 节点')
    await page.screenshot({ path: path.join(OUT, '10-深入解释.png') })
  } else {
    console.log('\n  （SKIP_AI=1，跳过真实 AI 调用）')
  }
} catch (e) {
  console.log('\n  异常：' + e.message)
  results.push({ name: '脚本执行', ok: false })
} finally {
  console.log('\n页面错误：' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'))
  const pass = results.filter((r) => r.ok).length
  console.log(`\n结果：${pass}/${results.length} 通过　截图目录：${OUT}\n`)
  await browser.close()
}
