#!/usr/bin/env node
/*
 * ask-server.mjs — 教学工作区「划词提问」本地服务
 *
 * 做三件事：
 *   1. 托管整个教学工作区（默认 http://127.0.0.1:8899），让 lesson 的相对路径引用原样可用
 *   2. 返回 HTML 时动态注入划词提问组件 —— lesson 文件本身零改动，将来新生成的课也自动生效
 *   3. 提供 /api/ask 流式接口，把「MISSION + 课程目录 + 整课全文 + 选区上下文」拼成提示词
 *
 * 零 npm 依赖（Node 18+ 原生 http/fs/fetch）。
 * browser provider 需要可选依赖 playwright，仅在 provider=browser 时动态加载。
 *
 * 用法：
 *   node tools/ask-server.mjs                    # 用配置里的 provider
 *   node tools/ask-server.mjs --provider browser # 临时切换 provider
 *   node tools/ask-server.mjs --port 9000
 *   node tools/ask-server.mjs --no-open          # 不自动开浏览器
 *   node tools/ask-server.mjs --list             # 列出可用 provider 与工作区概况
 *   node tools/ask-server.mjs --inject           # 把 script 标签静态写进所有 lesson（file:// 场景用）
 *   node tools/ask-server.mjs --login            # 只打开桥接浏览器，供扫码登录
 */

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPdfReader } from './pdf-reader.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 工具本体目录：代码、组件（ask-ai.js / katex）、运行缓存、浏览器内核都在这里。
// 它与「工作区」（课程内容所在目录）是解耦的，由 --workspace 或配置指定。
const TOOL_DIR = HERE
const CONFIG_PATH = path.join(HERE, 'ask.config.json')
// 本机覆盖层。主配置 ask.config.json 是给公开仓库用的「中性模板」，
// 不该出现任何本机路径；工作区指向属于本机信息，一律落在这个文件里。
// 该文件已在 .gitignore 中（见「密钥」一节），不会进版本库。
const LOCAL_PATH = path.join(HERE, 'ask.config.local.json')

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}

/**
 * 主配置文件的**原始**内容。持久化时以它为准，而不是运行期的 cfg ——
 * 否则会把 --workspace / 本地覆盖层解析出来的**本机绝对路径**写回 ask.config.json，
 * 那正好就是「公开仓库里出现作者本机路径」的成因。
 */
let FILE_CFG = {}

