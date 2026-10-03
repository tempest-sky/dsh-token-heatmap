/**
 * 会话日志聚合：把 DSH 的会话事件日志折叠成「按天 token 用量」。
 *
 * 纯函数 + 显式 IO 依赖，便于离线单测（见 test/aggregate.test.mjs）。
 *
 * 三个必须踩准的细节：
 *  1. 日志是**多帧 zstd 拼接**（实测单文件 1108 帧）。整文件一次性解压只会
 *     拿到第一帧 → 必须按 magic 逐帧解压再拼接。
 *  2. 同一 (turn, step) 会同时出现流式 chunk 与最终 assistant/message 的 usage，
 *     按 (turn, step) last-wins 折叠，与宿主 token-meter 语义一致。
 *  3. **扫描绝不能长时间占住事件循环**。宿主半边与桌面 UI 共用同一个 Node
 *     事件循环，实测一次同步全量扫描要 0.8~1s（解压 419ms + JSON 解析 296ms），
 *     期间事件循环一个 tick 都跑不动，浏览器侧的请求全部排队 → 桌面端卡死。
 *     因此对外主入口是 `aggregateFromDiskAsync`：分片解压 / 分片解析，
 *     每片之间 `setImmediate` 让出事件循环；再叠加「按文件 mtime+size 的
 *     增量缓存」，未变动的日志第二次扫描直接复用结果。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompress, zstdDecompressSync } from 'node:zlib'

/** zstd 帧 magic：0x28 0xB5 0x2F 0xFD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 只认已提交的正式产物，排除备份/临时/别名文件。 */
const LOG_NAME = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * 协作式让出事件循环：把一次长扫描切成小片，让 UI 的 HTTP 请求能插队执行。
 * 用 setImmediate（而不是 setTimeout 0）——它在 poll 阶段之后立刻执行，
 * 既能让 I/O 回调先跑，又不会引入计时器抖动。
 */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

/**
 * 分片阈值按**字节**而不是「行数」计：一行 JSON 可能很大（工具结果、长正文），
 * 按行让出对超大行的分布不成立；按字节让出才稳定。
 */
const YIELD_BYTES = 512 * 1024

/**
 * 按 zstd magic 逐帧解压并拼接。
 * 非 .zstd 输入直接按 utf8 返回。
 */
export function decompressSessionLog(buffer, name = '') {
  if (!name.endsWith('.zstd')) return buffer.toString('utf8')
  const parts = []
  let pos = 0
  while (pos < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, pos)
    if (start < 0) break
    const next = buffer.indexOf(ZSTD_MAGIC, start + 4)
    const frame = buffer.subarray(start, next < 0 ? buffer.length : next)
    try {
      parts.push(zstdDecompressSync(frame).toString('utf8'))
    } catch {
      // 单帧损坏不拖垮整份日志：跳过，剩余帧照常解析。
    }
    if (next < 0) break
    pos = next
  }
  return parts.join('')
}

/**
 * 同上，但走**异步** zstd：解压被派到 libuv 线程池，主事件循环完全不参与。
 *
 * 这一点是必需的：zstdDecompressSync 对单帧是原子的，实测有一份日志
 * 「4 帧 / 9.1MB」，单帧就独占 39~60ms 主线程 CPU —— 仅靠帧间让出无法
 * 消除这段卡顿。异步解压把它移出主线程，主循环全程可响应。
 */
export async function decompressSessionLogAsync(buffer, name = '') {
  if (!name.endsWith('.zstd')) return buffer.toString('utf8')
  const parts = []
  let pos = 0
  while (pos < buffer.length) {
    const start = buffer.indexOf(ZSTD_MAGIC, pos)
    if (start < 0) break
    const next = buffer.indexOf(ZSTD_MAGIC, start + 4)
    const frame = buffer.subarray(start, next < 0 ? buffer.length : next)
    try {
      const out = await new Promise((resolve, reject) => {
        zstdDecompress(frame, (err, buf) => (err ? reject(err) : resolve(buf)))
      })
      parts.push(out.toString('utf8'))
    } catch {
      // 单帧损坏不拖垮整份日志：跳过，剩余帧照常解析。
    }
    if (next < 0) break
    pos = next
  }
  return parts.join('')
}

