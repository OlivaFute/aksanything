/*!
 * pdf-reader.mjs — PDF 阅读模块（服务端）
 *
 * 与 HTML lesson 链路完全分离：本模块只负责三件事
 *   1. 扫描工作区里可读的 PDF，产出与 lesson 同构的目录项（供首页分组展示）
 *   2. 校验并解析 /pdf?file=… 的路径参数
 *   3. 生成 viewer 页面（把 pdf-viewer.html 模板里的占位符替换掉）
 *
 * 刻意不做的事：不解析 PDF 内容。全文上下文走工作区已有的 _txt/ 抽取结果，
 * 章节走前端 pdf.getOutline() —— 服务端因此不需要引入任何 PDF 解析依赖。
 *
 * 整个模块由 ask.config.json 的 pdf.enabled 控制，关掉即回到纯 HTML 状态。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 目录项里的分类标识。用一个不可能与真实目录重名的值，避免和 lessons/ 下的分类撞车。 */
export const PDF_CATEGORY = '__pdf__'

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESC[c])

/** 内联进 <script> 的 JSON：把 < 转义掉，防止文件名里的 </script> 提前闭合标签 */
const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c')

/**
 * @param getRoot 返回当前工作区绝对路径的函数。**必须是 getter 而不是路径字符串** ——
 *   工作区可以在运行期被 /api/workspace 热切换，这里若把路径拷成常量，
 *   切完之后相对路径的来源解析还留在旧工作区（表现为「换了工作区但文献没变」）。
 *   函数体的作用与 createPdfReader 相同，只在 `.replace` 处读当前值。
 */