/** 读本地覆盖层；不存在或坏了都当空对象，不阻塞启动。 */
function readLocal() {
  try {
    const o = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8').replace(/^\uFEFF/, ''))
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

/** 只改 workspace 一个字段，其余原样保留（本地文件可能被手工加过别的键）。 */
function writeLocalWorkspace(ws) {
  const cur = readLocal()
  cur._readme =
    '本机覆盖层，优先级高于 ask.config.json（--workspace 命令行参数仍最高）。' +
    '已在 .gitignore 中，不会进版本库 —— 本机路径就该放这里。'
  cur.workspace = ws
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(cur, null, 2) + '\n', 'utf8')
}

/**
 * 合成运行期配置。优先级：命令行 > 本地覆盖层 > 主配置 > 上级目录兜底（兼容旧布局）。
 * `_workspaceSource` 只用于界面提示「这个值是哪来的」，不写回文件。
 */
function buildRuntime(fileCfg) {
  const out = JSON.parse(JSON.stringify(fileCfg))
  const localWs = String(readLocal().workspace || '').trim()
  const cliWs = opt('workspace')
  out.port = Number(opt('port') || out.port || 8899)
  out.provider = opt('provider') || out.provider || 'api'
  out._workspaceSource = cliWs ? 'cli' : localWs ? 'local' : out.workspace ? 'config' : 'fallback'
  out.workspace = path.resolve(cliWs || localWs || out.workspace || path.resolve(HERE, '..'))
  return out
}

/** 就地替换运行期配置对象（cfg 被很多闭包按引用持有，不能整个换掉） */
function replaceCfg(next) {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, next)
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[ask] 找不到配置文件：${CONFIG_PATH}`)
    process.exit(1)
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error(`\n[ask] tools/ask.config.json 不是合法 JSON：${e.message}`)
    console.error('      常见原因：用了 JS 的数组语法 [...]、.join() 或 // 注释。')
    console.error('      这是纯 JSON 文件：长文本要写成一行字符串，换行用 \\n 转义。\n')
    process.exit(1)
  }
  FILE_CFG = JSON.parse(JSON.stringify(parsed))
  return buildRuntime(FILE_CFG)
}

const cfg = loadConfig()
// 工作区根：lessons / MISSION.md / reference / assets 都在这里。
// 用 let —— 它可以在运行期被 /api/workspace 热切换（读了 ROOT 的地方会自然拿到新值）。
let ROOT = cfg.workspace
const TOKEN = crypto.randomBytes(16).toString('hex')

// PDF 阅读模块：与 HTML lesson 链路完全分离，由 ask.config.json 的 pdf.enabled 控制。
// 关掉它时 /pdf 返回 404、目录里不出现文献、首页也没有入口 —— 等于回到纯 HTML 状态。
const pdfReader = createPdfReader({
  getRoot: () => ROOT,
  TOOL_DIR,
  getConfig: () => cfg,
  getToken: () => TOKEN,
})

// 浏览器内核装在工具目录的 .cache/ms-playwright 时自动优先使用，
// 免得 Playwright 跑去 C 盘默认路径找不到可执行文件。
const LOCAL_BROWSERS = path.join(TOOL_DIR, '.cache', 'ms-playwright')
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(LOCAL_BROWSERS)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS
}

/* ------------------------------------------------------------------ */
/* HTML -> 纯文本                                                       */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&hellip;': '…', '&times;': '×', '&deg;': '°', '&mu;': 'μ',
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
}

/** 把 lesson 的 HTML 转成结构可读的纯文本，保留标题/表格/公式的可辨识形态。 */
function htmlToText(html) {
  let s = html
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '')
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '')
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '［此处有一张图示］')
  s = s.replace(/<h1[^>]*>/gi, '\n# ')
  s = s.replace(/<h2[^>]*>/gi, '\n## ')
  s = s.replace(/<h3[^>]*>/gi, '\n### ')
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  s = s.replace(/<tr[^>]*>/gi, '\n| ')
  s = s.replace(/<\/t[dh]>/gi, ' | ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|h1|h2|h3|li|tr|table|blockquote|pre|ul|ol)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

const stripTags = (s) => (s ? decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() : '')

/* ------------------------------------------------------------------ */
/* 工作区上下文                                                          */
/* ------------------------------------------------------------------ */

let catalogCache = { at: 0, data: null }

/** 分类展示名：配置里映射过就用映射，否则回退到目录名。 */
function categoryLabel(id) {
  const cats = cfg.categories || {}
  const labels = cats.labels || {}
  if (id) return labels[id] || id
  return cats.defaultLabel || '未分类'
}

/**
 * 扫描 lessons/ 建立课程目录。
 *
 * 分类约定（加新项目只需新建一个子目录，不用改代码）：
 *   lessons/0001-x.html            → 归入默认分类
 *   lessons/<分类目录>/0001-x.html → 归入以该目录名为 id 的分类
 */
async function getCatalog() {
  if (catalogCache.data && Date.now() - catalogCache.at < 2000) return catalogCache.data
  const root = path.join(ROOT, 'lessons')
  const out = []

  async function take(abs, rel, category) {
    const html = await fsp.readFile(abs, 'utf8').catch(() => '')
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
    const kicker = /<p class="kicker"[^>]*>([\s\S]*?)<\/p>/i.exec(html)
    const base = path.basename(rel)
    out.push({
      rel, // 相对 lessons/ 的路径，同时是前后端约定的课程 id
      url: '/lessons/' + rel.split('/').map(encodeURIComponent).join('/'),
      category,
      categoryLabel: categoryLabel(category),
      num: (base.match(/^(\d+)/) || [, ''])[1],
      title: stripTags(title?.[1]) || stripTags(h1?.[1]) || base,
      heading: stripTags(h1?.[1]),
      kicker: stripTags(kicker?.[1]),
    })
  }

  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    entries = []
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.html')) {
      await take(path.join(root, e.name), e.name, '')
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      const subDir = path.join(root, e.name)
      let files = []
      try {
        files = (await fsp.readdir(subDir)).filter((f) => f.endsWith('.html')).sort()
      } catch {
        files = []
      }
      for (const f of files) await take(path.join(subDir, f), e.name + '/' + f, e.name)
    }
  }

  // PDF 文献：与 lesson 项同构，靠 kind 区分。首页会把它们单独分成一组，
  // 上下文组装时按 kind 过滤 —— 两条链互不污染。
  out.push(...(await pdfReader.scanPdfs()))

  out.sort((a, b) => {
    // 文献分组固定排最后，不与课程混排
    const ap = a.kind === 'pdf' ? 1 : 0
    const bp = b.kind === 'pdf' ? 1 : 0
    if (ap !== bp) return ap - bp
    if (a.category !== b.category) {
      if (!a.category) return -1
      if (!b.category) return 1
      return a.category.localeCompare(b.category)
    }
    return a.rel.localeCompare(b.rel)
  })

  catalogCache = { at: Date.now(), data: out }
  return out
}

/** 分类目录下的 MISSION.md 优先，回退到工作区根目录。 */
function readMission(category) {
  const candidates = []
  if (category) candidates.push(path.join(ROOT, 'lessons', category, 'MISSION.md'))
  candidates.push(path.join(ROOT, 'MISSION.md'))

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    const md = fs.readFileSync(p, 'utf8')
    // 只取「为什么学 / 最终目标 / 成功标准 / 约束」几节，避免把整份 MISSION 塞进 prompt
    const keep = []
    let capturing = false
    for (const line of md.split(/\r?\n/)) {
      if (/^##\s/.test(line)) capturing = /为什么学|最终目标|成功标准|约束/.test(line)
      if (capturing) keep.push(line)
    }
    return {
      text: (keep.join('\n').trim() || md.trim()).slice(0, 2500),
      from: path.relative(ROOT, p).replace(/\\/g, '/'),
    }
  }
  return { text: '', from: '' }
}

function extractSections(html) {
  const out = []
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
  let m
  while ((m = re.exec(html))) out.push({ index: m.index, title: stripTags(m[1]) })
  return out
}

/** section 模式：只截取当前 h2 到下一个 h2 之间的内容。 */
function sectionSlice(html, sectionTitle) {
  if (!sectionTitle) return null
  const secs = extractSections(html)
  const i = secs.findIndex((s) => s.title === sectionTitle || s.title.includes(sectionTitle) || sectionTitle.includes(s.title))
  if (i < 0) return null
  const from = secs[i].index
  const to = i + 1 < secs.length ? secs[i + 1].index : html.length
  return html.slice(from, to)
}

/** 读取一课。传入相对 lessons/ 的路径，最多允许一层分类目录。 */
async function getLessonContext(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = rel.split('/')
  if (
    parts.length > 2 ||
    parts.some((p) => !p || p === '.' || p === '..' || !/^[\w\u4e00-\u9fa5 .-]+$/.test(p)) ||
    !rel.toLowerCase().endsWith('.html')
  ) {
    throw new Error('lesson 路径不合法：' + rel)
  }

  const lessonsRoot = path.resolve(path.join(ROOT, 'lessons'))
  const abs = path.resolve(path.join(lessonsRoot, rel))
  if (!abs.startsWith(lessonsRoot)) throw new Error('lesson 路径越界')
  if (!fs.existsSync(abs)) throw new Error(`找不到 lesson：${rel}`)

  const html = await fsp.readFile(abs, 'utf8')
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  return {
    rel,
    category: parts.length > 1 ? parts[0] : '',
    title: stripTags(title?.[1]) || rel,
    heading: stripTags(h1?.[1]),
    sections: extractSections(html).map((s) => s.title),
    html,
    text: htmlToText(html),
  }
}

/* ------------------------------------------------------------------ */
/* 提示词组装                                                           */
/* ------------------------------------------------------------------ */

async function buildMessages(body) {
  const cctx = cfg.context || {}
  const prompts = cfg.prompts || {}
  const mode = ['define', 'defineDeep', 'explain', 'qa'].indexOf(body.mode) >= 0 ? body.mode : 'qa'
  // PDF 与 HTML 各走自己的上下文读取器，两者返回的是同构对象
  const lesson =
    body.docKind === 'pdf'
      ? await pdfReader.getPdfContext(body.lesson)
      : await getLessonContext(body.lesson)
  // 只列同类型文档：HTML 课只列课、PDF 文献只列文献。
  // 不过滤的话 PDF 会混进 lesson 的「课程目录」，污染现有 HTML 阅读的上下文。
  const catalog = (await getCatalog()).filter((c) => (c.kind === 'pdf') === (lesson.kind === 'pdf'))
  // 分类目录下若有自己的 MISSION.md，优先用它
  const missionInfo = cctx.includeMission ? readMission(lesson.category) : { text: '', from: '' }

  const parts = []

  if (missionInfo.text) {
    parts.push(`【学习者的目标（来自 ${missionInfo.from}）】`, missionInfo.text, '')
  }

  if (cctx.includeCatalog && catalog.length) {
    // 只详列当前分类的课；其它分类仅点名 —— 课程变多后全列会吃掉整个上下文
    const same = catalog.filter((c) => c.category === lesson.category)
    const otherCats = [...new Set(catalog.filter((c) => c.category !== lesson.category).map((c) => c.categoryLabel))]
    parts.push('【课程目录】')
    if (same.length) {
      parts.push(
        lesson.category ? `本分类「${categoryLabel(lesson.category)}」共 ${same.length} 课：` : `未分类课程共 ${same.length} 课：`
      )
      parts.push(same.map((c) => `- ${c.rel}　${c.heading || c.title}`).join('\n'))
    }
    if (otherCats.length) {
      parts.push('', `另有其它分类：${otherCats.join('、')}`)
    }
    parts.push('')
  }

  const isPdf = lesson.kind === 'pdf'
  parts.push(
    isPdf
      ? `【他正在读的文献：${lesson.heading || lesson.title}（${lesson.rel}）】`
      : `【他正在读的课：${lesson.heading || lesson.title}（lessons/${lesson.rel}）】`
  )
  if (lesson.category) parts.push(`所属分类：${categoryLabel(lesson.category)}`)
  if (lesson.sections.length) parts.push(`${isPdf ? '文献章节' : '本课章节'}：${lesson.sections.join(' / ')}`)
  parts.push('')

  // L4 正文。HTML 由 lessonMode 决定粒度；PDF 由 pdf.contextMode 决定（full / page / paragraph）。
  let lessonBody = lesson.text
  let bodyLabel = '【本课全文】'

  if (isPdf) {
    // PDF：长文献用 full 会被 maxLessonChars 截断成"前缀"，读到后半段时上下文完全错位，
    // 所以默认按当前页给。页码由前端适配器通过 body.page 带来。
    const pdfMode = (cfg.pdf && cfg.pdf.contextMode) || 'page'
    const pageNo = Number(body.page) || 0
    if (!lesson.hasText) {
      lessonBody = '（这份文献没有可用的文本抽取结果，只能依据他划出的原文作答）'
      bodyLabel = '【未获得文献全文】'
    } else if (pdfMode === 'page' && pageNo > 0) {
      const sliced = pdfReader.slicePages(lesson.text, pageNo, 0)
      if (sliced) {
        lessonBody = sliced
        bodyLabel = `【他正在读的那一页（第 ${pageNo} 页）】`
      } else {
        bodyLabel = '【文献全文】'
      }
    } else if (pdfMode === 'paragraph' && String(body.paragraph || '').trim()) {
      lessonBody = String(body.paragraph).trim()
      bodyLabel = '【选区所在段落】'
    } else {
      bodyLabel = '【文献全文】'
    }
  } else {
    // 「解释这个词」是轻量查询，默认只带当前章节 —— 省 token，网页版桥接也快得多
    const useMode = mode === 'define' ? cctx.defineLessonMode || 'section' : cctx.lessonMode || 'full'
    if (useMode === 'section') {
      const sliced = sectionSlice(lesson.html, body.section)
      if (sliced) {
        lessonBody = htmlToText(sliced)
        bodyLabel = '【所在章节全文】'
      }
    }
  }

  const maxChars = Number(cctx.maxLessonChars || 60000)
  if (lessonBody.length > maxChars) lessonBody = lessonBody.slice(0, maxChars) + '\n…（已截断）'

  parts.push(bodyLabel)
  parts.push(lessonBody)
  parts.push('')
  // 引用可以有多段（用户可能连着引用好几处）
  const quotes = (Array.isArray(body.quotes) && body.quotes.length ? body.quotes : [String(body.selection || '')])
    .map((s) => String(s).replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  if (quotes.length) {
    // 引用可能来自课程正文，也可能来自 AI 自己之前的回答（卡片/抽屉里的文字都能划选）。
    // 标清出处，否则模型会在课程正文里找不到这段话而困惑。
    const srcNote =
      body.sourceFrom === 'card'
        ? '（来自你之前给出的定义卡片，不是课程原文）'
        : body.sourceFrom === 'drawer'
          ? '（来自你之前的回答，不是课程原文）'
          : ''
    parts.push(
      quotes.length > 1
        ? `【他引用的原文（共 ${quotes.length} 段）${srcNote}】`
        : `【他划出的原文${srcNote}】`
    )
    quotes.forEach((s, i) => {
      parts.push((quotes.length > 1 ? `${i + 1}. ` : '> ') + s)
    })
    parts.push('')
  }

  if (body.paragraph && String(body.paragraph).trim() && String(body.paragraph).trim() !== String(body.selection).trim()) {
    parts.push('【该段完整上下文】')
    parts.push(String(body.paragraph).trim())
    parts.push('')
  }

  if (body.section) parts.push(`【当前阅读位置】章节「${body.section}」`, '')

  // 三种模式各有自己的提问措辞，全部可在配置里改
  let question
  if (mode === 'define' || mode === 'defineDeep') {
    question =
      (mode === 'defineDeep' ? prompts.defineDeep : prompts.define) || '请给划出的这个词下一个准确的定义。'
  } else if (mode === 'explain') {
    question = prompts.explain || '请深入浅出地解释我划出的这段内容。'
  } else {
    // 自由追问不再借用 explain 的措辞 —— 在没有引用时，"这段"会指代不明
    question = String(body.question || '').trim() || '请解释或回应我上面引用的内容。'
  }

  parts.push(mode === 'define' || mode === 'defineDeep' ? '【要求】' : '【他的问题】')
  parts.push(question)

  const messages = [{ role: 'system', content: cfg.systemPrompt || '你是一位耐心的私人老师，用中文回答。' }]
  const history = Array.isArray(body.history) ? body.history.slice(-8) : []
  for (const h of history) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      messages.push({ role: h.role, content: String(h.content).slice(0, 8000) })
    }
  }
  messages.push({ role: 'user', content: parts.join('\n') })
  return { messages, lessonTitle: lesson.heading || lesson.title }
}

/** 给网页版用的单段提示词（无 system role，靠分隔符区分）。 */
function messagesToSinglePrompt(messages) {
  const sys = messages.find((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')
  const head = sys ? `以下是我的提问要求，请严格遵守：\n${sys.content}\n\n======\n\n` : ''
  const body = rest.map((m) => (m.role === 'user' ? m.content : `（我之前的追问）\n${m.content}`)).join('\n\n---\n\n')
  return head + body
}

/* ------------------------------------------------------------------ */
/* Provider: OpenAI 兼容（api / local 共用）                             */
/* ------------------------------------------------------------------ */

async function* parseSSE(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder('utf-8')
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      yield payload
    }
  }
}

async function askViaOpenAICompatible({ providerCfg, messages, onDelta }) {
  const key = providerCfg.apiKey || (providerCfg.apiKeyEnv ? process.env[providerCfg.apiKeyEnv] : '') || ''
  if (providerCfg.apiKeyEnv && !key) {
    const err = new Error(
      `缺少 API Key：请在 tools/ask.config.json 的 providers.${cfg.provider}.apiKey 里填入，` +
        `或设置环境变量 ${providerCfg.apiKeyEnv}。`
    )
    err.hint = 'key-missing'
    throw err
  }

  const base = String(providerCfg.baseUrl || '').replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: providerCfg.model,
      messages,
      stream: true,
      temperature: providerCfg.temperature ?? 0.3,
      max_tokens: providerCfg.maxTokens ?? 2400,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`${providerCfg.label || cfg.provider} 返回 ${res.status}：${text.slice(0, 400)}`)
    err.hint = 'upstream'
    throw err
  }

  for await (const payload of parseSSE(res)) {
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = json.choices?.[0]?.delta?.content
    if (delta) onDelta(delta)
  }
}

/* ------------------------------------------------------------------ */
/* Provider: 浏览器桥接（Playwright 驱动 chat.deepseek.com）              */
/* ------------------------------------------------------------------ */

let bctx = null
let bpage = null
let browserChain = Promise.resolve()

function withBrowserLock(fn) {
  const run = () => fn()
  const next = browserChain.then(run, run)
  browserChain = next.then(
    () => {},
    () => {}
  )
  return next
}

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    const err = new Error(
      '浏览器桥接需要可选依赖 playwright。请在 tools/ 目录执行：\n' +
        '  npm i playwright && npx playwright install chromium'
    )
    err.hint = 'no-playwright'
    throw err
  }
}

async function ensureBrowserPage(bcfg) {
  if (bpage && !bpage.isClosed()) return bpage
  const { chromium } = await loadPlaywright()
  // 登录态属于工具的运行数据，放工具目录而非工作区
  const userDataDir = path.resolve(TOOL_DIR, bcfg.userDataDir || '.cache/browser-profile')
  await fsp.mkdir(userDataDir, { recursive: true })

  try {
    bctx = await chromium.launchPersistentContext(userDataDir, {
      headless: !!bcfg.headless,
      viewport: { width: 1280, height: 940 },
      locale: 'zh-CN',
      args: ['--disable-blink-features=AutomationControlled'],
    })
  } catch (e) {
    const first = String((e && e.message) || e).split('\n')[0]
    const err = new Error(
      '启动桥接浏览器失败：' + first + '\n\n' +
        '若提示找不到 chrome.exe，说明 Chromium 内核不在预期位置。在 tools/ 目录执行一次：\n' +
        '  npx playwright install chromium'
    )
    err.hint = 'browser-launch'
    throw err
  }
  bpage = bctx.pages()[0] || (await bctx.newPage())
  bctx.on('close', () => {
    bctx = null
    bpage = null
  })
  await bpage.goto(bcfg.url || 'https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  return bpage
}

async function findFirst(page, selectors, totalTimeout, log) {
  const list = (selectors || []).filter(Boolean)
  if (!list.length) return null
  const each = Math.max(1500, Math.floor(totalTimeout / list.length))
  for (const sel of list) {
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout: each })
      log?.(`命中选择器：${sel}`)
      return loc
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/** 取一个元素的可见文本。会把 KaTeX 的双份文本合并回 $...$。 */
async function readTextOf(locator) {
  return locator.evaluate((el) => {
    const clone = el.cloneNode(true)
    // KaTeX 同时渲染「可见版本」和隐藏的 MathML 源码，innerText 会把两份都取出来，
    // 公式就变成「\n𝜆\nλ」这种重复。这里统一改写回 LaTeX 源码，交给前端渲染。
    clone.querySelectorAll('.katex').forEach((k) => {
      const ann = k.querySelector('annotation[encoding="application/x-tex"]')
      const tex = ann ? ann.textContent.trim() : ''
      const node = k.ownerDocument.createTextNode(tex ? '$' + tex + '$' : '')
      if (k.parentNode) k.parentNode.replaceChild(node, k)
    })
    clone.querySelectorAll('button, svg').forEach((x) => x.remove())
    return (clone.innerText || clone.textContent || '').trim()
  })
}

/** 按选择器顺序取第一个有内容的元素，命中即返回。 */
async function readFirstMatch(page, selectors) {
  for (const sel of selectors || []) {
    try {
      const n = await page.locator(sel).count()
      if (!n) continue
      const t = await readTextOf(page.locator(sel).nth(n - 1))
      if (t) return t
    } catch {
      /* 试下一个选择器 */
    }
  }
  return ''
}

/** 兜底：用配置里的 assistant 选择器列表取文本。 */
async function readLastAssistant(page, selectors) {
  return readFirstMatch(page, selectors)
}

async function askViaBrowser({ providerCfg: bcfg, messages, onText, onStatus, log }) {
  return withBrowserLock(async () => {
    const page = await ensureBrowserPage(bcfg)
    const sels = bcfg.selectors || {}

    if (bcfg.newChatEachAsk !== false) {
      await page.goto(bcfg.url || 'https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(1200)
    }

    const input = await findFirst(page, sels.input, 20000, log)
    if (!input) {
      const err = new Error(
        '没有找到输入框，通常是尚未登录 chat.deepseek.com。\n' +
          '请在弹出的浏览器窗口里登录一次，然后回来重新提问（登录态会被保留）。'
      )
      err.hint = 'not-logged-in'
      throw err
    }

    const prompt = messagesToSinglePrompt(messages)
    log?.(`浏览器桥接：发送 ${prompt.length} 字符`)

    await input.click()
    try {
      await input.fill(prompt)
    } catch {
      await page.keyboard.insertText(prompt)
    }
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')

    const deadline = Date.now() + Number(bcfg.replyTimeoutMs || 180000)
    const startedAt = Date.now()
    // DeepSeek 页面上「思考过程」和「正文」是两个独立的 .ds-markdown 容器，
    // 只有正文带 ds-assistant-message-main-content。必须锁定它，
    // 否则会把模型的独白当成答案显示给用户。
    const mainSels = sels.mainContent || sels.assistant || []
    let last = ''
    let stable = 0
    let toldThinking = false
    let fellBack = false

    while (Date.now() < deadline) {
      await page.waitForTimeout(400)

      const cur = await readFirstMatch(page, mainSels)

      if (!cur) {
        // 正文还没出现 = 正在思考。实测思考阶段约 5~15 秒，
        // 这段时间页面上没有任何可用信号，只能按时间给提示。
        if (!toldThinking && Date.now() - startedAt > 1500) {
          toldThinking = true
          onStatus('DeepSeek 正在思考…（网页版首次响应通常 5~15 秒）')
        }
        if (!fellBack && Date.now() - startedAt > 90000) {
          fellBack = true
          const fb = await readLastAssistant(page, sels.assistant)
          if (fb) {
            onText(fb)
            last = fb
            break
          }
        }
        continue
      }

      if (cur !== last) {
        if (toldThinking) {
          toldThinking = false
          onStatus('')
        }
        // 发全文而不是差分：生成过程中公式会从 LaTeX 源码变成渲染结果，
        // 差分必然错位。本地服务带宽无所谓，整体替换最稳。
        onText(cur)
        last = cur
        stable = 0
      } else {
        stable += 1
        // 实测生成期间正文每 500ms 都有新增、从不停顿，因此
        // 「连续 8 次（约 4 秒）无变化」是可靠的完成判据。
        // 刻意不依赖「停止按钮」之类的信号 —— 实测这些选择器在 DeepSeek 页面上并不稳定存在。
        if (await isGenerating(page, sels)) stable = 0
        else if (stable >= 8) break
      }
    }

    if (!last) {
      const err = new Error('等待网页版回答超时。可能是页面结构变化或网络异常，请查看桥接浏览器窗口的状态。')
      err.hint = 'bridge-timeout'
      throw err
    }
    return last
  })
}

async function isGenerating(page, sels) {
  for (const sel of sels.stopButton || []) {
    try {
      const loc = page.locator(sel).first()
      if (await loc.isVisible({ timeout: 300 })) return true
    } catch {
      /* 忽略 */
    }
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                             */
/* ------------------------------------------------------------------ */

function getProviderConfig(name) {
  const p = (cfg.providers || {})[name]
  if (!p) {
    const err = new Error(`未知 provider：${name}。可选：${Object.keys(cfg.providers || {}).join(', ')}`)
    err.hint = 'bad-provider'
    throw err
  }
  return p
}

async function runAsk(body, sink, log) {
  const name = cfg.provider
  const providerCfg = getProviderConfig(name)
  const { messages } = await buildMessages(body)
  log?.(`provider=${name} model=${providerCfg.model || '(网页版)'} prompt=${messages[messages.length - 1].content.length}字符`)

  if (name === 'browser') {
    await askViaBrowser({ providerCfg, messages, onText: sink.text, onStatus: sink.status, log })
  } else {
    await askViaOpenAICompatible({ providerCfg, messages, onDelta: sink.delta })
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 4 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function hostAllowed(req) {
  const host = String(req.headers.host || '')
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
}

function tokenOk(req) {
  return req.headers['x-ask-token'] === TOKEN
}

/**
 * 在 </body> 前注入提问组件与文献链接组件；已有注入则跳过。
 *
 * 注意：注入的只是「脚本 + 一份数据」。文献链接由前端组件在浏览器里就地识别、
 * 运行时包成 <a> —— lesson 文件本身一行都不改，禁用 JS 时正文原样呈现。
 */
async function injectAsk(html, lessonFile) {
  if (html.includes('ask-ai.js')) return html
  const boot = {
    token: TOKEN,
    lesson: lessonFile,
    endpoint: '/api/ask',
    exportUrl: '/api/export',
    origin: '',
    title: stripTags((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]),
  }
  const docIndex = await pdfReader.buildDocIndex()
  const linksData = docIndex.length
    ? `window.__DOC_LINKS__=${JSON.stringify(docIndex).replace(/</g, '\\u003c')};`
    : ''
  const linksTag = docIndex.length ? `\n<script src="/assets/ask-doclinks.js"></script>\n` : ''
  const snippet =
    `\n<script>window.__ASK__=${JSON.stringify(boot).replace(/</g, '\\u003c')};${linksData}</script>` +
    `\n<script src="/assets/ask-ai.js"></script>\n` +
    linksTag
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, snippet + '</body>')
  return html + snippet
}

/**
 * 工具自带的静态资源前缀。这些属于 ask 组件本身，优先从工具目录取 ——
 * 这样工作区 assets/ 只留 teach skill 自己的东西。
 *
 * 但工具目录里没有的文件（例如课程专用的 katex/contrib/auto-render.min.js）
 * 会回退到工作区，所以两边不会互相拖累。
 */
const TOOL_ASSET_PREFIXES = [
  'assets/ask-ai.js',
  'assets/ask-doclinks.js',
  'assets/pdf-reader.js',
  'assets/pdfjs/',
  'assets/katex/',
]

async function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '')

  let abs = null
  if (TOOL_ASSET_PREFIXES.some((p) => rel.startsWith(p))) {
    const toolAbs = path.resolve(TOOL_DIR, rel)
    if (toolAbs.startsWith(TOOL_DIR) && fs.existsSync(toolAbs) && fs.statSync(toolAbs).isFile()) {
      abs = toolAbs
    }
  }
  if (!abs) {
    const wsAbs = path.resolve(ROOT, rel)
    if (!wsAbs.startsWith(ROOT)) return send(res, 403, 'forbidden')
    abs = wsAbs
  }
  let stat
  try {
    stat = await fsp.stat(abs)
  } catch {
    return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' })
  }
  if (stat.isDirectory()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' })

  const ext = path.extname(abs).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'

  if (ext === '.html') {
    let html = await fsp.readFile(abs, 'utf8')
    // 把 ../ 或 ../../ 开头的资源引用统一重写成站点绝对路径，
    // 这样课程无论在 lessons/ 顶层还是 lessons/<分类>/ 里都能正确加载，
    // 移动文件时不必手工改相对路径。
    html = html.replace(/(href|src)="((?:\.\.\/)+)([^"]*)"/g, (m, attr, dots, rest) => `${attr}="/${rest}"`)

    const relFromLessons = path.relative(path.join(ROOT, 'lessons'), abs)
    // 统一成 / 分隔，作为前后端约定的课程 id（支持 lessons/<分类>/xxx.html）
    const lessonFile = !relFromLessons.startsWith('..') ? relFromLessons.split(path.sep).join('/') : null
    if (lessonFile) html = await injectAsk(html, lessonFile)
    return send(res, 200, html, { 'Content-Type': type })
  }

  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
  fs.createReadStream(abs).pipe(res)
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESC[c])
}

/* ------------------------------------------------------------------ */
/* 工作区（课程目录）                                                    */
/* ------------------------------------------------------------------ */

const isDirSafe = (p) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把用户填的路径解析成工作区根。
 *
 * 容错是刻意的：用户脑子里的「课程目录」既可能是工作区（含 lessons/），
 * 也可能就是 lessons/ 本身，甚至更深的分类目录。向上最多找 4 层，
 * 谁含有 lessons/ 子目录谁就是工作区。
 * 但猜不出来时**原样采纳、不做「看起来像」的自动纠正** —— 宁可显示空列表，
 * 也不要莫名其妙把工作区改到别的目录上去。
 */
function resolveWorkspace(raw) {
  const text = String(raw || '').trim().replace(/^["']|["']$/g, '')
  if (!text) return { error: '请填写课程目录的路径' }
  const abs = path.resolve(text)
  if (!fs.existsSync(abs)) return { error: '这个路径不存在：' + abs }
  if (!isDirSafe(abs)) return { error: '这不是一个目录：' + abs }

  let cur = abs
  for (let i = 0; i < 4; i++) {
    if (isDirSafe(path.join(cur, 'lessons'))) {
      return { root: cur, note: cur === abs ? '' : `已自动上溯到工作区：${cur}` }
    }
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return { root: abs, note: '这个目录里还没有 lessons/ 子目录，先按工作区使用' }
}

/** 当前工作区的体检结果，首页与设置页共用 */
async function workspaceInfo() {
  const lessonsDir = path.join(ROOT, 'lessons')
  const hints = {
    exists: fs.existsSync(ROOT),
    lessons: isDirSafe(lessonsDir),
    mission: fs.existsSync(path.join(ROOT, 'MISSION.md')),
    lessonCss: fs.existsSync(path.join(ROOT, 'assets', 'lesson.css')),
  }
  // 三者有其一就算「像样的工作区」；全无则首页给醒目提示
  const valid = hints.exists && (hints.lessons || hints.mission || hints.lessonCss)
  let lessonCount = 0
  try {
    lessonCount = (await getCatalog()).filter((c) => c.kind !== 'pdf').length
  } catch {
    lessonCount = 0
  }
  const sourceLabel = {
    cli: '命令行 --workspace 指定（优先级最高）',
    local: 'ask.config.local.json（本机覆盖层）',
    config: 'ask.config.json',
    fallback: '未指定，退回工具目录的上一级',
  }[cfg._workspaceSource] || '未知'
  return {
    workspace: ROOT,
    source: cfg._workspaceSource || 'unknown',
    sourceLabel,
    valid,
    hints,
    lessonCount,
    lessonsDir,
  }
}

/**
 * 切换工作区：写本地覆盖层 → 更新运行期 ROOT → 清掉两个缓存。
 * **绝不写 ask.config.json** —— 那是要进公开仓库的中性模板。
 */
async function setWorkspace(raw) {
  const r = resolveWorkspace(raw)
  if (r.error) return { error: r.error }
  writeLocalWorkspace(r.root)
  replaceCfg(buildRuntime(FILE_CFG))
  // 命令行 --workspace 优先级最高，此时 ROOT 仍是命令行给的那个（下面会出提示）
  ROOT = cfg.workspace
  catalogCache = { at: 0, data: null }
  pdfReader.invalidate() // 相对路径来源（如「参考文献」）要按新工作区重解析
  const info = await workspaceInfo()
  if (info.source === 'cli') {
    info.warning =
      '本次启动用 --workspace 指定了工作区，它优先级最高；去掉该参数重启后本地设置才生效。'
  }
  if (r.note) info.note = r.note
  return info
}

/**
 * 扫一遍工作区，列出「含 PDF 的目录」和「所有 PDF 文件」。
 * 只为了在首页的添加面板里给可点选的候选，省得手打路径。最多下钻 3 层。
 */
async function scanPdfCandidates() {
  const dirsFound = []
  const pdfFiles = []
  async function walk(rel, depth) {
    if (depth > 3) return
    const abs = path.join(ROOT, rel)
    let entries = []
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    let hasPdf = false
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
        hasPdf = true
        pdfFiles.push(rel ? rel + '/' + e.name : e.name)
      }
    }
    if (hasPdf && rel) dirsFound.push(rel)
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        await walk(rel ? rel + '/' + e.name : e.name, depth + 1)
      }
    }
  }
  await walk('', 0)
  return { dirs: dirsFound, files: pdfFiles }
}

function indexPage(catalog, token, pdfEnabled = false) {
  // 按分类分组展示
  const groups = []
  for (const c of catalog) {
    let g = groups.find((x) => x.id === c.category)
    if (!g) {
      g = { id: c.category, label: c.categoryLabel, items: [] }
      groups.push(g)
    }
    g.items.push(c)
  }
  // 文献分组**空也建**。原先是「有文献才渲染分组」，而添加入口挂在分组标题上 ——
  // 等于没有任何文献时就没有分组、没有入口，第一篇永远加不进来（鸡生蛋）。
  if (pdfEnabled && !groups.some((g) => g.id === pdfReader.PDF_CATEGORY)) {
    groups.push({
      id: pdfReader.PDF_CATEGORY,
      label: cfg.pdf?.categoryLabel || '文献',
      items: [],
    })
  }

  // 「还没有课程」的引导必须独立于分组是否存在：文献分组现在是常驻的，
  // 若把它挂在 groups.length 上，0 课程时用户只会看到一个空的文献分组，
  // 完全看不出该去哪填课程目录。
  const hasLessons = catalog.some((c) => c.kind !== 'pdf')
  const noLessonHint = hasLessons
    ? ''
    : '<p class="empty">还没有课程。把上面的「课程目录」填成 <code>lessons/</code> 所在的那一层，这里就会出现课程；' +
      '课程 HTML 放进 <code>lessons/</code> 或 <code>lessons/&lt;分类名&gt;/</code>。</p>'

  const listHTML =
    noLessonHint +
    (groups.length
      ? groups
          .map((g) => {
            const lis = g.items.length
              ? g.items
                  .map((c) => {
                    const tag = c.kind === 'pdf' ? 'PDF' : c.num ? 'Lesson ' + c.num : 'Lesson'
                    return (
                      `<li><a href="${c.url}"><span class="n">${escapeHtml(tag)}</span>` +
                      `<span class="h">${escapeHtml(c.heading || c.title)}</span></a></li>`
                    )
                  })
                  .join('\n')
              : '<li class="blank">还没有文献。点上面的「＋ 添加文献」，绑定一个目录或添加单篇即可。</li>'
            const isPdf = g.id === pdfReader.PDF_CATEGORY || g.items.some((c) => c.kind === 'pdf')
            // 文献分组用「篇」，课程分组用「课」；文献分组还多一个「添加」入口
            const unit = isPdf ? '篇' : '课'
            const cntId = isPdf ? ' id="pdf-count"' : ''
            const ulId = isPdf ? ' id="pdf-list"' : ''
            const addBtn = isPdf ? '　<button type="button" id="pdf-add">＋ 添加文献</button>' : ''
            return (
              `<section><h2 class="cat">${escapeHtml(g.label)}` +
              `<span class="cnt"${cntId}>${g.items.length} ${unit}</span>${addBtn}</h2>\n` +
              `<ul${ulId}>\n${lis}\n</ul></section>`
            )
          })
          .join('\n')
      : '')

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>教学工坊 · 目录</title>
<style>
:root{--ink:#1a1a1a;--ink-2:#4a4a4a;--ink-3:#767676;--rule:#d8d5cd;--paper:#fdfcfa;--accent:#8c2f1f;--box:#f4f2ed;
--warn:#8a5a12;--warn-soft:#faf0dd;--hi:#1d5c48}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Songti SC",serif;font-size:17px;line-height:1.68}
.wrap{max-width:720px;margin:0 auto;padding:64px 28px 96px}
.kicker{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-size:32px;font-weight:600;margin:0 0 12px;letter-spacing:-.01em}
.lead{font-size:18px;color:var(--ink-2);margin:0 0 8px}
.head{display:flex;align-items:flex-start;gap:24px;justify-content:space-between}
.set{flex:0 0 auto;display:inline-block;padding:7px 15px;border:1px solid var(--rule);border-radius:6px;font-size:13.5px;
color:var(--ink-2);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;text-decoration:none;margin-top:14px;white-space:nowrap}
.set:hover{border-color:var(--ink-3);background:var(--box);color:var(--ink)}
ul{list-style:none;padding:0;margin:0}
li{border-bottom:1px solid var(--rule)}
a{display:flex;align-items:baseline;gap:14px;padding:14px 4px;text-decoration:none;color:var(--ink)}
li a:hover{background:var(--box)}
.n{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:var(--accent);letter-spacing:.06em;flex:0 0 84px}
.h{font-size:17px}
.cat{display:flex;align-items:baseline;gap:10px;font-size:13.5px;font-weight:600;color:var(--ink-3);
margin:42px 0 4px;padding-bottom:6px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
section:first-of-type .cat{margin-top:18px}
.cnt{font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:400;color:#a09d95}
.empty{margin:30px 0;padding:18px 20px;background:var(--box);border-radius:5px;font-size:14.5px;color:var(--ink-2);
font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.empty code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:#fff;border:1px solid var(--rule);border-radius:3px;padding:1px 5px}
.tip{margin-top:34px;font-size:13.5px;color:var(--ink-3);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.tip a{display:inline;padding:0;color:var(--accent)}
kbd{font-family:ui-monospace,Menlo,monospace;background:var(--box);border:1px solid var(--rule);border-radius:3px;padding:1px 5px;font-size:12px}
/* ---- 课程目录（工作区）入口 ---- */
.wsbar{display:flex;align-items:baseline;gap:10px;margin:24px 0 0;padding:9px 13px;border:1px solid var(--rule);
border-radius:6px;background:var(--box);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12.5px}
.wsbar .wsk{flex:0 0 auto;color:var(--ink-3)}
.wsbar .wsv{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink-2)}
.wsbar .wsc{flex:0 0 auto;color:var(--ink-3);font-size:11.5px}
.wsbar button{flex:0 0 auto;background:none;border:1px solid var(--rule);border-radius:4px;font-family:inherit;
font-size:11.5px;color:var(--ink-2);cursor:pointer;padding:2px 9px}
.wsbar button:hover{border-color:var(--accent);color:var(--accent);background:#f6edea}
.wsbar.bad{border-style:dashed;border-color:#e2c9a8;background:var(--warn-soft)}
.wsbar.bad .wsk{color:var(--warn);font-size:14px;line-height:1}
.wsbar.bad .wsv{color:var(--warn);font-family:inherit;font-size:12.5px;white-space:normal;overflow:visible}
.wsform{display:flex;gap:8px;margin:9px 0 0}
.wsform[hidden]{display:none}
.wsform input{flex:1;min-width:0;border:1px solid var(--rule);border-radius:5px;padding:7px 10px;
font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--ink);background:#fff;outline:none}
.wsform input:focus{border-color:var(--accent)}
.wsform button{flex:0 0 auto;background:var(--accent);color:var(--paper);border:0;border-radius:5px;
padding:7px 15px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12.5px;cursor:pointer}
.wsform button:hover{background:#7a2819}
.wsform button.ghost{background:none;color:var(--ink-3);border:1px solid var(--rule)}
.wsform button.ghost:hover{background:var(--box);color:var(--ink)}
.wsnote{font-size:12px;color:var(--ink-3);margin:7px 0 0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wsnote.err{color:var(--accent)}
.wsnote.warn{color:var(--warn)}
ul li.blank{color:var(--ink-3);font-size:12.5px;padding:11px 4px;
font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
/* ---- 文献来源管理 ---- */
#pdf-add{background:none;border:1px dashed var(--rule);border-radius:4px;font-family:inherit;
font-size:11.5px;font-weight:400;color:var(--accent);cursor:pointer;padding:2px 8px;margin-left:4px}
#pdf-add:hover{background:#f6edea;border-color:var(--accent)}
.modal{position:fixed;inset:0;z-index:50;background:rgba(26,26,26,.42);display:none;
align-items:flex-start;justify-content:center;padding:56px 16px;overflow-y:auto}
.modal.on{display:flex}
.modal-box{background:var(--paper);border-radius:10px;width:min(680px,100%);overflow:hidden;
box-shadow:0 18px 50px rgba(0,0,0,.25);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
font-size:13.5px;color:var(--ink)}
.modal-head{display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid var(--rule)}
.modal-head h3{margin:0;font-size:14.5px;font-weight:600;flex:1}
.modal-head button{background:none;border:0;font-size:20px;line-height:1;color:var(--ink-3);cursor:pointer;padding:0 4px}
.modal-head button:hover{color:var(--ink)}
.modal-body{padding:2px 18px 18px;max-height:66vh;overflow-y:auto}
.modal-body section{padding:14px 0;border-bottom:1px solid #ece9e2}
.modal-body section:last-of-type{border-bottom:0}
.modal-body h4{margin:0 0 9px;font-size:12.5px;font-weight:600;color:var(--ink-2)}
.modal-body h4 .hint{font-weight:400;color:var(--ink-3);font-size:11.5px;margin-left:8px}
.row{display:flex;gap:8px}
.row input{flex:1;min-width:0;border:1px solid var(--rule);border-radius:5px;padding:7px 10px;
font-family:inherit;font-size:13px;color:var(--ink);background:#fff;outline:none}
.row input:focus{border-color:var(--accent)}
.row button{flex:0 0 auto;background:var(--accent);color:#fdfcfa;border:0;border-radius:5px;
padding:7px 14px;font-family:inherit;font-size:13px;cursor:pointer}
.row button:hover{background:#7a2819}
.srclist{list-style:none;margin:0;padding:0}
.srclist li{display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px dashed #ece9e2;font-size:12.5px}
.srclist li:last-child{border-bottom:0}
.srclist li.empty{color:var(--ink-3);border:0}
.srclist .tag{flex:0 0 auto;background:var(--box);border:1px solid var(--rule);border-radius:3px;
padding:1px 6px;font-size:11px;color:var(--ink-3)}
.srclist .path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink-2)}
.srclist button{flex:0 0 auto;background:none;border:1px solid var(--rule);border-radius:4px;
font-family:inherit;font-size:11.5px;color:var(--ink-3);cursor:pointer;padding:2px 8px}
.srclist button:hover{border-color:#c9a;color:var(--accent);background:#f6edea}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.chips:empty{margin-top:0}
.chip{background:var(--box);border:1px solid var(--rule);border-radius:12px;font-family:inherit;
font-size:11.5px;color:var(--ink-2);cursor:pointer;padding:3px 10px;max-width:100%;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip:hover{border-color:var(--accent);color:var(--accent);background:#f6edea}
.msg{margin:12px 0 0;font-size:12.5px;color:var(--ink-3);min-height:1em}
.msg.err{color:var(--accent)}
</style></head><body><div class="wrap">
<div class="head">
<div>
<p class="kicker">Teaching Workspace</p>
<h1>教学工坊 · 课程目录</h1>
<p class="lead">打开任意一课，划出不懂的句子即可就地提问。</p>
</div>
<a class="set" href="/config" title="切换 AI 线路、填 API Key、改提示词">&#9881; 设置</a>
</div>

<div class="wsbar" id="wsbar"></div>
<div class="wsform" id="wsform" hidden>
<input id="ws-input" placeholder="填 lessons/ 所在的那一层，例如 D:/Project/我的课程；也可以直接填 lessons/">
<button type="button" id="ws-save">绑定</button>
<button type="button" class="ghost" id="ws-cancel">取消</button>
</div>
<p class="wsnote" id="ws-note"></p>

${listHTML}
<p class="tip">快捷键：<kbd>Ctrl</kbd>+<kbd>K</kbd> 打开提问抽屉 · <kbd>Esc</kbd> 关闭 · 选中文字后按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 直接针对选区提问</p>
<p class="tip">其它页面（如 <a href="/reference/glossary.html">reference/glossary.html</a>）访问时，提问组件同样会自动注入。</p>
</div>

<div class="modal" id="pdf-modal">
  <div class="modal-box">
    <div class="modal-head">
      <h3>管理文献来源</h3>
      <button type="button" id="pdf-close" title="关闭">×</button>
    </div>
    <div class="modal-body">
      <section>
        <h4>当前来源</h4>
        <ul class="srclist" id="pdf-srclist"></ul>
      </section>
      <section>
        <h4>绑定目录<span class="hint">目录里的 PDF 会自动出现，之后往里新增的也会实时跟上</span></h4>
        <div class="row">
          <input id="pdf-dir-input" placeholder="目录名（相对工作区），也可以填绝对路径">
          <button type="button" id="pdf-dir-add">绑定</button>
        </div>
        <div class="chips" id="pdf-dir-chips"></div>
      </section>
      <section>
        <h4>添加单篇<span class="hint">可以指向工作区之外的 PDF</span></h4>
        <div class="row">
          <input id="pdf-file-input" placeholder="PDF 路径（相对工作区），也可以填绝对路径">
          <button type="button" id="pdf-file-add">添加</button>
        </div>
        <div class="chips" id="pdf-file-chips"></div>
      </section>
      <p class="msg" id="pdf-msg"></p>
    </div>
  </div>
</div>

<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var modal = document.getElementById('pdf-modal');
  var btn = document.getElementById('pdf-add');
  // 注意：只判 modal，不判 btn —— 按钮理论上常驻，但用 pdf.enabled=false 关掉文献
  // 功能时它不会渲染，此时这块脚本仍要能正常结束，不能把整段拖死。
  if (!modal) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(body) {
    var opt = { method: body ? 'POST' : 'GET', headers: { 'x-ask-token': TOKEN } };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch('/api/pdf-sources', opt).then(function (r) { return r.json(); });
  }
  function say(t, isErr) {
    var el = document.getElementById('pdf-msg');
    el.textContent = t || '';
    el.className = 'msg' + (isErr ? ' err' : '');
  }

  function render(d) {
    var ul = document.getElementById('pdf-srclist');
    var items = [];
    (d.dirs || []).forEach(function (p) { items.push({ tag: '目录', path: p, act: 'remove-dir' }); });
    (d.files || []).forEach(function (p) { items.push({ tag: '单篇', path: p, act: 'remove-file' }); });
    ul.innerHTML = items.length
      ? items.map(function (it) {
          return '<li><span class="tag">' + it.tag + '</span>' +
            '<span class="path" title="' + esc(it.path) + '">' + esc(it.path) + '</span>' +
            '<button type="button" data-act="' + it.act + '" data-path="' + esc(it.path) + '">移除</button></li>';
        }).join('')
      : '<li class="empty">还没有添加任何来源</li>';

    var cand = d.candidates || {};
    // 注意：这段代码在模板字符串里，正则里的反斜杠转义很容易被吃掉两层，
    // 所以这里用 split/join 代替正则，避免踩坑。
    function normPath(s) {
      var t = String(s || '').split('\\\\').join('/');
      while (t.length > 1 && t.slice(-1) === '/') t = t.slice(0, -1);
      return t;
    }
    function chips(id, list, act, added) {
      var have = (added || []).map(normPath);
      var rest = (list || []).filter(function (p) { return have.indexOf(normPath(p)) < 0; });
      document.getElementById(id).innerHTML = rest.length
        ? rest.map(function (p) {
            return '<button type="button" class="chip" data-act="' + act + '" data-path="' + esc(p) +
              '" title="' + esc(p) + '">' + esc(p) + '</button>';
          }).join('')
        : '<span style="font-size:11.5px;color:#8a877f">可以添加的都已经添加了</span>';
    }
    chips('pdf-dir-chips', cand.dirs, 'add-dir', d.dirs);
    chips('pdf-file-chips', cand.files, 'add-file', d.files);

    // 顺手把首页的文献列表就地刷新，不用整页重载
    var list = document.getElementById('pdf-list');
    if (list) {
      list.innerHTML = (d.pdfs || []).map(function (p) {
        return '<li><a href="/pdf?file=' + encodeURIComponent(p.rel) + '">' +
          '<span class="n">PDF</span><span class="h">' + esc(p.title) + '</span></a></li>';
      }).join('');
    }
    var cnt = document.getElementById('pdf-count');
    if (cnt) cnt.textContent = (d.pdfs || []).length + ' 篇';
  }

  function send(action, path) {
    say('处理中…');
    api({ action: action, path: path }).then(function (d) {
      if (d.error) return say(d.error, true);
      render(d);
      say(d.message || '完成');
    }).catch(function (e) { say('请求失败：' + e.message, true); });
  }

  function open() {
    modal.classList.add('on');
    say('读取中…');
    api().then(function (d) {
      if (d.error) return say(d.error, true);
      render(d);
      say('');
    }).catch(function (e) { say('无法读取来源：' + e.message, true); });
  }

  btn.addEventListener('click', open);
  document.getElementById('pdf-close').addEventListener('click', function () { modal.classList.remove('on'); });
  modal.addEventListener('click', function (e) {
    if (e.target === modal) modal.classList.remove('on');
    var b = e.target.closest ? e.target.closest('[data-act]') : null;
    if (b) send(b.getAttribute('data-act'), b.getAttribute('data-path') || '');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('on')) modal.classList.remove('on');
  });
  function bindAdd(inputId, btnId, action) {
    var input = document.getElementById(inputId);
    var go = function () {
      var v = input.value.trim();
      if (!v) return;
      send(action, v);
      input.value = '';
    };
    document.getElementById(btnId).addEventListener('click', go);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  }
  bindAdd('pdf-dir-input', 'pdf-dir-add', 'add-dir');
  bindAdd('pdf-file-input', 'pdf-file-add', 'add-file');
})();
</script>

<script>
/* 课程目录（工作区）入口。与上面的文献面板相互独立：文献是「往里加来源」，
   这个是「整个工作区指到哪」—— 后者决定 lessons/、MISSION.md、assets/lesson.css
   从哪读，所以它没配好时首页会一片空白，必须给个显眼的入口。 */
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var bar = document.getElementById('wsbar');
  var form = document.getElementById('wsform');
  var input = document.getElementById('ws-input');
  var note = document.getElementById('ws-note');
  var saveBtn = document.getElementById('ws-save');
  if (!bar || !form || !input) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(t, cls) {
    if (!note) return;
    note.textContent = t || '';
    note.className = 'wsnote' + (cls ? ' ' + cls : '');
  }

  function render(d) {
    if (d.valid) {
      bar.className = 'wsbar';
      bar.innerHTML = '<span class="wsk">课程目录</span>' +
        '<span class="wsv" title="' + esc(d.workspace) + '">' + esc(d.workspace) + '</span>' +
        '<span class="wsc">' + (d.lessonCount || 0) + ' 课</span>' +
        '<button type="button" id="ws-toggle">更换</button>';
      form.hidden = true;
      input.value = d.workspace || '';
      var t = document.getElementById('ws-toggle');
      if (t) {
        t.addEventListener('click', function () {
          form.hidden = !form.hidden;
          if (!form.hidden) input.focus();
        });
      }
    } else {
      bar.className = 'wsbar bad';
      bar.innerHTML = '<span class="wsk">&#9888;</span>' +
        '<span class="wsv">还没有指定课程目录，所以这里看不到任何课程。</span>' +
        '<span class="wsc">填在下面</span>';
      form.hidden = false;
      input.value = '';
    }
    var msg = [];
    if (d.warning) msg.push(d.warning);
    if (d.note) msg.push(d.note);
    say(msg.join('　'), d.warning ? 'warn' : '');
  }

  function load() {
    fetch('/api/workspace', { headers: { 'x-ask-token': TOKEN } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.error) render(d); })
      .catch(function (e) { say('读取课程目录失败：' + e.message, 'err'); });
  }

  function save() {
    var v = input.value.trim();
    if (!v) return say('请先填一个路径', 'err');
    if (saveBtn) saveBtn.disabled = true;
    say('正在切换…');
    fetch('/api/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ask-token': TOKEN },
      body: JSON.stringify({ path: v })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (saveBtn) saveBtn.disabled = false;
      if (d.error) return say(d.error, 'err');
      say('已切换，正在刷新…');
      // 课程列表、分组、课数、文献都要跟着变 —— 整页重载最稳，别做局部 patch
      location.reload();
    }).catch(function (e) {
      if (saveBtn) saveBtn.disabled = false;
      say('切换失败：' + e.message, 'err');
    });
  }

  if (saveBtn) saveBtn.addEventListener('click', save);
  var cancel = document.getElementById('ws-cancel');
  if (cancel) {
    cancel.addEventListener('click', function () {
      input.value = '';
      form.hidden = true;
      say('');
    });
  }
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
  load();
})();
</script>

</body></html>`
}

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