/** 本地时区的 YYYY-MM-DD（用户看到的是「我哪天用了多少」）。 */
export function localDayKey(epochMs) {
  const d = new Date(epochMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function emptyBuckets() {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, models: {} }
}

/**
 * 解析单行日志 → 用量样本；不是用量行则返回 null。
 * 同步/异步两个抽取器共用，保证两条路径语义完全一致。
 */
function parseUsageLine(line) {
  if (!line || line.charCodeAt(0) !== 0x7b /* { */) return null
  if (!line.includes('"usage"')) return null
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    return null
  }
  const usage = rec?.data?.usage
  const time = rec?.time
  if (!usage || typeof time !== 'number') return null

  const input = isNum(usage.inputTokens) ? usage.inputTokens : 0
  const output = isNum(usage.outputTokens) ? usage.outputTokens : 0
  const cacheRead = isNum(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
  const cacheWrite = isNum(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  // totalTokens 可能缺省或与分桶不一致；以分桶之和为准，避免重复计数。
  const total = input + output + cacheRead + cacheWrite
  if (total === 0) return null

  const src = rec?.data?.message?.source
  const provider = typeof src?.provider === 'string' ? src.provider : ''
  const model = typeof src?.model === 'string' ? src.model : ''

  // 流式与最终消息共享 (turn, step)：last-wins 去重。
  const turn = rec?.data?.turn
  const step = rec?.data?.step
  const key =
    typeof turn === 'number' && typeof step === 'number'
      ? `t${turn}s${step}`
      : `seq${rec?.seq ?? `${time}:${input}:${output}:${cacheRead}:${cacheWrite}`}`

  return { time, provider, model, input, output, cacheRead, cacheWrite, total, key }
}

/**
 * 从一份会话日志文本里抽取用量样本。
 * 返回 [{ time, provider, model, input, output, cacheRead, cacheWrite, total, key }]
 */
export function extractUsageSamples(text) {
  const byKey = new Map()
  for (const line of text.split('\n')) {
    const s = parseUsageLine(line)
    if (s) byKey.set(s.key, s)
  }
  return [...byKey.values()]
}

/**
 * 同上，但用 indexOf 逐行走（不一次性分配整份行数组），
 * 每处理约 YIELD_BYTES 字符让出一次事件循环。
 */
export async function extractUsageSamplesAsync(text) {
  const byKey = new Map()
  const len = text.length
  let start = 0
  let budget = 0
  while (start < len) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = len
    const s = parseUsageLine(text.slice(start, end))
    if (s) byKey.set(s.key, s)
    budget += end - start + 1
    start = end + 1
    if (budget >= YIELD_BYTES) {
      budget = 0
      await yieldToLoop()
    }
  }
  return [...byKey.values()]
}

/** 把一组样本折叠进 days 表。 */
export function foldSamples(samples, days = new Map()) {
  for (const s of samples) {
    const day = localDayKey(s.time)
    let bucket = days.get(day)
    if (!bucket) {
      bucket = emptyBuckets()
      days.set(day, bucket)
    }
    bucket.tokens += s.total
    bucket.input += s.input
    bucket.output += s.output
    bucket.cacheRead += s.cacheRead
    bucket.cacheWrite += s.cacheWrite
    bucket.calls += 1
    if (s.provider || s.model) {
      const k = s.provider ? `${s.provider}:${s.model}` : s.model
      bucket.models[k] = (bucket.models[k] ?? 0) + s.total
    }
  }
  return days
}

/** 把 source 的逐日桶并入 target（增量缓存命中时用，避免重复扫描）。 */
export function mergeDays(target, source) {
  for (const [day, b] of source) {
    let t = target.get(day)
    if (!t) {
      t = emptyBuckets()
      target.set(day, t)
    }
    t.tokens += b.tokens
    t.input += b.input
    t.output += b.output
    t.cacheRead += b.cacheRead
    t.cacheWrite += b.cacheWrite
    t.calls += b.calls
    for (const k of Object.keys(b.models)) {
      t.models[k] = (t.models[k] ?? 0) + b.models[k]
    }
  }
  return target
}

/**
 * 扫描 sessions 根目录，收集所有会话日志路径。
 * 目录形如 <root>/<project-slug>/<session-id>/session.vN.jsonl[.zstd]
 */
export function listSessionLogs(root) {
  const out = []
  const entries = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const project of entries(root)) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of entries(projectPath)) {
      if (!session.isDirectory()) continue
      const dir = join(projectPath, session.name)
      const candidates = entries(dir)
        .filter((e) => e.isFile() && LOG_NAME.test(e.name))
        .map((e) => {
          const m = LOG_NAME.exec(e.name)
          return { name: e.name, version: Number(m?.[1] ?? 0), compressed: Boolean(m?.[2]) }
        })
        // 同一会话保留最新一代（v10 > v3），压缩与非压缩并存时优先压缩产物。
        .sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
      if (candidates.length) {
        const chosen = candidates[0]
        out.push({ path: join(dir, chosen.name), sessionId: session.name, project: project.name })
      }
    }
  }
  return out
}

/** 连续使用天数（current = 截止今天/昨天仍在延续；longest = 历史最长）。 */
export function computeStreaks(dayKeys, todayKey) {
  const sorted = [...dayKeys].sort()
  if (sorted.length === 0) return { current: 0, longest: 0 }

  const dayMs = 86_400_000
  const toMs = (k) => {
    const [y, m, d] = k.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }

  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (toMs(sorted[i]) - toMs(sorted[i - 1]) === dayMs) run += 1
    else run = 1
    if (run > longest) longest = run
  }

  // current：从最后一天往前数；若最后一天早于「昨天」则已断。
  const last = sorted[sorted.length - 1]
  const gap = Math.round((toMs(todayKey) - toMs(last)) / dayMs)
  let current = 0
  if (gap <= 1) {
    current = 1
    for (let i = sorted.length - 1; i > 0; i--) {
      if (toMs(sorted[i]) - toMs(sorted[i - 1]) === dayMs) current += 1
      else break
    }
  }
  return { current, longest }
}