export function createPdfReader({ getRoot, TOOL_DIR, getConfig, getToken }) {
  const rootAbs = () => path.resolve(getRoot())

  const cfg = () => (getConfig() || {}).pdf || {}
  const enabled = () => cfg().enabled !== false
  /** 目录来源。配置里既没 dirs 也没 files 时，回退到默认的「参考文献」。 */
  const dirs = () => {
    const c = cfg()
    if (Array.isArray(c.dirs)) return c.dirs.filter(Boolean).map(String)
    if (Array.isArray(c.files) && c.files.length) return []
    return ['参考文献']
  }
  /** 单篇来源（可以指向工作区之外，用绝对路径） */
  const files = () => (Array.isArray(cfg().files) ? cfg().files.filter(Boolean).map(String) : [])
  /** 统一成 [{ kind, path }] —— 扫描与路径校验共用同一套来源 */
  const sources = () => [
    ...dirs().map((p) => ({ kind: 'dir', path: p })),
    ...files().map((p) => ({ kind: 'file', path: p })),
  ]
  const categoryLabel = () => cfg().categoryLabel || '文献'
  const textDir = () => cfg().textDir || '_txt'

  const isAbs = (p) => path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)
  /** 相对路径按工作区解析，绝对路径原样规范化 —— 两种写法都支持 */
  const absOf = (p) => (isAbs(p) ? path.normalize(p) : path.resolve(path.join(getRoot(), String(p))))
  /** 工作区内的返回相对路径；工作区外的返回归一化绝对路径（一律正斜杠） */
  const relOf = (abs) => {
    const r = path.relative(rootAbs(), abs)
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/')
    return String(abs).split(path.sep).join('/')
  }

  /** 文件必须落在某个已登记的来源里 —— 否则 /pdf 就成了任意文件读取接口 */
  function isAllowed(abs) {
    const target = path.resolve(abs)
    for (const src of sources()) {
      const base = absOf(src.path)
      if (src.kind === 'file') {
        if (path.resolve(base) === target) return true
      } else {
        const rel = path.relative(base, target)
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true
      }
    }
    return false
  }

  /**
   * 扫描所有已登记的来源（目录 + 单篇），产出与 getCatalog() 同构的目录项。
   *
   * 目录来源是**实时**的：往目录里放新的 PDF，下次请求就会出现
   * （上层 catalog 只有 2 秒缓存，所以基本是即时的）。
   */
  async function scanPdfs() {
    if (!enabled()) return []
    const out = []
    const seen = new Set()

    const push = (abs, from) => {
      const rel = relOf(abs)
      if (seen.has(rel)) return // 同一份文件被目录和单篇同时覆盖时只算一次
      seen.add(rel)
      const name = path.basename(abs).replace(/\.pdf$/i, '')
      out.push({
        kind: 'pdf',
        rel,
        url: '/pdf?file=' + encodeURIComponent(rel),
        category: PDF_CATEGORY,
        categoryLabel: categoryLabel(),
        num: '',
        title: name,
        heading: name,
        kicker: '',
        from: from, // 来源标签，UI 上用来区分不同目录
      })
    }

    for (const src of sources()) {
      const base = absOf(src.path)
      if (src.kind === 'dir') {
        let entries = []
        try {
          entries = await fsp.readdir(base, { withFileTypes: true })
        } catch {
          continue // 目录不存在就跳过，不当成错误
        }
        entries
          .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b, 'zh'))
          .forEach((n) => push(path.join(base, n), src.path))
      } else if (fs.existsSync(base) && base.toLowerCase().endsWith('.pdf')) {
        push(base, path.dirname(src.path))
      }
    }
    return out
  }

  /** 校验 /pdf?file=… 的参数，返回 { rel, abs } */
  function resolvePdf(relParam) {
    const fail = (msg, status) => {
      const e = new Error(msg)
      e.status = status
      throw e
    }
    if (!enabled()) fail('PDF 阅读功能已关闭', 404)

    const raw = String(relParam || '').trim()
    if (!raw) fail('缺少 file 参数', 400)
    const norm = raw.replace(/\\/g, '/')
    if (norm.split('/').some((seg) => seg === '..')) fail('路径不合法', 400)
    if (!norm.toLowerCase().endsWith('.pdf')) fail('只接受 .pdf 文件', 400)

    const abs = absOf(norm)
    if (!fs.existsSync(abs)) fail('找不到文件：' + raw, 404)
    // 只在已登记的来源里开放 —— 否则这个接口就成了任意文件读取
    if (!isAllowed(abs)) fail('这个文件不在已添加的文献来源里', 403)

    return { rel: relOf(abs), abs }
  }

  /* ---------------- 全文抽取结果的读取 ---------------- */

  /** rel -> { mtime, text }。608KB 的大部头不必每次重读。 */
  const textCache = new Map()

  /**
   * 读出这份 PDF 对应的抽取文本。
   * 文件名要做**双向前缀匹配** —— 抽取工具会把过长的文件名截断，
   * 例如 "Computational self-corrected quantitative 3D topographic imaging.pdf"
   * 对应的是 "Computational self-corrected quantitativ.txt"。
   */
  async function readPdfText(rel) {
    const pdfAbs = absOf(rel)
    const pdfBase = path.basename(pdfAbs).replace(/\.pdf$/i, '')
    // 抽取结果固定放在「PDF 所在目录 / _txt」下，工作区外也成立
    const dir = path.join(path.dirname(pdfAbs), textDir())

    let files = []
    try {
      files = await fsp.readdir(dir)
    } catch {
      return null // 没有抽取目录，走降级
    }
    const stems = files.filter((f) => f.toLowerCase().endsWith('.txt')).map((f) => f.slice(0, -4))

    let hit = stems.find((t) => t === pdfBase)
    if (!hit) {
      let best = ''
      for (const t of stems) {
        if ((pdfBase.startsWith(t) || t.startsWith(pdfBase)) && t.length > best.length) best = t
      }
      hit = best
    }
    if (!hit) return null

    const abs = path.join(dir, hit + '.txt')
    try {
      const st = await fsp.stat(abs)
      const cached = textCache.get(rel)
      if (cached && cached.mtime === st.mtimeMs) return cached.text
      const text = await fsp.readFile(abs, 'utf8')
      textCache.set(rel, { mtime: st.mtimeMs, text })
      return text
    } catch {
      return null
    }
  }

  /**
   * 从全文里切出某一页。`_txt` 里有 `<<<PAGE N>>>` 分页标记
   * （实测 7 篇全部分页完整、与 PDF 实际页数一一对应），所以按页切片是可靠的。
   * padding=1 可带上前后各一页，防跨页断句。
   */
  function slicePages(text, page, padding = 0) {
    if (!text || !page) return null
    const marks = []
    const re = /<<<PAGE\s+(\d+)>>>/g
    let m
    while ((m = re.exec(text))) marks.push({ page: Number(m[1]), index: m.index })
    if (!marks.length) return null

    const from = page - padding
    const to = page + padding
    let start = -1
    let end = text.length
    for (const mk of marks) {
      if (mk.page === from) start = mk.index
      if (start >= 0 && mk.page === to + 1) {
        end = mk.index
        break
      }
    }
    return start < 0 ? null : text.slice(start, end)
  }

  /**
   * 从抽取文本里粗提章节标题，仅供上下文里"这份文献有哪些部分"的罗列。
   * 服务端不解析 PDF，所以拿不到真正的 outline（那是前端的事）。
   * 编号限制为 1~2 位且首段 ≤ 30，避免把 "2023 年第 43 卷" 这类页眉误当成章节。
   */
  function guessSections(text) {
    const out = []
    const re = /^\s*(\d{1,2}(?:\.\d{1,2}){0,2})[\s\u3000]+([^\n]{2,40})\s*$/gm
    let m
    while ((m = re.exec(text)) && out.length < 20) {
      if (Number(m[1].split('.')[0]) > 30) continue
      const t = m[1] + ' ' + m[2].trim()
      if (!out.includes(t)) out.push(t)
    }
    return out
  }

  /**
   * 产出与 getLessonContext() **同构**的对象 ——
   * 这样 buildMessages 只需要在取正文和标题两处分派，其余拼装逻辑一行都不用动。
   */
  async function getPdfContext(relPath) {
    const { rel } = resolvePdf(relPath)
    const title = path.basename(rel).replace(/\.pdf$/i, '')
    const text = await readPdfText(rel)
    return {
      rel,
      kind: 'pdf',
      category: PDF_CATEGORY,
      categoryLabel: categoryLabel(),
      title,
      heading: title,
      sections: text ? guessSections(text) : [],
      html: null,
      text: text || '',
      hasText: !!text,
    }
  }

  /* ---------------- 文献索引（供 lesson 正文自动加跳转链接） ---------------- */

  let docIndexCache = null

  /** 归一化：去掉空白与各种标点，让「表面微/纳米计量」和「表面微_纳米计量」能对上 */
  const normKey = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s_\-–—·、,，.。:：;；'"“”‘’()（）\[\]【】\/]/g, '')

  /**
   * 建「文献编号 → PDF」索引。
   *
   * 编号的权威来源是参考文献目录里的 `简介.md`：它的 `## N. 标题` 顺序
   * 与 lesson 正文里 `[书1]` / `[综述2]` / `文献 4` 这类引用是同一套编号
   * （实测 7 篇一一对应）。所以这张表可以自动推导，不需要手工配置。
   *
   * 匹配标题时用归一化 + 双向包含 —— 抽取工具/文件名/正文三处的写法并不一致：
   *   简介.md「基于白光干涉术和变焦法…」 ↔ 文件名「…_袁琳.pdf」
   *   简介.md「Three-dimensional Imaging…」 ↔ 文件名「Three-dimensional imaging…」（大小写）
   *   简介.md「基于结构光照明的…」 ↔ 文件名「(2019)基于结构光照明的…_柴常春」（前后缀差异）
   */
  /**
   * 从抽取文本里解析「章节号 → 起始页」。
   *
   * 依据：外文书的章起始页行首形如 `9   Coherence Scanning Interferometry`
   * —— 编号 + 多个空格 + 标题（标题首字母大写）；而目录里的同类行尾部带页码，
   * 用「标题不以数字结尾」把它排除掉。
   *
   * 实测 Optical Measurement（333 页）解析出 11 章，并与全文检索交叉验证一致：
   *   Ch.5→p83  Ch.7→p142  Ch.8→p178  Ch.9→p198
   *
   * 中文论文的章标题以中文起头，这里匹配不到 → 返回空表，
   * 前端会退回用书签标题里自带的编号去匹配。
   */
  function parseChapters(text) {
    const out = {}
    if (!text) return out

    const marks = []
    const reMark = /<<<PAGE\s+(\d+)>>>/g
    let m
    while ((m = reMark.exec(text))) marks.push({ page: Number(m[1]), index: m.index })
    if (!marks.length) return out

    const pageOf = (pos) => {
      let p = 1
      for (const mk of marks) {
        if (mk.index <= pos) p = mk.page
        else break
      }
      return p
    }

    const re = /^[ \t]*(\d{1,2})[ \t]{2,}([A-Z][^\n]{3,70}?)[ \t]*$/gm
    while ((m = re.exec(text))) {
      const ch = String(Number(m[1]))
      if (!out[ch]) out[ch] = pageOf(m.index) // 只记第一次出现 = 章起始页
    }
    return out
  }

  async function buildDocIndex() {
    if (docIndexCache) return docIndexCache
    const pdfs = await scanPdfs()
    if (!pdfs.length) return (docIndexCache = [])

    const introName = cfg().introFile || '简介.md'
    let introText = ''
    for (const dir of dirs()) {
      try {
        introText = await fsp.readFile(path.join(getRoot(), dir, introName), 'utf8')
        break
      } catch {
        /* 这个目录没有，换下一个 */
      }
    }

    const numbered = []
    const re = /^##\s+(\d+)\s*[.、]\s*(.+)$/gm
    let m
    while ((m = re.exec(introText))) {
      // 去掉标题末尾的补充说明，如「（Springer, 2011）」「（计测技术, 2023）」
      const title = m[2].replace(/[（(][^）)]*[）)]\s*$/, '').trim()
      if (title) numbered.push({ n: Number(m[1]), title })
    }
    if (!numbered.length) return (docIndexCache = [])

    const stem = (rel) => path.basename(rel).replace(/\.pdf$/i, '')
    const out = []
    const used = new Set()
    for (const item of numbered) {
      const key = normKey(item.title)
      if (key.length < 4) continue
      let hit =
        pdfs.find((p) => normKey(stem(p.rel)) === key) ||
        pdfs.find((p) => !used.has(p.rel) && normKey(stem(p.rel)).includes(key)) ||
        pdfs.find((p) => !used.has(p.rel) && key.includes(normKey(stem(p.rel))))
      if (!hit) continue
      used.add(hit.rel)
      out.push({
        n: item.n,
        rel: hit.rel,
        url: hit.url,
        title: stem(hit.rel), // 文件名（正文里常按这个写）
        label: item.title, // 简介.md 里的正式标题
        // 章节号 → 起始页。有了它，正文里的 `[书1] Ch.9` 能直接跳到第 198 页
        chapters: parseChapters(await readPdfText(hit.rel)),
      })
    }

    docIndexCache = out
    return out
  }

  /** 生成 viewer 页面 */
  async function viewerPage(rel) {
    const tplPath = path.join(TOOL_DIR, 'assets', 'pdf-viewer.html')
    const tpl = await fsp.readFile(tplPath, 'utf8')
    const title = path.basename(rel).replace(/\.pdf$/i, '')

    const doc = safeJson({
      docId: rel,
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      title,
    })
    const ask = safeJson({
      token: getToken(),
      lesson: rel,
      docKind: 'pdf',
      endpoint: '/api/ask',
      exportUrl: '/api/export',
      origin: '',
      title,
    })

    // 注意 TITLE 在模板里出现两次（<title> 与工具栏），必须用全局替换；
    // 用函数形式回填，避免标题里的 $& 之类被当成替换模式。
    return tpl
      .replace(/\{\{TITLE\}\}/g, () => escapeHtml(title))
      .replace('{{DOC_JSON}}', () => doc)
      .replace('{{ASK_JSON}}', () => ask)
  }

  /** 来源列表变更后清掉索引缓存 —— 否则新加的文献不会出现在 __DOC_LINKS__ 里 */
  function invalidate() {
    docIndexCache = null
  }

  /** 添加来源前的校验：路径要真实存在、类型要匹配、单篇必须是 .pdf */
  function checkSource(kind, p) {
    const raw = String(p || '').trim()
    if (!raw) return { ok: false, error: '路径不能为空' }
    if (raw.replace(/\\/g, '/').split('/').some((seg) => seg === '..')) {
      return { ok: false, error: '路径里不能有 ..' }
    }
    const abs = absOf(raw)
    if (!fs.existsSync(abs)) return { ok: false, error: '路径不存在：' + raw }

    let st
    try {
      st = fs.statSync(abs)
    } catch (e) {
      return { ok: false, error: '无法读取：' + raw }
    }
    if (kind === 'dir') {
      if (!st.isDirectory()) return { ok: false, error: '这不是目录：' + raw }
      return { ok: true, abs }
    }
    if (!st.isFile()) return { ok: false, error: '这不是文件：' + raw }
    if (!abs.toLowerCase().endsWith('.pdf')) return { ok: false, error: '只支持 .pdf 文件' }
    return { ok: true, abs }
  }

  return {
    enabled,
    scanPdfs,
    resolvePdf,
    viewerPage,
    getPdfContext,
    buildDocIndex,
    readPdfText,
    slicePages,
    invalidate,
    checkSource,
    sources,
    dirs,
    files,
    categoryLabel,
    textDir,
    PDF_CATEGORY,
  }
}