/** API Key 只回掩码：sk-ab****yz。永不下发明文。 */
function redactKey(k) {
  const s = String(k || '')
  if (!s) return ''
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '****' + s.slice(-4)
}

function redactedConfig() {
  const clone = JSON.parse(JSON.stringify(cfg))
  delete clone._readme
  delete clone._workspaceSource // 界面提示用，属运行期信息，不属于「配置」
  for (const v of Object.values(clone.providers || {})) {
    if (v && typeof v.apiKey === 'string' && v.apiKey) v.apiKey = redactKey(v.apiKey)
  }
  return clone
}

const PATCH_CONTEXT_KEYS = ['includeMission', 'includeCatalog', 'lessonMode', 'defineLessonMode', 'selectionWindow', 'maxLessonChars']
const PATCH_PROMPT_KEYS = ['define', 'defineDeep', 'explain']
const PATCH_PROVIDER_KEYS = [
  'baseUrl', 'model', 'apiKey', 'apiKeyEnv', 'temperature', 'maxTokens',
  'url', 'headless', 'replyTimeoutMs', 'userDataDir',
]

/** 只允许改白名单字段；apiKey 传回掩码时视为「不修改」。 */
function applyConfigPatch(patch) {
  // 基线用主配置**原文** FILE_CFG，而不是运行期 cfg —— 后者含运行期才解析出来的
  // 本机绝对工作区路径与命令行覆盖值，写回文件就等于把本机信息推进公开仓库。
  const next = JSON.parse(JSON.stringify(FILE_CFG))

  if (patch.provider) {
    if (!next.providers[patch.provider]) throw new Error('未知线路：' + patch.provider)
    next.provider = patch.provider
  }

  if (patch.context && typeof patch.context === 'object') {
    for (const k of PATCH_CONTEXT_KEYS) {
      if (patch.context[k] !== undefined) next.context[k] = patch.context[k]
    }
  }

  if (patch.prompts && typeof patch.prompts === 'object') {
    for (const k of PATCH_PROMPT_KEYS) {
      if (typeof patch.prompts[k] === 'string') next.prompts[k] = patch.prompts[k]
    }
  }

  if (typeof patch.systemPrompt === 'string' && patch.systemPrompt.trim()) {
    next.systemPrompt = patch.systemPrompt
  }

  if (patch.providers && typeof patch.providers === 'object') {
    for (const [name, p] of Object.entries(patch.providers)) {
      if (!next.providers[name] || !p) continue
      for (const k of PATCH_PROVIDER_KEYS) {
        if (p[k] === undefined) continue
        if (k === 'apiKey' && /\*\*\*\*/.test(String(p[k]))) continue
        next.providers[name][k] = p[k]
      }
    }
  }

  // 文献来源（首页「添加文献」用）：只允许改这两个数组，别的一概不动
  if (patch.pdf && typeof patch.pdf === 'object') {
    next.pdf = next.pdf || {}
    if (Array.isArray(patch.pdf.dirs)) next.pdf.dirs = patch.pdf.dirs.filter(Boolean).map(String)
    if (Array.isArray(patch.pdf.files)) next.pdf.files = patch.pdf.files.filter(Boolean).map(String)
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  FILE_CFG = JSON.parse(JSON.stringify(next))

  // 热更新内存配置，省掉重启。走 buildRuntime 是为了让运行期覆盖
  // （--workspace / ask.config.local.json）在保存后依然生效。
  replaceCfg(buildRuntime(FILE_CFG))
  return { provider: cfg.provider }
}

function configPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>划词提问 · 配置</title>
<style>
/* 本页自带基础层，**不引用工作区的 /assets/lesson.css**。
   那个文件属于 teach skill（课程组件），工作区没指向课程目录时它不存在，
   请求会 404 —— 于是 :root 变量和 .wrap/.kicker/h1/h2/.lead 一起失效，
   整页只剩零散边框，看起来就像「CSS 全没了」。
   工具自己的页面必须自包含：设置页有没有样式，不该取决于课程放在哪。
   下面这套 token 与 lesson.css 保持一致，改课程主题时两边要对齐。 */
:root{--ink:#1a1a1a;--ink-2:#4a4a4a;--ink-3:#767676;--rule:#d8d5cd;--paper:#fdfcfa;
--accent:#8c2f1f;--accent-soft:#f6edea;--hi:#1d5c48;--hi-soft:#e3f0ea;
--warn:#8a5a12;--warn-soft:#faf0dd;--box:#f4f2ed}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-size:16px;line-height:1.68;
font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:56px 28px 96px}
.kicker{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11.5px;letter-spacing:.14em;
text-transform:uppercase;color:var(--accent);margin:0 0 10px}
h1{font-size:30px;line-height:1.22;font-weight:600;letter-spacing:-.01em;margin:0 0 12px}
h2{font-size:20px;font-weight:600;margin:44px 0 14px;padding-bottom:7px;border-bottom:1px solid var(--rule)}
.lead{font-size:17px;color:var(--ink-2);line-height:1.6;margin:0 0 15px}
fieldset{border:1px solid var(--rule);border-radius:6px;padding:14px 18px;margin:0 0 14px;background:#fff}
legend{font-size:12.5px;letter-spacing:.02em;color:var(--ink-3);padding:0 6px;font-weight:500}
label.row{display:block;margin:0 0 12px}
label.row .k{display:block;font-size:12.5px;color:var(--ink-3);margin-bottom:4px}
input[type=text],input[type=password],input[type=number],select,textarea{
  width:100%;box-sizing:border-box;border:1px solid var(--rule);border-radius:5px;padding:8px 10px;
  font-family:inherit;font-size:13.5px;color:var(--ink);background:#fff;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(140,47,31,.08)}
textarea{resize:vertical;line-height:1.6}
.provs{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:6px}
.prov{display:block;border:1px solid var(--rule);border-radius:6px;padding:12px 14px;cursor:pointer;background:#fff;transition:.12s}
.prov:hover{border-color:var(--ink-3)}
.prov.on{border-color:var(--accent);background:var(--accent-soft);border-width:2px;padding:11px 13px}
.prov b{display:block;font-size:14px;margin-bottom:3px;font-weight:600}
.prov span{font-size:12px;color:var(--ink-3);line-height:1.5}
.prov input{margin-right:6px}
.hint{font-size:12.5px;color:var(--ink-3);margin:2px 0 0;line-height:1.55}
.bar{position:sticky;bottom:0;background:linear-gradient(transparent,var(--paper) 26%);padding:18px 0 6px;margin-top:30px;display:flex;gap:12px;align-items:center}
button.save{background:var(--accent);color:var(--paper);border:0;border-radius:5px;padding:11px 22px;font-size:14px;font-family:inherit;cursor:pointer;font-weight:500}
button.save:hover{background:#7a2819}
button.save:disabled{background:var(--rule);cursor:not-allowed}
.msg{font-size:13px}.msg.ok{color:var(--hi)}.msg.err{color:var(--accent)}
.cur{font-size:12.5px;color:var(--ink-3);font-family:ui-monospace,Menlo,monospace}
/* ---- 工作区块 ---- */
.fld .k{display:block;font-size:12.5px;color:var(--ink-3);margin-bottom:4px}
.wsrow{display:flex;gap:8px}
.wsrow input{flex:1;min-width:0}
.wsrow button{flex:0 0 auto;background:var(--accent);color:var(--paper);border:0;border-radius:5px;
padding:0 16px;font-family:inherit;font-size:13.5px;cursor:pointer}
.wsrow button:hover{background:#7a2819}
.wsrow button:disabled{background:var(--rule);cursor:not-allowed}
.wsmeta{font-size:12.5px;color:var(--ink-3);margin:10px 0 0;line-height:1.75}
.wsmeta code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink-2)}
.wsmeta .ok{color:var(--hi)}
.wsmeta .bad{color:var(--accent)}
.wsn{font-size:12.5px;margin:10px 0 0;padding:9px 12px;border-radius:5px;line-height:1.65}
.wsn.warn{background:var(--warn-soft);border:1px solid #e8d5ae;color:var(--warn)}
.wsn.err{background:var(--accent-soft);border:1px solid #e8c9c0;color:var(--accent)}
.wsn[hidden]{display:none}
</style></head><body><div class="wrap">
<p class="kicker">Ask AI · 配置</p>
<h1>划词提问设置</h1>
<p class="lead">切换 AI 线路、填写密钥、微调提示词。保存后立即生效（端口改动需重启）。</p>
<p class="cur" id="cur"></p>

<h2>〇、工作区</h2>
<fieldset>
<legend>Workspace</legend>
<div class="fld">
<span class="k">课程目录 —— <code>lessons/</code> 所在的那一层</span>
<span class="wsrow">
<input type="text" id="wsPath" placeholder="例如 D:/Project/我的课程；也可以直接填 lessons/">
<button type="button" id="wsSave">保存</button>
</span>
<span class="hint">保存后立即生效，不用重启。填 <code>lessons/</code> 或更深的分类目录也可以，会自动上溯到工作区根。
写入的是工具目录下的 <code>ask.config.local.json</code>（已在 .gitignore 中），
不会污染要公开的 <code>ask.config.json</code>。</span>
</div>
<p class="wsmeta" id="wsMeta"></p>
<p class="wsn" id="wsNote" hidden></p>
</fieldset>

<h2>一、AI 线路</h2>
<div class="provs" id="provs"></div>
<p class="hint" id="provHint"></p>

<div id="provFields"></div>

<h2>二、上下文</h2>
<fieldset>
<legend>Context</legend>
<label class="row"><span class="k">课程全文范围</span>
<select id="lessonMode">
<option value="full">整课全文（推荐，约 2~3k token／次）</option>
<option value="section">仅当前章节（更省 token）</option>
</select></label>
<label class="row"><span class="k">「解释这个词」的上下文范围</span>
<select id="defineLessonMode">
<option value="section">仅当前章节（推荐，字少响应更快）</option>
<option value="full">整课全文</option>
</select>
<span class="hint">「解释这个词」是轻量查询，带太多上下文只会拖慢它。</span></label>
<label class="row" style="margin-bottom:0"><span class="k">附带内容</span>
<span style="display:flex;gap:20px;font-size:13.5px;padding-top:2px">
<label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" id="includeMission" style="width:auto">MISSION 目标</label>
<label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" id="includeCatalog" style="width:auto">课程目录</label>
</span></label>
</fieldset>

<h2>三、提示词</h2>
<fieldset>
<legend>Prompts</legend>
<label class="row"><span class="k">「解释这个词」— 就地卡片（简版，≤120 字）</span><textarea id="pDefine" rows="6"></textarea></label>
<label class="row"><span class="k">「深入解释」— 卡片上再点一次时的详细版</span><textarea id="pDefineDeep" rows="8"></textarea></label>
<label class="row" style="margin-bottom:0"><span class="k">「解释这段」— 深入浅出讲清选段</span><textarea id="pExplain" rows="7"></textarea></label>
</fieldset>
<fieldset>
<legend>自由提问的 System Prompt</legend>
<textarea id="pSystem" rows="7"></textarea>
</fieldset>

<div class="bar">
<button class="save" id="save">保存</button>
<span class="msg" id="msg"></span>
</div>
<p class="hint" style="margin-top:0">配置写在工具的 <code>ask.config.json</code>；工作区这类本机信息写 <code>ask.config.local.json</code>（已 gitignore）。API Key 只存在服务端进程里，不会下发到页面；显示为掩码时表示「不修改」。</p>
</div>

<script>
var TOKEN = ${JSON.stringify(TOKEN)};
var PROVIDERS = {};
var LABELS = {};
var DESCS = {};

function el(id) { return document.getElementById(id); }

/* ---- 工作区 ---- */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function wsNote(t, cls) {
  var n = el('wsNote');
  if (!t) { n.hidden = true; return; }
  n.hidden = false;
  n.className = 'wsn' + (cls ? ' ' + cls : '');
  n.textContent = t;
}
function wsRender(d) {
  el('wsPath').value = d.workspace || '';
  var f = [];
  f.push(d.hints.lessons ? '<span class="ok">lessons/ 有</span>' : '<span class="bad">lessons/ 没有</span>');
  f.push(d.hints.mission ? '<span class="ok">MISSION.md 有</span>' : '<span class="bad">MISSION.md 没有</span>');
  f.push(d.hints.lessonCss ? '<span class="ok">assets/lesson.css 有</span>'
    : '<span class="bad">assets/lesson.css 没有（课程页会没样式）</span>');
  el('wsMeta').innerHTML =
    '当前生效：<code>' + escHtml(d.workspace) + '</code><br>' +
    '来源：' + escHtml(d.sourceLabel) + '　·　识别到课程 ' + (d.lessonCount || 0) + ' 条<br>' +
    f.join('　·　');
  if (d.warning) wsNote(d.warning, 'warn');
  else if (d.note) wsNote(d.note);
  else wsNote('');
}
function wsLoad() {
  fetch('/api/workspace', { headers: { 'x-ask-token': TOKEN } })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && !d.error) wsRender(d); })
    .catch(function (e) { wsNote('读取工作区失败：' + e.message, 'err'); });
}
function wsSave() {
  var v = el('wsPath').value.trim();
  if (!v) return wsNote('请先填一个路径', 'err');
  var b = el('wsSave');
  b.disabled = true;
  wsNote('正在切换…');
  fetch('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ask-token': TOKEN },
    body: JSON.stringify({ path: v })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      b.disabled = false;
      if (d.error) return wsNote(d.error, 'err');
      wsRender(d);
      load(); // 课程目录变了，线路信息里的课数等一起刷新
    })
    .catch(function (e) { b.disabled = false; wsNote('保存失败：' + e.message, 'err'); });
}
el('wsSave').addEventListener('click', wsSave);
el('wsPath').addEventListener('keydown', function (e) { if (e.key === 'Enter') wsSave(); });

function load() {
  fetch('/api/config', { headers: { 'x-ask-token': TOKEN } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var c = d.config;
      el('cur').textContent = '当前线路：' + c.provider + '　端口：' + c.port + '（端口需重启生效）';

      Object.keys(c.providers).forEach(function (k) {
        PROVIDERS[k] = c.providers[k];
        LABELS[k] = c.providers[k].label || k;
      });

      var hints = {
        api: '走官方 API，最稳最快。新账号注册送 500 万 token。',
        browser: '用 Playwright 驱动 chat.deepseek.com 网页版，完全免费，但每次要等 5~15 秒。',
        local: '本地模型或任意 OpenAI 兼容服务，离线可用。'
      };
      var box = el('provs');
      box.innerHTML = Object.keys(PROVIDERS).map(function (k) {
        var on = k === c.provider ? ' on' : '';
        return '<label class="prov' + on + '" data-p="' + k + '">' +
          '<input type="radio" name="provider" value="' + k + '"' + (k === c.provider ? ' checked' : '') + '>' +
          '<b>' + LABELS[k] + '</b><span>' + (hints[k] || '') + '</span></label>';
      }).join('');
      box.querySelectorAll('.prov').forEach(function (n) {
        n.addEventListener('click', function () {
          box.querySelectorAll('.prov').forEach(function (m) { m.classList.remove('on'); });
          n.classList.add('on');
          renderFields(n.getAttribute('data-p'));
          el('provHint').textContent = hints[n.getAttribute('data-p')] || '';
        });
      });
      renderFields(c.provider);
      el('provHint').textContent = hints[c.provider] || '';

      el('lessonMode').value = c.context.lessonMode || 'full';
      el('defineLessonMode').value = c.context.defineLessonMode || 'section';
      el('includeMission').checked = c.context.includeMission !== false;
      el('includeCatalog').checked = c.context.includeCatalog !== false;
      el('pDefine').value = c.prompts.define || '';
      el('pDefineDeep').value = c.prompts.defineDeep || '';
      el('pExplain').value = c.prompts.explain || '';
      el('pSystem').value = c.systemPrompt || '';
    })
    .catch(function (e) { el('msg').className = 'msg err'; el('msg').textContent = '读取失败：' + e.message; });
}

function renderFields(name) {
  var p = PROVIDERS[name] || {};
  var rows = [];
  function text(k, label, hint, type) {
    rows.push('<label class="row"><span class="k">' + label + '</span>' +
      '<input type="' + (type || 'text') + '" id="f_' + k + '" value="' +
      String(p[k] === undefined ? '' : p[k]).replace(/"/g, '&quot;') + '">' +
      (hint ? '<span class="hint">' + hint + '</span>' : '') + '</label>');
  }
  if (name === 'api' || name === 'local') {
    text('baseUrl', 'Base URL');
    text('model', '模型名');
    text('apiKey', 'API Key', p.apiKey ? '当前为掩码，留空或保留掩码即不修改。' : '留空则读环境变量 ' + (p.apiKeyEnv || '（未设置）') + '。', 'password');
    text('temperature', 'temperature', '', 'number');
    text('maxTokens', 'maxTokens', '', 'number');
  } else {
    text('url', '网页地址');
    text('userDataDir', '登录态目录', '相对工具目录的路径。');
    text('replyTimeoutMs', '等待上限(ms)', '', 'number');
    rows.push('<label class="row" style="margin-bottom:0"><span class="k">显示浏览器窗口</span>' +
      '<span style="display:flex;align-items:center;gap:6px;font-size:13.5px;padding-top:4px">' +
      '<input type="checkbox" id="f_headless" style="width:auto"' + (p.headless ? ' checked' : '') + '>' +
      '勾选则无头运行（首次登录请取消勾选）</span></label>');
  }
  el('provFields').innerHTML = '<fieldset><legend>' + (LABELS[name] || name) + '</legend>' + rows.join('') + '</fieldset>';
}

el('save').addEventListener('click', function () {
  var provider = (document.querySelector('input[name=provider]:checked') || {}).value;
  var patch = {
    provider: provider,
    context: {
      lessonMode: el('lessonMode').value,
      defineLessonMode: el('defineLessonMode').value,
      includeMission: el('includeMission').checked,
      includeCatalog: el('includeCatalog').checked
    },
    prompts: { define: el('pDefine').value, defineDeep: el('pDefineDeep').value, explain: el('pExplain').value },
    systemPrompt: el('pSystem').value,
    providers: {}
  };
  var p = {};
  ['baseUrl', 'model', 'apiKey', 'temperature', 'maxTokens', 'url', 'userDataDir', 'replyTimeoutMs'].forEach(function (k) {
    var n = el('f_' + k);
    if (!n) return;
    var v = n.value;
    if (k === 'temperature' || k === 'maxTokens' || k === 'replyTimeoutMs') {
      if (v !== '') p[k] = Number(v);
    } else {
      p[k] = v;
    }
  });
  var hl = el('f_headless');
  if (hl) p.headless = hl.checked;
  patch.providers[provider] = p;

  var btn = el('save');
  btn.disabled = true;
  el('msg').className = 'msg';
  el('msg').textContent = '保存中…';
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ask-token': TOKEN },
    body: JSON.stringify(patch)
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) throw new Error(d.error);
      el('msg').className = 'msg ok';
      el('msg').textContent = '已保存，立即生效。当前线路：' + d.provider;
      load();
    })
    .catch(function (e) { el('msg').className = 'msg err'; el('msg').textContent = '保存失败：' + e.message; })
    .finally(function () { btn.disabled = false; });
});

