/**
 * dsh-token-heatmap —— 宿主（Node）半边。
 *
 * 职责：
 *  1. 扫描 %DSH_HOME%\sessions 下的会话日志，折叠出「按天 token 用量」；
 *  2. 注册同源只读路由 GET /api/token-heatmap 供浏览器半边读取；
 *  3. 带 TTL 的内存缓存 + 扫描互斥，避免密集轮询触发全量重扫。
 *
 * 设计取舍：
 *  - `inject = []`：不硬依赖任何服务。webServer 可能晚于插件激活，也可能
 *    根本不存在（headless / 测试 profile）。缺失时插件保持激活、静默降级，
 *    由客户端走「无数据」分支，而不是让整个插件加载失败。
 *  - 只读：不写任何文件、不外呼网络、不注册工具、不注入系统提示。
 *  - 返回给浏览器的只有日期/计数/模型名；绝不含提示词、工具参数或工作区路径。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { aggregateFromDiskAsync } from './aggregate.js'

export const name = 'token-heatmap'

/** 不硬依赖服务：webServer 缺席的宿主也要能激活（见文件头说明）。 */
export const inject = []

const ROUTE_PATH = '/api/token-heatmap'
const DEFAULT_TTL_MS = 60_000

/** 解析 DSH 主目录：环境变量优先，回退 ~/.dsh。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 带 TTL 的缓存 + 并发去重：多个请求同时到达只触发一次扫描。 */
function createSnapshotCache(loader, ttlMs) {
  let cached = null
  let cachedAt = 0
  let inflight = null

  return async function get() {
    const now = Date.now()
    if (cached !== null && now - cachedAt < ttlMs) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const fresh = await loader()
        cached = fresh
        cachedAt = Date.now()
        return fresh
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
}

/** 写 JSON 响应。只读端点，一律 no-store。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(body)
}

export function apply(ctx) {
  const dshHome = resolveDshHome()
  const sessionsRoot = join(dshHome, 'sessions')
  const ttlMs = Number(process.env.DSH_TOKEN_HEATMAP_TTL_MS) || DEFAULT_TTL_MS

  /**
   * 跨请求存活的「按文件」增量缓存：命中 mtime+size 的日志直接复用上次结果。
   * 没有它，每分钟一次的全量重扫要重新解压 45MB 文本 —— 这正是桌面端卡死的来源。
   */
  const fileCache = new Map()

  const getSnapshot = createSnapshotCache(
    () => aggregateFromDiskAsync(sessionsRoot, { cache: fileCache }),
    ttlMs,
  )

  const handler = async (req, res) => {
    try {
      const snapshot = await getSnapshot()
      sendJson(res, 200, snapshot)
    } catch (error) {
      // 单个端点故障不应打挂宿主：回答 500 并留一条 warning。
      try {
        ctx.logger?.warn?.(`token-heatmap: 聚合失败 ${error?.message ?? error}`)
      } catch {
        /* 日志不可用时忽略 */
      }
      sendJson(res, 500, { error: 'aggregate-failed', message: String(error?.message ?? error) })
    }
  }

  /**
   * webServer 可能晚于本插件激活。用 cordis 的 `ctx.inject([...], cb)` 而不是
   * 顶层 `inject` 导出：前者在服务就绪时运行回调、服务变更时重跑、卸载时清理，
   * 因此 webServer 缺席的宿主（headless / 测试 profile）不会让插件加载失败。
   * 实证写法见 dsh-free-search 的 `ctx.inject(["webServer","settings"], ...)`。
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        let routeDisposer = null
        try {
          routeDisposer = sctx.webServer.register({
            kind: 'exact',
            path: ROUTE_PATH,
            handler,
          })
        } catch (error) {
          // 重复 path（多为热重载残留）不应打挂插件：记录并保持激活。
          try {
            ctx.logger?.warn?.(`token-heatmap: 路由注册失败 ${error?.message ?? error}`)
          } catch {
            /* ignore */
          }
        }
        return () => {
          if (routeDisposer) {
            try {
              routeDisposer()
            } catch {
              /* ignore */
            }
            routeDisposer = null
          }
        }
      }, 'token-heatmap: route')
    })
  }

  // 暴露一个只读服务，便于其他插件/测试复用同一份聚合结果（可选消费）。
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('tokenHeatmap', {
        getSnapshot,
        get sessionsRoot() {
          return sessionsRoot
        },
      })
    } catch {
      /* 服务名被占用时不影响主功能 */
    }
  }
}