/**
 * 汇总成给客户端 / HTTP 的最终结构。
 * @param {Map<string, object>} days
 * @param {{ sessions?: number, unreadable?: number, partial?: boolean, reused?: number }} scan
 */
export function summarize(days, scan = {}, now = Date.now()) {
  const dayKeys = [...days.keys()].sort()
  const out = {}
  let tokens = 0
  let calls = 0
  let peakDate = null
  let peakTokens = -1

  for (const key of dayKeys) {
    const b = days.get(key)
    out[key] = {
      tokens: b.tokens,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      calls: b.calls,
      models: b.models,
    }
    tokens += b.tokens
    calls += b.calls
    if (b.tokens > peakTokens) {
      peakTokens = b.tokens
      peakDate = key
    }
  }

  return {
    generatedAt: now,
    range: { from: dayKeys[0] ?? null, to: dayKeys[dayKeys.length - 1] ?? null },
    days: out,
    totals: { tokens, calls, activeDays: dayKeys.length },
    streaks: computeStreaks(dayKeys, localDayKey(now)),
    peak: peakDate ? { date: peakDate, tokens: peakTokens } : null,
    scan: {
      sessions: scan.sessions ?? 0,
      unreadable: scan.unreadable ?? 0,
      reused: scan.reused ?? 0,
      partial: scan.partial === true,
      lastScanAt: now,
    },
  }
}

/**
 * 全量扫描并聚合（**同步**，会占住事件循环）。
 * 仅用于离线测试与工具脚本；宿主半边请用 `aggregateFromDiskAsync`。
 * @param {string} root sessions 根目录
 * @param {{ readFile?: (p:string)=>Buffer, now?: number }} [deps]
 */
export function aggregateFromDisk(root, deps = {}) {
  const read = deps.readFile ?? ((p) => readFileSync(p))
  const now = deps.now ?? Date.now()
  const logs = listSessionLogs(root)
  const days = new Map()
  let unreadable = 0

  for (const log of logs) {
    try {
      const buf = read(log.path)
      const text = decompressSessionLog(buf, log.path)
      foldSamples(extractUsageSamples(text), days)
    } catch {
      unreadable += 1
    }
  }

  return summarize(days, { sessions: logs.length, unreadable, partial: false }, now)
}

/**
 * 非阻塞 + 增量的扫描聚合（宿主半边主入口）。
 *
 * - 分片让出：解压与解析都在小片之间 `await yieldToLoop()`，事件循环始终可响应。
 * - 增量缓存：`deps.cache` 传入一个长期存活的 Map，按 `path + size + mtimeMs`
 *   命中即直接复用该文件上一次的逐日结果，未改动的历史日志不再重复解压。
 *
 * @param {string} root sessions 根目录
 * @param {{
 *   readFile?: (p:string)=>Buffer,
 *   statFile?: (p:string)=>{size:number,mtimeMs:number},
 *   cache?: Map<string,{size:number,mtimeMs:number,days:Map<string,object>}>,
 *   now?: number,
 * }} [deps]
 * @returns {Promise<object>} summarize() 的结构
 */
export async function aggregateFromDiskAsync(root, deps = {}) {
  const read = deps.readFile ?? ((p) => readFileSync(p))
  const statFile = deps.statFile ?? ((p) => statSync(p))
  const cache = deps.cache instanceof Map ? deps.cache : null
  const now = deps.now ?? Date.now()
  const logs = listSessionLogs(root)
  const days = new Map()
  let unreadable = 0
  let reused = 0

  for (const log of logs) {
    try {
      const st = statFile(log.path)
      const hit = cache ? cache.get(log.path) : null
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        mergeDays(days, hit.days)
        reused += 1
        continue
      }
      const buf = read(log.path)
      const text = await decompressSessionLogAsync(buf, log.path)
      const per = foldSamples(await extractUsageSamplesAsync(text))
      if (cache) cache.set(log.path, { size: st.size, mtimeMs: st.mtimeMs, days: per })
      mergeDays(days, per)
      // 单文件之间也留一次让出，避免最大的那份日志连续占用事件循环。
      await yieldToLoop()
    } catch {
      unreadable += 1
    }
  }

  // 清掉已删除 / 已被新版本取代的日志缓存，防止 Map 无界增长。
  if (cache) {
    const alive = new Set(logs.map((l) => l.path))
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key)
  }

  return summarize(days, { sessions: logs.length, unreadable, reused, partial: false }, now)
}