load();
wsLoad();
</script></body></html>`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const p = url.pathname

  if (!hostAllowed(req)) return send(res, 403, 'forbidden host')

  // 供 file:// 场景取 token 与运行状态（只读；Key 永不下发）
  // kind=pdf 时只回文献，否则只回课程 —— 组件用 catalog.length 显示计数，两边不能混
  if (p === '/api/state') {
    const kind = url.searchParams.get('kind') === 'pdf' ? 'pdf' : 'lesson'
    const catalog = (await getCatalog()).filter((c) => (c.kind === 'pdf') === (kind === 'pdf'))
    const providerCfg = cfg.providers?.[cfg.provider] || {}
    return sendJSON(res, 200, {
      token: TOKEN,
      provider: cfg.provider,
      providerLabel: providerCfg.label || cfg.provider,
      model: providerCfg.model || '（网页版）',
      lessonMode: cfg.context?.lessonMode || 'full',
      catalog,
      categories: [...new Set(catalog.map((c) => c.categoryLabel))],
    })
  }

  // 配置读写（免重启热生效；Key 只回掩码）
  if (p === '/api/config') {
    if (!tokenOk(req)) return sendJSON(res, 401, { error: 'unauthorized' })
    if (req.method === 'GET') {
      return sendJSON(res, 200, { config: redactedConfig(), order: Object.keys(cfg.providers || {}) })
    }
    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return sendJSON(res, 400, { error: 'bad json' })
      }
      try {
        return sendJSON(res, 200, { ok: true, ...applyConfigPatch(body) })
      } catch (e) {
        return sendJSON(res, 400, { error: e.message })
      }
    }
    return sendJSON(res, 405, { error: 'method not allowed' })
  }

  if (p === '/config' || p === '/config.html') {
    return send(res, 200, configPage(), { 'Content-Type': 'text/html; charset=utf-8' })
  }

  // 工作区（课程目录）读写 —— 首页「课程目录」入口与设置页共用。
  // 写入目标是 ask.config.local.json（已 gitignore），绝不碰要公开的 ask.config.json。
  if (p === '/api/workspace') {
    if (!tokenOk(req)) return sendJSON(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET') {
      try {
        return sendJSON(res, 200, await workspaceInfo())
      } catch (e) {
        return sendJSON(res, 500, { error: e.message })
      }
    }

    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return sendJSON(res, 400, { error: 'bad json' })
      }
      try {
        const out = await setWorkspace(body.path)
        if (out.error) return sendJSON(res, 400, out)
        console.log(`[ask] 工作区已切换：${ROOT}`)
        return sendJSON(res, 200, { ok: true, ...out })
      } catch (e) {
        return sendJSON(res, 500, { error: e.message })
      }
    }

    return sendJSON(res, 405, { error: 'method not allowed' })
  }

  // 文献来源管理（首页「添加文献」面板用）
  if (p === '/api/pdf-sources') {
    if (!tokenOk(req)) return sendJSON(res, 401, { error: 'unauthorized' })

    const snapshot = async () => {
      const list = await pdfReader.scanPdfs()
      return {
        enabled: pdfReader.enabled(),
        dirs: pdfReader.dirs(),
        files: pdfReader.files(),
        pdfs: list.map((e) => ({ rel: e.rel, title: e.title, from: e.from })),
      }
    }

    if (req.method === 'GET') {
      const data = await snapshot()
      data.candidates = await scanPdfCandidates()
      return sendJSON(res, 200, data)
    }

    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return sendJSON(res, 400, { error: 'bad json' })
      }

      const action = String(body.action || '')
      const target = String(body.path || '').trim()
      const isAdd = action === 'add-dir' || action === 'add-file'
      const isRemove = action === 'remove-dir' || action === 'remove-file'
      if (!isAdd && !isRemove) return sendJSON(res, 400, { error: '未知操作：' + action })
      if (!target) return sendJSON(res, 400, { error: '缺少 path' })

      const isDir = action.slice(-3) === 'dir'
      const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '')
      let nextDirs = pdfReader.dirs().slice()
      let nextFiles = pdfReader.files().slice()

      if (isAdd) {
        const chk = pdfReader.checkSource(isDir ? 'dir' : 'file', target)
        if (!chk.ok) return sendJSON(res, 400, { error: chk.error })
        const list = isDir ? nextDirs : nextFiles
        if (!list.some((x) => norm(x) === norm(target))) list.push(target)
      } else {
        if (isDir) nextDirs = nextDirs.filter((x) => norm(x) !== norm(target))
        else nextFiles = nextFiles.filter((x) => norm(x) !== norm(target))
      }

      try {
        applyConfigPatch({ pdf: { dirs: nextDirs, files: nextFiles } })
      } catch (e) {
        return sendJSON(res, 500, { error: '写入配置失败：' + e.message })
      }
      // 清掉文献索引缓存，让新来源立刻反映到 __DOC_LINKS__ 里
      pdfReader.invalidate()
      // 课程目录缓存也要清：它把 PDF 条目一起缓存了，不清的话 2 秒内
      // 再打开首页会拿到「刚加的文献没出现」的旧快照。
      catalogCache = { at: 0, data: null }

      const data = await snapshot()
      data.ok = true
      data.message = isAdd ? (isDir ? '已绑定目录：' : '已添加：') + target : '已移除：' + target
      return sendJSON(res, 200, data)
    }

    return sendJSON(res, 405, { error: 'method not allowed' })
  }

  // PDF 阅读页。走独立路由 —— 原来 /参考文献/xxx.pdf 仍然返回真实字节流，
  // 任何依赖原路径的地方（lesson 里的链接、外部工具）行为不变。
  if (p === '/pdf') {
    if (!pdfReader.enabled()) {
      return send(res, 404, 'PDF 阅读功能已关闭（ask.config.json → pdf.enabled = false）', {
        'Content-Type': 'text/plain; charset=utf-8',
      })
    }
    let target
    try {
      target = pdfReader.resolvePdf(url.searchParams.get('file'))
    } catch (e) {
      return send(res, e.status || 400, e.message, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    try {
      const html = await pdfReader.viewerPage(target.rel)
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' })
    } catch (e) {
      return send(res, 500, '生成阅读页失败：' + e.message, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
  }

  if (p === '/api/ask') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' })
    if (!tokenOk(req)) return sendJSON(res, 401, { error: 'unauthorized' })

    let body
    try {
      body = await readBody(req)
    } catch {
      return sendJSON(res, 400, { error: 'bad json' })
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const log = (m) => sse({ t: 'log', v: m })

    try {
      await runAsk(
        body,
        {
          delta: (d) => sse({ t: 'delta', v: d }),
          text: (t) => sse({ t: 'text', v: t }),
          status: (s) => sse({ t: 'status', v: s }),
        },
        log
      )
      sse({ t: 'done' })
    } catch (err) {
      sse({ t: 'error', v: err.message, hint: err.hint || null })
    } finally {
      res.end()
    }
    return
  }

  // 把问答追加进 questions/<lesson>-qa.md —— 下次 /teach 时 agent 能读到学生卡在哪
  if (p === '/api/export') {
    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' })
    if (!tokenOk(req)) return sendJSON(res, 401, { error: 'unauthorized' })
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendJSON(res, 400, { error: 'bad json' })
    }
    try {
      const dir = path.join(ROOT, 'questions')
      await fsp.mkdir(dir, { recursive: true })
      const base = path.basename(String(body.lesson || 'unknown')).replace(/\.html$/, '') || 'unknown'
      const abs = path.join(dir, `${base}-qa.md`)
      const isNew = !fs.existsSync(abs)
      const stamp = new Date().toLocaleString('sv-SE').slice(0, 16)
      const block =
        (isNew
          ? `# ${base} · 划词提问记录\n\n` +
            `> 由划词提问组件自动追加。下次 /teach 时请读本文件，了解学生在哪些地方卡住过，\n` +
            `> 把反复出现的困惑点当作 zone of proximal development 的输入。\n`
          : '') +
        `\n## ${stamp}${body.section ? '　「' + body.section + '」' : ''}\n\n` +
        `**划出的原文**\n\n> ${String(body.selection || '').replace(/\n+/g, ' ').trim()}\n\n` +
        `**提问**　${String(body.question || '').trim()}\n\n` +
        `**回答**\n\n${String(body.answer || '').trim()}\n\n` +
        `---\n`
      await fsp.appendFile(abs, block, 'utf8')
      return sendJSON(res, 200, { ok: true, file: path.relative(ROOT, abs) })
    } catch (e) {
      return sendJSON(res, 500, { error: e.message })
    }
  }

  if (p === '/' || p === '/index.html') {
    const catalog = await getCatalog()
    return send(
      res,
      200,
      indexPage(catalog, TOKEN, pdfReader.enabled()),
      { 'Content-Type': 'text/html; charset=utf-8' },
    )
  }

  return serveStatic(req, res, p)
})

