// dsh-token-heatmap: client (browser) half.
//
// 提供两处 UI：
//   1. 设置页完整面板  —— settings.section（list，按 id 分派）
//   2. 侧边栏底部迷你条 —— sidebar.footer.action（list，owner 下发 { wide }）
//
// 严格遵循 0.2.0-rc.2 的客户端契约：
//   - 外层必须是 window.__ModuleLoader__.load({ id, factory })，
//     且 **id 必须等于包名**（浏览器会按包名校验注册）。
//   - factory 收到的 require 只能解析「平台种子」与已声明依赖。
//     react / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives
//     / @deepseek-ai/dsh-client-ui-slots 属平台种子，无需声明。
//   - factory 必须返回带 apply / inject 的 exports 对象。
//
// 只用平台种子里的 react 与 ui-primitives，因此 package.json 的
// dsh.client.inject 仅需列 locale（用于中英文案）。

window.__ModuleLoader__.load({
  id: 'dsh-token-heatmap',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Tooltip = primitives && primitives.Tooltip

    const NS = 'dsh-token-heatmap'
    const API = '/api/token-heatmap'
    const REFRESH_MS = 60_000

    // ── 文案 ────────────────────────────────────────────────────────────
    const TEXT = {
      zh: {
        sectionLabel: 'Token 热力图',
        panelLabel: 'Token 热力图',
        title: 'Token 用量热力图',
        subtitle: '数据来自本地会话日志，仅统计 token 数量',
        total: '累计 Tokens',
        activeDays: '活跃天数',
        currentStreak: '当前连续',
        longestStreak: '最长连续',
        peakDay: '峰值日',
        calls: '调用次数',
        unitDays: '天',
        less: '少',
        more: '多',
        today: '今日',
        loading: '正在统计…',
        noData: '暂无用量数据',
        noDataHint: '开始使用后，热力图会随会话累积。',
        error: '读取失败',
        retry: '重试',
        viewTokens: 'Tokens',
        viewCalls: '调用次数',
        partial: '数据可能不完整',
        sessions: '会话',
        unreadable: '个日志不可读',
        modelBreakdown: '模型用量',
        other: '其他',
        grainDay: '日',
        grainWeek: '周',
        grainMonth: '月',
        weekOf: '当周',
        chartPeak: '峰值',
        openPanel: '打开完整热力图',
        closePanel: '关闭',
      },
      en: {
        sectionLabel: 'Token Heatmap',
        panelLabel: 'Token Heatmap',
        title: 'Token Usage Heatmap',
        subtitle: 'Computed from local session logs; token counts only',
        total: 'Total Tokens',
        activeDays: 'Active Days',
        currentStreak: 'Current Streak',
        longestStreak: 'Longest Streak',
        peakDay: 'Peak Day',
        calls: 'Calls',
        unitDays: 'd',
        less: 'Less',
        more: 'More',
        today: 'Today',
        loading: 'Scanning…',
        noData: 'No usage data yet',
        noDataHint: 'The heatmap fills in as you work.',
        error: 'Failed to load',
        retry: 'Retry',
        viewTokens: 'Tokens',
        viewCalls: 'Calls',
        partial: 'Data may be incomplete',
        sessions: 'sessions',
        unreadable: 'unreadable logs',
        modelBreakdown: 'By model',
        other: 'Other',
        grainDay: 'Day',
        grainWeek: 'Week',
        grainMonth: 'Month',
        weekOf: 'week of',
        chartPeak: 'Peak',
        openPanel: 'Open full heatmap',
        closePanel: 'Close',
      },
    }

    // ── 数值格式化 ──────────────────────────────────────────────────────
    function formatCompact(n) {
      const v = Number(n) || 0
      if (v < 1000) return String(v)
      if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'K'
      if (v < 1_000_000_000) return (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0) + 'M'
      return (v / 1_000_000_000).toFixed(2) + 'B'
    }

    function formatFull(n) {
      return (Number(n) || 0).toLocaleString()
    }

    // ── 数据获取（带简单内存缓存 + 订阅） ───────────────────────────────
    const store = {
      snapshot: null,
      error: null,
      loading: false,
      listeners: new Set(),
      inflight: null,
      lastFetch: 0,
      emit() {
        for (const fn of this.listeners) {
          try {
            fn()
          } catch {
            /* 单个订阅者出错不影响其余 */
          }
        }
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
      async fetch(force) {
        const now = Date.now()
        if (!force && this.snapshot !== null && now - this.lastFetch < REFRESH_MS) return
        if (this.inflight) return this.inflight
        this.loading = true
        this.emit()
        this.inflight = (async () => {
          try {
            const res = await fetch(API, { credentials: 'same-origin' })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            this.snapshot = await res.json()
            this.error = null
            this.lastFetch = Date.now()
          } catch (e) {
            this.error = e && e.message ? e.message : String(e)
          } finally {
            this.loading = false
            this.inflight = null
            this.emit()
          }
        })()
        return this.inflight
      },
    }

    function useSnapshot() {
      const [, bump] = React.useState(0)
      React.useEffect(() => store.subscribe(() => bump((v) => v + 1)), [])
      React.useEffect(() => {
        store.fetch(false)
        // 非强制轮询：热力图只是仪表盘，不值得每分钟逼宿主重扫一遍日志。
        // 窗口不可见时直接跳过，避免后台空转把桌面端拖慢。
        const t = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          store.fetch(false)
        }, REFRESH_MS)
        return () => clearInterval(t)
      }, [])
      return { snapshot: store.snapshot, error: store.error, loading: store.loading }
    }

    // ── 色阶 ────────────────────────────────────────────────────────────
    // 用宿主设计令牌取背景，绿色沿用 GitHub 贡献图语义（深浅主题各一套）。
    function isDark() {
      try {
        const attr = document.documentElement.dataset.theme
        if (attr === 'dark') return true
        if (attr === 'light') return false
        return window.matchMedia('(prefers-color-scheme: dark)').matches
      } catch {
        return true
      }
    }

    const GREEN_DARK = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']
    const GREEN_LIGHT = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']

    function colorFor(level, dark) {
      const palette = dark ? GREEN_DARK : GREEN_LIGHT
      return palette[Math.max(0, Math.min(4, level))]
    }

    /**
     * 把每天的用量映射到 0..4 档。
     * 用「非零日的分位数」而不是最大值线性切分：真实用量长尾极重，
     * 线性切分会让绝大多数日子挤在第 1 档、看不出差别。
     */
    function buildLevels(dayMap, metric) {
      const values = []
      for (const k of Object.keys(dayMap)) {
        const v = metric === 'calls' ? dayMap[k].calls : dayMap[k].tokens
        if (v > 0) values.push(v)
      }
      values.sort((a, b) => a - b)
      const at = (q) => (values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(q * values.length))])
      const q1 = at(0.25)
      const q2 = at(0.5)
      const q3 = at(0.75)
      return function levelOf(v) {
        if (!v || v <= 0) return 0
        if (v <= q1) return 1
        if (v <= q2) return 2
        if (v <= q3) return 3
        return 4
      }
    }

    function dayKeyOf(date) {
      const y = date.getFullYear()
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }

    /**
     * 把「按天」表折叠成周或月档位，供粒度高阶视图使用。
     *
     * 周桶 key 用该周周日（与 buildGrid 的列对齐语义一致）；月桶 key 用 `YYYY-MM`。
     * 返回 { buckets: Map<key, {tokens, calls, models, days}>, keys: string[] }，
     * keys 按时间升序，且**补齐空档** —— 没有用量的周/月也要占位，
     * 否则热力图会「跳过」安静期，视觉上把长尾压缩掉。
     *
     * @param {number} minBuckets 轴的最小桶数。设成 26（半年）/ 12（一年）可保证
     *   即使只有几天数据，周/月视图也有一条像样的时间轴，而不是孤零零一格。
     *   注意这与「补空档」是两件事：空档是数据内部的洞，最小跨度是数据两端的留白。
     */
    function bucketize(dayMap, grain, minBuckets = 1) {
      const buckets = new Map()
      const dayKeys = Object.keys(dayMap).sort()

      const keyOf = (dayKey) => {
        if (grain === 'month') return dayKey.slice(0, 7) // YYYY-MM
        const [y, m, d] = dayKey.split('-').map(Number)
        const dt = new Date(y, m - 1, d)
        dt.setDate(dt.getDate() - dt.getDay()) // 回退到本周周日
        return dayKeyOf(dt)
      }

      // 无数据时直接返回空结构，调用方走「无数据」分支。
      if (dayKeys.length === 0) return { buckets, keys: [] }

      // 步进：周 +7 天；月 +1 月。用真实日期推进，避免月末错位。
      const step = (k) => {
        if (grain === 'month') {
          const [y, m] = k.split('-').map(Number)
          const dt = new Date(y, m - 1 + 1, 1)
          return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
        }
        const [y, m, d] = k.split('-').map(Number)
        const dt = new Date(y, m - 1, d)
        dt.setDate(dt.getDate() + 7)
        return dayKeyOf(dt)
      }

      const stepBack = (k) => {
        if (grain === 'month') {
          const [y, m] = k.split('-').map(Number)
          const dt = new Date(y, m - 1 - 1, 1)
          return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
        }
        const [y, m, d] = k.split('-').map(Number)
        const dt = new Date(y, m - 1, d)
        dt.setDate(dt.getDate() - 7)
        return dayKeyOf(dt)
      }

      // 以「今天」为右端补齐连续区间，让安静期也显示为空格。
      // 若数据里出现晚于今天的桶（时钟回拨 / 未来时间戳），右端取两者较大值，
      // 保证任何已有数据都不会被丢出轴外。
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const todayBucket = keyOf(dayKeyOf(today))
      const firstDataBucket = keyOf(dayKeys[0])
      const lastDataBucket = keyOf(dayKeys[dayKeys.length - 1])
      const stop = lastDataBucket > todayBucket ? lastDataBucket : todayBucket

      // 最小跨度：从 stop 往回退 minBuckets-1 步，作为「至少要有这么早」的起点；
      // 若真实数据更早，则以真实数据为准（不裁掉历史）。
      let minStart = stop
      for (let i = 0; i < minBuckets - 1; i++) minStart = stepBack(minStart)
      let cursor = firstDataBucket < minStart ? firstDataBucket : minStart

      const keys = []
      // 上限保护：异常数据不应造成死循环。
      for (let guard = 0; guard < 2000 && cursor <= stop; guard++) {
        keys.push(cursor)
        cursor = step(cursor)
      }
      // 若最后一天落在 stop 之后（例如今天所在周），补上 stop。
      if (keys[keys.length - 1] !== stop && stop >= keys[0]) keys.push(stop)

      for (const k of keys) buckets.set(k, { tokens: 0, calls: 0, days: 0, models: {} })
      for (const dk of dayKeys) {
        const b = buckets.get(keyOf(dk))
        if (!b) continue
        const day = dayMap[dk]
        b.tokens += day.tokens || 0
        b.calls += day.calls || 0
        b.days += 1
        for (const [k, v] of Object.entries(day.models || {})) b.models[k] = (b.models[k] || 0) + v
      }
      return { buckets, keys }
    }

    /**
     * 生成 GitHub 风格的周列结构。
     * 返回 weeks[weekIndex][weekday]，weekday 0=周日 … 6=周六。
     */
    function buildGrid(dayMap, weeks) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      // 结束于本周周六，保证最后一列完整
      const end = new Date(today)
      end.setDate(end.getDate() + (6 - end.getDay()))
      const start = new Date(end)
      start.setDate(start.getDate() - (weeks * 7 - 1))

      const cols = []
      const cursor = new Date(start)
      for (let w = 0; w < weeks; w++) {
        const col = []
        for (let d = 0; d < 7; d++) {
          const key = dayKeyOf(cursor)
          col.push({
            key,
            date: new Date(cursor),
            future: cursor.getTime() > today.getTime(),
            data: dayMap[key] || null,
          })
          cursor.setDate(cursor.getDate() + 1)
        }
        cols.push(col)
      }
      return cols
    }

    // ── 通用小组件 ──────────────────────────────────────────────────────
    function Metric({ label, value, hint }) {
      return React.createElement(
        'div',
        { className: 'th-metric' },
        React.createElement('div', { className: 'th-metric-label' }, label),
        React.createElement('div', { className: 'th-metric-value' }, value),
        hint ? React.createElement('div', { className: 'th-metric-hint' }, hint) : null,
      )
    }

    function StateMessage({ text, hint, onRetry, retryLabel }) {
      return React.createElement(
        'div',
        { className: 'th-state' },
        React.createElement('div', { className: 'th-state-text' }, text),
        hint ? React.createElement('div', { className: 'th-state-hint' }, hint) : null,
        onRetry
          ? React.createElement('button', { type: 'button', className: 'th-btn', onClick: onRetry }, retryLabel)
          : null,
      )
    }

    // ── 完整热力图（主面板） ────────────────────────────────────────────
    /**
     * 日档：53 周 × 7 天 GitHub 风格网格（与原实现一致）。
     * 周/月档：把天折叠成桶后，按**分行**的方格矩阵排布（每行固定列数），
     * 因为周/月的桶数远少于 371，继续用 7 行网格会浪费竖向空间。
     */
    function HeatmapGrid({ snapshot, metric, t, dark, grain }) {
      const dayMap = snapshot.days || {}
      const levelOf = React.useMemo(() => buildLevels(dayMap, metric), [snapshot, metric])
      const cols = React.useMemo(() => buildGrid(dayMap, 53), [snapshot])

      const metricOf = (d) => (metric === 'calls' ? d.calls : d.tokens)

      // 月份标签：某列含当月 1 号时打标
      const monthLabels = cols.map((col) => {
        const first = col[0]
        if (first && first.date.getDate() <= 7) {
          return first.date.toLocaleString(undefined, { month: 'short' })
        }
        return ''
      })

      return React.createElement(
        'div',
        { className: 'th-grid-wrap' },
        React.createElement(
          'div',
          { className: 'th-months' },
          monthLabels.map((m, i) => React.createElement('span', { key: i, className: 'th-month' }, m)),
        ),
        React.createElement(
          'div',
          { className: 'th-grid-row' },
          React.createElement(
            'div',
            { className: 'th-weekdays' },
            ['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) =>
              React.createElement('span', { key: i, className: 'th-weekday' }, d),
            ),
          ),
          React.createElement(
            'div',
            { className: 'th-grid' },
            cols.map((col, ci) =>
              React.createElement(
                'div',
                { key: ci, className: 'th-col' },
                col.map((cell) => {
                  const v = cell.data ? metricOf(cell.data) : 0
                  const level = cell.future ? -1 : levelOf(v)
                  const label = cell.data
                    ? `${cell.key} · ${formatFull(v)} ${metric === 'calls' ? t.calls : 'tokens'} · ${formatFull(cell.data.calls)} ${t.calls}`
                    : cell.key
                  const square = React.createElement('span', {
                    className: 'th-cell' + (cell.future ? ' th-cell-future' : ''),
                    style: cell.future ? undefined : { background: colorFor(level, dark) },
                    'aria-label': label,
                  })
                  return Tooltip
                    ? React.createElement(Tooltip, { key: cell.key, label, delayMs: 120 }, square)
                    : React.cloneElement(square, { key: cell.key, title: label })
                }),
              ),
            ),
          ),
        ),
        React.createElement(
          'div',
          { className: 'th-legend' },
          React.createElement('span', { className: 'th-legend-label' }, t.less),
          [0, 1, 2, 3, 4].map((l) =>
            React.createElement('span', {
              key: l,
              className: 'th-cell th-cell-legend',
              style: { background: colorFor(l, dark) },
            }),
          ),
          React.createElement('span', { className: 'th-legend-label' }, t.more),
        ),
      )
    }

    /**
     * 周 / 月档视图：**柱形图**。
     *
     * 早先这里是「一排等高小方格」，既单薄又浪费了「一屏只有十几个桶」的空间。
     * 柱形图把数值映射到**高度**，是这一档最自然的编码：
     *  - 柱高按当档最大值归一（不是分位数），一眼能看出峰值；
     *  - 颜色仍按分位数分档，与日档热力图语义一致；
     *  - 横向滚动承载长轴，标签按步长抽稀，避免日期挤成一团。
     */
    function BucketChart({ snapshot, metric, t, dark, grain }) {
      const dayMap = snapshot.days || {}
      // 最小跨度：周档至少半年（26 周）、月档至少一年（12 月）。
      // 否则只有几天数据时，整条轴就一个柱子 —— 这正是「太单薄」的成因。
      const minBuckets = grain === 'month' ? 12 : 26
      const { buckets, keys } = React.useMemo(
        () => bucketize(dayMap, grain, minBuckets),
        [snapshot, grain, minBuckets],
      )

      const valueOf = (k) => (metric === 'calls' ? buckets.get(k).calls : buckets.get(k).tokens)

      // 分位数色阶按桶值切分（与日档同一套语义）。
      const levelOf = React.useMemo(() => {
        const vals = keys.map(valueOf).filter((v) => v > 0)
        vals.sort((a, b) => a - b)
        const at = (q) => (vals.length === 0 ? 0 : vals[Math.min(vals.length - 1, Math.floor(q * vals.length))])
        const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)]
        return (v) => (!v || v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4)
      }, [buckets, keys, metric])

      const max = React.useMemo(() => keys.reduce((m, k) => Math.max(m, valueOf(k)), 0), [buckets, keys, metric])

      if (keys.length === 0) return null

      const labelOf = (k, b) => {
        const head = grain === 'month' ? k : `${k} ${t.weekOf}`
        return `${head} · ${formatFull(metric === 'calls' ? b.calls : b.tokens)} ${
          metric === 'calls' ? t.calls : 'tokens'
        } · ${b.days} ${t.unitDays} · ${formatFull(b.calls)} ${t.calls}`
      }

      // 轴标签：月档标 `YYYY-MM` 的月份部分；周档标月-日。按步长抽稀。
      const tickOf = (k) => {
        if (grain === 'month') {
          const [y, m] = k.split('-')
          return m === '01' || k === keys[0] ? `${y}-${m}` : m
        }
        const [, m, d] = k.split('-')
        return `${Number(m)}/${Number(d)}`
      }
      const step = keys.length > 14 ? Math.ceil(keys.length / 12) : 1

      return React.createElement(
        'div',
        { className: 'th-chart-wrap' },
        React.createElement(
          'div',
          { className: 'th-chart-scroll' },
          React.createElement(
            'div',
            { className: 'th-chart', role: 'img', 'aria-label': t.title },
            keys.map((k, i) => {
              const b = buckets.get(k)
              const v = valueOf(k)
              const h = max > 0 ? Math.round((v / max) * 100) : 0
              const level = levelOf(v)
              const label = labelOf(k, b)
              const bar = React.createElement('span', {
                // 高度为 0 时留 2px 的「基线」，让安静期仍能看出刻度位置
                className: 'th-bar' + (v > 0 ? '' : ' th-bar-empty'),
                style: { height: v > 0 ? `${Math.max(3, h)}%` : '2px', background: v > 0 ? colorFor(level, dark) : undefined },
                'aria-label': label,
              })
              const tip = Tooltip
                ? React.createElement(Tooltip, { label, delayMs: 120 }, bar)
                : React.cloneElement(bar, { title: label })
              const showTick = i % step === 0 || i === keys.length - 1
              return React.createElement(
                'div',
                { key: k, className: 'th-bar-col' },
                React.createElement('div', { className: 'th-bar-track' }, tip),
                React.createElement(
                  'div',
                  { className: 'th-bar-tick' + (showTick ? '' : ' th-bar-tick-hidden') },
                  showTick ? tickOf(k) : '',
                ),
              )
            }),
          ),
        ),
        React.createElement(
          'div',
          { className: 'th-chart-foot' },
          React.createElement(
            'div',
            { className: 'th-legend th-legend-flat' },
            React.createElement('span', { className: 'th-legend-label' }, t.less),
            [0, 1, 2, 3, 4].map((l) =>
              React.createElement('span', {
                key: l,
                className: 'th-swatch th-cell-legend',
                style: { background: colorFor(l, dark) },
              }),
            ),
            React.createElement('span', { className: 'th-legend-label' }, t.more),
          ),
          React.createElement(
            'span',
            { className: 'th-chart-max' },
            `${t.chartPeak} ${formatCompact(max)}`,
          ),
        ),
      )
    }

    /** 模型用量条形（Top 5 + 其他） */
    function ModelBreakdown({ snapshot, t }) {
      const totals = React.useMemo(() => {
        const acc = new Map()
        for (const day of Object.values(snapshot.days || {})) {
          for (const [k, v] of Object.entries(day.models || {})) {
            acc.set(k, (acc.get(k) || 0) + v)
          }
        }
        return [...acc.entries()].sort((a, b) => b[1] - a[1])
      }, [snapshot])

      if (totals.length === 0) return null
      const top = totals.slice(0, 5)
      const restSum = totals.slice(5).reduce((s, [, v]) => s + v, 0)
      const rows = restSum > 0 ? [...top, [t.other, restSum]] : top
      const max = rows[0][1] || 1

      return React.createElement(
        'div',
        { className: 'th-models' },
        React.createElement('div', { className: 'th-subtitle' }, t.modelBreakdown),
        rows.map(([name, v]) =>
          React.createElement(
            'div',
            { key: name, className: 'th-model-row' },
            React.createElement('span', { className: 'th-model-name', title: name }, name),
            React.createElement(
              'span',
              { className: 'th-model-bar' },
              React.createElement('span', {
                className: 'th-model-fill',
                style: { width: `${Math.max(2, Math.round((v / max) * 100))}%` },
              }),
            ),
            React.createElement('span', { className: 'th-model-val' }, formatCompact(v)),
          ),
        ),
      )
    }

    function FullPanel(props) {
      const t = props.t || TEXT.zh
      const { snapshot, error, loading } = useSnapshot()
      const [metric, setMetric] = React.useState('tokens')
      const [grain, setGrain] = React.useState('day')
      const [dark, setDark] = React.useState(isDark)

      React.useEffect(() => {
        try {
          const mo = new MutationObserver(() => setDark(isDark()))
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
          return () => mo.disconnect()
        } catch {
          return undefined
        }
      }, [])

      if (error && !snapshot) {
        return React.createElement(StateMessage, {
          text: t.error,
          hint: error,
          onRetry: () => store.fetch(true),
          retryLabel: t.retry,
        })
      }
      if (!snapshot && loading) return React.createElement(StateMessage, { text: t.loading })
      if (!snapshot) return React.createElement(StateMessage, { text: t.loading })

      const totals = snapshot.totals || {}
      const streaks = snapshot.streaks || {}
      const hasData = (totals.activeDays || 0) > 0

      return React.createElement(
        'div',
        { className: 'th-root' },
        React.createElement(
          'div',
          { className: 'th-header' },
          React.createElement('div', { className: 'th-title' }, t.title),
          React.createElement('div', { className: 'th-subtitle' }, t.subtitle),
        ),

        hasData
          ? React.createElement(
              'div',
              { className: 'th-metrics' },
              React.createElement(Metric, { label: t.total, value: formatCompact(totals.tokens) }),
              React.createElement(Metric, { label: t.calls, value: formatFull(totals.calls) }),
              React.createElement(Metric, { label: t.activeDays, value: String(totals.activeDays) }),
              React.createElement(Metric, {
                label: t.currentStreak,
                value: `${streaks.current}${t.unitDays}`,
              }),
              React.createElement(Metric, {
                label: t.longestStreak,
                value: `${streaks.longest}${t.unitDays}`,
              }),
              React.createElement(Metric, {
                label: t.peakDay,
                value: snapshot.peak ? formatCompact(snapshot.peak.tokens) : '—',
                hint: snapshot.peak ? snapshot.peak.date : undefined,
              }),
            )
          : React.createElement(StateMessage, { text: t.noData, hint: t.noDataHint }),

        hasData
          ? React.createElement(
              'div',
              { className: 'th-toolbar' },
              React.createElement(
                'div',
                { className: 'th-switch', role: 'group', 'aria-label': t.grainDay },
                ['day', 'week', 'month'].map((g) =>
                  React.createElement(
                    'button',
                    {
                      key: g,
                      type: 'button',
                      className: 'th-switch-btn' + (grain === g ? ' active' : ''),
                      'aria-pressed': grain === g,
                      onClick: () => setGrain(g),
                    },
                    g === 'day' ? t.grainDay : g === 'week' ? t.grainWeek : t.grainMonth,
                  ),
                ),
              ),
              React.createElement(
                'div',
                { className: 'th-switch' },
                ['tokens', 'calls'].map((m) =>
                  React.createElement(
                    'button',
                    {
                      key: m,
                      type: 'button',
                      className: 'th-switch-btn' + (metric === m ? ' active' : ''),
                      onClick: () => setMetric(m),
                    },
                    m === 'tokens' ? t.viewTokens : t.viewCalls,
                  ),
                ),
              ),
              snapshot.scan && snapshot.scan.partial
                ? React.createElement('span', { className: 'th-warn' }, t.partial)
                : null,
              snapshot.scan && snapshot.scan.unreadable > 0
                ? React.createElement(
                    'span',
                    { className: 'th-warn' },
                    `${snapshot.scan.unreadable} ${t.unreadable}`,
                  )
                : null,
            )
          : null,

        hasData && grain === 'day' ? React.createElement(HeatmapGrid, { snapshot, metric, t, dark }) : null,
        hasData && grain !== 'day'
          ? React.createElement(BucketChart, { snapshot, metric, t, dark, grain })
          : null,
        hasData ? React.createElement(ModelBreakdown, { snapshot, t }) : null,
      )
    }

    // ── 侧边栏底部迷你条 ────────────────────────────────────────────────
    /**
     * 始终渲染「迷你热力图 + 今日数字」，**不做折叠态单格退化**（这是明确的产品决定）。
     * 侧栏折叠为 56px 轨道时 `props.wide` 为 false，此时缩到更少的周数并居中；
     * 但仍保留今日数字，只是换成纵向更省的排布。
     * 整块可点击 → 打开全宽主面板。
     */
    function MiniHeatmap(props) {
      const t = props.t || TEXT.zh
      const wide = props.wide !== false
      const onOpen = props.onOpen
      const { snapshot } = useSnapshot()
      const [dark, setDark] = React.useState(isDark)

      const dayMap = (snapshot && snapshot.days) || {}
      // 折叠轨道只放得下约 5 列；展开态 15 周。
      const weeks = wide ? 15 : 5
      const cols = React.useMemo(() => (snapshot ? buildGrid(dayMap, weeks) : []), [snapshot, weeks])
      const levelOf = React.useMemo(() => buildLevels(dayMap, 'tokens'), [snapshot])

      const todayKey = dayKeyOf(new Date())
      const today = dayMap[todayKey]
      const todayTokens = today ? today.tokens : 0

      const interactive = typeof onOpen === 'function'
      const openProps = interactive
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen()
              }
            },
          }
        : {}

      return React.createElement(
        'div',
        {
          className: 'th-mini' + (wide ? '' : ' th-mini-narrow') + (interactive ? ' th-mini-clickable' : ''),
          'aria-label': t.openPanel,
          title: t.openPanel,
          ...openProps,
        },
        React.createElement(
          'div',
          { className: 'th-mini-grid' },
          cols.map((col, ci) =>
            React.createElement(
              'div',
              { key: ci, className: 'th-mini-col' },
              col.map((cell) => {
                const v = cell.data ? cell.data.tokens : 0
                const label = cell.data ? `${cell.key} · ${formatCompact(v)} tokens` : cell.key
                return React.createElement('span', {
                  key: cell.key,
                  className: 'th-mini-cell' + (cell.future ? ' th-cell-future' : ''),
                  style: cell.future ? undefined : { background: colorFor(levelOf(v), dark) },
                  title: label,
                })
              }),
            ),
          ),
        ),
        React.createElement(
          'div',
          { className: 'th-mini-foot' },
          React.createElement('span', { className: 'th-mini-today' }, t.today),
          React.createElement('span', { className: 'th-mini-value' }, formatCompact(todayTokens)),
        ),
      )
    }

    // ── 样式（一次性注入，作用域前缀 th-） ──────────────────────────────
    const CSS = `
.th-root{display:flex;flex-direction:column;gap:16px;padding:4px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}
.th-header{display:flex;flex-direction:column;gap:4px}
.th-title{font-size:15px;font-weight:600}
.th-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary)}
.th-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:10px}
.th-metric{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.th-metric-label{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.th-metric-value{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.th-metric-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.th-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.th-switch{display:inline-flex;border-radius:6px;background:var(--dsw-alias-bg-layer-2);padding:2px}
.th-switch-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 10px;border-radius:4px;cursor:pointer}
.th-switch-btn.active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.th-warn{font-size:11px;color:var(--dsw-alias-state-warning-primary,#b45309)}
.th-grid-wrap{display:flex;flex-direction:column;gap:4px;overflow-x:auto;padding-bottom:4px}
.th-months{display:flex;gap:3px;margin-left:28px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.th-month{width:11px;flex:none;white-space:nowrap;overflow:visible}
.th-grid-row{display:flex;gap:4px}
.th-weekdays{display:flex;flex-direction:column;gap:3px;width:24px;flex:none}
.th-weekday{height:11px;line-height:11px;font-size:9px;color:var(--dsw-alias-label-tertiary)}
.th-grid{display:flex;gap:3px}
.th-col{display:flex;flex-direction:column;gap:3px}
.th-cell{width:11px;height:11px;border-radius:2px;display:block;background:var(--dsw-alias-bg-layer-2)}
.th-cell-future{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-bg-layer-2)}
.th-cell-legend{display:inline-block}
.th-chart-wrap{display:flex;flex-direction:column;gap:8px}
.th-chart-scroll{overflow-x:auto;padding-bottom:4px}
.th-chart{display:flex;align-items:flex-end;gap:6px;height:168px;min-width:min-content}
.th-bar-col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;flex:0 0 auto;width:26px}
.th-bar-track{display:flex;align-items:flex-end;justify-content:center;width:100%;height:140px}
.th-bar{display:block;width:100%;max-width:22px;border-radius:3px 3px 1px 1px;background:#26a641;transition:opacity .12s}
.th-bar:hover{opacity:.82}
.th-bar-empty{background:var(--dsw-alias-bg-layer-2);border-radius:1px}
.th-bar-tick{font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;transform:rotate(-38deg);transform-origin:center;height:16px}
.th-bar-tick-hidden{visibility:hidden}
.th-chart-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.th-legend-flat{margin-left:0}
.th-chart-max{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.th-swatch{width:11px;height:11px;border-radius:2px;display:inline-block}
.th-legend{display:flex;align-items:center;gap:3px;margin-left:28px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.th-legend-label{margin:0 4px}
.th-models{display:flex;flex-direction:column;gap:6px}
.th-model-row{display:flex;align-items:center;gap:10px;font-size:12px}
.th-model-name{width:34%;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.th-model-bar{flex:1;min-width:60px;max-width:420px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.th-model-fill{display:block;height:100%;border-radius:3px;background:#26a641}
.th-model-val{width:60px;flex:none;text-align:left;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* 行尾留白：避免条形与数值紧贴主面板右边框 */
.th-model-row::after{content:'';flex:0 0 12px}
.th-state{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:16px 4px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.th-state-text{font-weight:600;color:var(--dsw-alias-label-primary)}
.th-state-hint{font-size:12px}
.th-btn{appearance:none;border:0;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.th-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.th-mini{display:flex;flex-direction:column;gap:5px;padding:6px 4px;width:100%;min-width:0;box-sizing:border-box;border-radius:6px;border:1px solid transparent}
.th-mini-clickable{cursor:pointer}
.th-mini-clickable:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-bg-layer-2)}
.th-mini-clickable:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover);outline-offset:1px}
/* 折叠轨道：不退化单格，只收窄周数并居中（用户明确要求保留迷你格 + 今日数字） */
.th-mini-narrow{align-items:center;padding:6px 0}
.th-mini-narrow .th-mini-grid{justify-content:center}
.th-mini-narrow .th-mini-foot{flex-direction:column;align-items:center;gap:0}
.th-mini-grid{display:flex;gap:2px;justify-content:flex-start;overflow:hidden}
.th-mini-col{display:flex;flex-direction:column;gap:2px}
.th-mini-cell{width:7px;height:7px;border-radius:1.5px;display:block;background:var(--dsw-alias-bg-layer-2)}
.th-mini-foot{display:flex;align-items:baseline;justify-content:space-between;gap:6px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.th-mini-value{font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* 侧栏导航行里的字形：只画一个小方格网格标记 */
.th-glyph{display:grid;grid-template-columns:repeat(3,3px);grid-template-rows:repeat(3,3px);gap:1px;place-content:center}
.th-glyph i{display:block;width:3px;height:3px;border-radius:0.5px;background:currentColor;opacity:.35}
.th-glyph i.on{opacity:1}
`

    function ensureStyles() {
      const id = 'dsh-token-heatmap-styles'
      if (document.getElementById(id)) return
      const el = document.createElement('style')
      el.id = id
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ── 注册 ────────────────────────────────────────────────────────────
    function pickText(ctx) {
      try {
        const lang = ctx?.locale?.getSnapshot?.().active
        if (typeof lang === 'string' && lang.startsWith('zh')) return TEXT.zh
      } catch {
        /* 语言不可用时用默认 */
      }
      return TEXT.zh
    }

    /**
     * 侧栏导航行里的字形（`sidebar.panellist` 只渲染字形，标题由注册项的 label 提供）。
     * 3×3 小方格，右下角提亮，呼应热力图语义；用 currentColor 跟随宿主选中态。
     */
    function HeatmapGlyph() {
      const on = new Set([4, 5, 7, 8])
      const cells = []
      for (let i = 0; i < 9; i++) {
        cells.push(React.createElement('i', { key: i, className: on.has(i) ? 'on' : '' }))
      }
      return React.createElement('span', { className: 'th-glyph', 'aria-hidden': 'true' }, cells)
    }

    function apply(ctx) {
      ensureStyles()
      const t = pickText(ctx)

      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function') return

      /**
       * 打开全宽主面板。
       *
       * ⚠️ 这里必须**在点击时**才解析 layout 服务，不能在 apply 时抓一次存起来：
       * apply 可能在 `ui-layout` 之前就跑完，那一刻抓到的会是 undefined，
       * 之后永久是空 —— 表现就是「点了没反应」。
       *
       * 首选 `ctx.layout`（已在 exports.inject 里声明，宿主会等它就绪），
       * 再兜底到 `ctx.get('layout')`；都没有时静默降级为不可点击。
       */
      const openPanel = () => {
        try {
          const layout = ctx.layout || (typeof ctx.get === 'function' ? ctx.get('layout') : null)
          if (!layout || typeof layout.selectPanel !== 'function') {
            console.warn('[dsh-token-heatmap] layout 服务不可用，无法打开主面板')
            return
          }
          layout.selectPanel(NS)
        } catch (e) {
          console.warn('[dsh-token-heatmap] 打开主面板失败', e && e.message)
        }
      }

      // 1) 全宽主面板 —— main（keyed，需 key；与 panellist 的 id 同名才能互相跳转）
      try {
        slots.inject('main', () =>
          slots.register(
            {
              name: 'main',
              key: NS,
              inject: () => ({ t }),
            },
            FullPanel,
          ),
        )
      } catch (e) {
        console.warn('[dsh-token-heatmap] main 面板注册失败', e && e.message)
      }

      // 2) 侧边栏导航行 —— sidebar.panellist（list，需 id；label 供导航行标题）
      try {
        slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: NS,
              order: 40,
              label: () => t.panelLabel,
            },
            HeatmapGlyph,
          ),
        )
      } catch (e) {
        console.warn('[dsh-token-heatmap] sidebar.panellist 注册失败', e && e.message)
      }

      // 3) 设置页完整面板 —— settings.section（list，需 id）
      try {
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: NS,
              order: 60,
              label: () => t.sectionLabel,
              inject: () => ({ t }),
            },
            FullPanel,
          ),
        )
      } catch (e) {
        console.warn('[dsh-token-heatmap] settings.section 注册失败', e && e.message)
      }

      // 4) 侧边栏底部迷你条 —— sidebar.footer.action（list，需 id，owner 下发 wide）
      try {
        slots.inject('sidebar.footer.action', () =>
          slots.register(
            {
              name: 'sidebar.footer.action',
              id: NS,
              order: 10,
              inject: () => ({ t, onOpen: openPanel }),
            },
            MiniHeatmap,
          ),
        )
      } catch (e) {
        console.warn('[dsh-token-heatmap] sidebar.footer.action 注册失败', e && e.message)
      }
    }

    exports.apply = apply
    /**
     * 客户端服务名用短名（'slots'），与 dsh.client.inject 的包名列表不同。
     *
     * 必须声明 `layout`：宿主会等它就绪后才调用 apply，`ctx.layout` 才拿得到。
     * （DSH 自带的 plugin-manager / task-manager 面板同样是这么声明的。）
     */
    exports.inject = ['slots', 'locale', 'layout']

    /**
     * 仅供离线测试读取的纯函数出口（浏览器加载器只认 apply / inject）。
     * 周/月分桶是「日 → 周/月」聚合的核心算术，必须能被单测直接钉住，
     * 而它又只能在本 bundle 内自包含（浏览器侧无法 import）。
     */
    exports.__internals = { bucketize, buildGrid, buildLevels, dayKeyOf, formatCompact, BucketChart }
    return module.exports
  },
})