/* ------------------------------------------------------------------ */
/* --inject / --list / --login                                         */
/* ------------------------------------------------------------------ */

async function cmdInject() {
  const dir = path.join(ROOT, 'lessons')
  const refDir = path.join(ROOT, 'reference')
  let n = 0
  for (const d of [dir, refDir]) {
    if (!fs.existsSync(d)) continue
    const files = (await fsp.readdir(d)).filter((f) => f.endsWith('.html'))
    for (const f of files) {
      const abs = path.join(d, f)
      let html = await fsp.readFile(abs, 'utf8')
      if (html.includes('ask-ai.js')) continue
      const bootJson = JSON.stringify({ origin: `http://127.0.0.1:${cfg.port}` }).replace(/</g, '\\u003c')
      const snippet =
        `\n<script>window.__ASK__=${bootJson};</script>\n` +
        `<script src="../assets/ask-ai.js"></script>\n`
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, snippet + '</body>') : html + snippet
      await fsp.writeFile(abs, html, 'utf8')
      n++
      console.log(`  已注入 ${path.relative(ROOT, abs)}`)
    }
  }
  console.log(
    `\n完成：写入了 ${n} 个文件。\n` +
      `注意：file:// 直开时组件会向 http://127.0.0.1:${cfg.port}/api/state 取运行参数，\n` +
      `      所以仍需先启动 ask-server.mjs；且 file:// 下列不出完整课程目录（浏览器读不到文件系统）。`
  )
}

async function cmdList() {
  const catalog = await getCatalog()
  const cats = [...new Set(catalog.map((c) => c.category))]
  console.log(`工作区：${ROOT}`)
  console.log(`课程数：${catalog.length}　分类数：${cats.length}`)
  for (const cat of cats) {
    console.log(`\n  【${categoryLabel(cat)}】${cat ? '（lessons/' + cat + '/）' : '（lessons/ 顶层）'}`)
    catalog
      .filter((c) => c.category === cat)
      .forEach((c) => console.log(`    ${c.rel}　${c.heading || c.title}`))
  }
  if (!catalog.length) console.log('\n  （还没有 lesson）')
  console.log('\n可用 provider：')
  for (const [k, v] of Object.entries(cfg.providers || {})) {
    console.log(`  ${k === cfg.provider ? '*' : ' '} ${k.padEnd(8)} ${v.label || ''}`)
  }
  console.log(`\n当前端口：${cfg.port}　当前 provider：${cfg.provider}`)
}

async function cmdLogin() {
  const bcfg = getProviderConfig('browser')
  console.log('正在打开桥接浏览器，请在该窗口里登录 chat.deepseek.com（扫码即可）。')
  console.log('登录完成后可以直接关闭本进程，登录态已保存在 profile 目录里。')
  await ensureBrowserPage(bcfg)
  await new Promise((r) => setTimeout(r, 1000))
  console.log('浏览器已打开。登录完成后按 Ctrl+C 退出。')
  await new Promise(() => {})
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/** 打印组装好的提示词，不发请求。排查「AI 到底收到了什么」时用。 */
async function cmdDryRun() {
  const catalog = await getCatalog()
  const first = opt('lesson') || catalog[0]?.file
  if (!first) {
    console.error('没有找到任何 lesson。')
    process.exit(1)
  }
  const mode = opt('mode') || 'qa'
  const lesson = await getLessonContext(first)
  const body = {
    mode,
    lesson: first,
    section: opt('section') || lesson.sections[0] || '',
    selection:
      opt('selection') ||
      (mode === 'define'
        ? '景深极浅'
        : '三种算法都在做同一件事：为每个像素画一条「轴向响应曲线」，然后找峰值在哪。'),
    paragraph: opt('selection') ? '' : '（示例段落）这是全课最核心的一句话，把三种算法统一成同一个动作。',
    question: opt('question') || (mode === 'qa' ? '这句话里的「轴向响应曲线」具体指什么？' : ''),
  }
  const { messages } = await buildMessages(body)
  const total = messages.reduce((a, m) => a + m.content.length, 0)
  const useMode = mode === 'define' ? cfg.context?.defineLessonMode || 'section' : cfg.context?.lessonMode || 'full'
  console.log('provider      ' + cfg.provider)
  console.log('mode          ' + mode)
  console.log('lesson        ' + first)
  console.log('上下文范围    ' + useMode)
  console.log('段落数        ' + messages.length)
  console.log('总字符数      ' + total + '（约 ' + Math.round(total / 1.6) + ' tokens，中文粗估）')
  console.log('')
  console.log('==================== system ====================')
  console.log(messages[0].content)
  console.log('')
  console.log('==================== user ======================')
  console.log(messages[1].content)
  console.log('')
  console.log('==================== 网页版单段提示词 ============')
  console.log(messagesToSinglePrompt(messages).slice(0, 600) + '\n…（截断）')
}

async function main() {
  if (flag('list')) return cmdList()
  if (flag('inject')) return cmdInject()
  if (flag('login')) return cmdLogin()
  if (flag('dry-run')) return cmdDryRun()

  const ccfg = cfg.context || {}
  const catalog = await getCatalog()

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n端口 ${cfg.port} 被占用。换一个端口重试：node tools/ask-server.mjs --port ${cfg.port + 1}\n`)
      process.exit(1)
    }
    throw err
  })

  server.listen(cfg.port, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${cfg.port}`
    const providerCfg = cfg.providers?.[cfg.provider] || {}
    console.log('')
    console.log('  划词提问服务已启动')
    console.log(`  地址        ${base}`)
    console.log(`  工具目录    ${TOOL_DIR}`)
    console.log(`  工作区      ${ROOT}`)
    console.log(`  课程        ${catalog.length} 课`)
    console.log(`  Provider    ${cfg.provider}　${providerCfg.label || ''}`)
    console.log(`  模型        ${providerCfg.model || '（网页版）'}`)
    console.log(`  上下文      MISSION=${ccfg.includeMission ? 'on' : 'off'} 目录=${ccfg.includeCatalog ? 'on' : 'off'} 全文=${ccfg.lessonMode}`)
    console.log('')
    console.log('  打开任意一课，划词即可提问。Ctrl+C 停止服务。')
    console.log('')

    if (cfg.openBrowser && !flag('no-open')) {
      const url = base + '/'
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
        else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
      } catch {
        /* 打不开就算了，手动访问即可 */
      }
    }
  })

  const shutdown = async () => {
    console.log('\n正在关闭…')
    try {
      if (bctx) await bctx.close()
    } catch {
      /* 忽略 */
    }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('[ask] 启动失败：', e.message)
  process.exit(1)
})
