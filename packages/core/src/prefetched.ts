import { objectsAreEqual } from './objectUtils'
import { Response } from './response'
import { timeToMs } from './time'
import {
  ActivelyPrefetching,
  ActiveVisit,
  CacheForOption,
  InternalActiveVisit,
  PrefetchCancellationToken,
  PrefetchedResponse,
  PrefetchOptions,
  PrefetchRemovalTimer,
} from './types'

class PrefetchedRequests {
  protected cached: PrefetchedResponse[] = []
  protected activeRequests: ActivelyPrefetching[] = []
  protected removalTimers: PrefetchRemovalTimer[] = []
  protected currentCancellationToken: PrefetchCancellationToken | null = null

  public add(params: ActiveVisit, sendFunc: (params: InternalActiveVisit) => void, { cacheFor }: PrefetchOptions) {
    const inFlight = this.findInFlight(params)

    if (inFlight) {
      return Promise.resolve()
    }

    const existing = this.findCached(params)

    if (!params.fresh && existing && existing.staleTimestamp > Date.now()) {
      return Promise.resolve()
    }

    const [stale, expires] = this.extractStaleValues(cacheFor)

    const promise = new Promise<Response>((resolve, reject) => {
      sendFunc({
        ...params,
        onCancel: () => {
          this.remove(params)
          params.onCancel()
          reject()
        },
        onError: (error) => {
          this.remove(params)
          params.onError(error)
          reject()
        },
        onPrefetching(visitParams) {
          params.onPrefetching(visitParams)
        },
        onPrefetched(response, visit) {
          params.onPrefetched(response, visit)
        },
        onPrefetchResponse(response) {
          resolve(response)
        },
      })
    }).then((response) => {
      this.remove(params)

      this.cached.push({
        params: { ...params },
        staleTimestamp: Date.now() + timeToMs(stale),
        response: promise,
        singleUse: cacheFor === 0,
        timestamp: Date.now(),
      })

      this.scheduleForRemoval(params, expires)

      this.activeRequests = this.activeRequests.filter((prefetching) => {
        return !this.paramsAreEqual(prefetching.params, params)
      })

      response.handlePrefetch()

      return response
    })

    this.activeRequests.push({
      params: { ...params },
      response: promise,
      staleTimestamp: null,
    })

    return promise
  }

  public removeAll(): void {
    this.cached = []
    this.removalTimers.forEach((removalTimer) => {
      clearTimeout(removalTimer.timer)
    })
    this.removalTimers = []
  }

  public remove(params: ActiveVisit): void {
    this.cached = this.cached.filter((prefetched) => {
      return !this.paramsAreEqual(prefetched.params, params)
    })

    this.clearTimer(params)
  }

  protected extractStaleValues(cacheFor: PrefetchOptions['cacheFor']): [CacheForOption, CacheForOption] {
    if (!Array.isArray(cacheFor)) {
      return [cacheFor, cacheFor]
    }

    switch (cacheFor.length) {
      case 0:
        return [0, 0]
      case 1:
        return [cacheFor[0], cacheFor[0]]
      default:
        return [cacheFor[0], cacheFor[1]]
    }
  }

  protected clearTimer(params: ActiveVisit) {
    const timer = this.removalTimers.find((removalTimer) => {
      return this.paramsAreEqual(removalTimer.params, params)
    })

    if (timer) {
      clearTimeout(timer.timer)
      this.removalTimers = this.removalTimers.filter((removalTimer) => removalTimer !== timer)
    }
  }

  protected scheduleForRemoval(params: ActiveVisit, expiresIn: CacheForOption) {
    this.clearTimer(params)

    expiresIn = timeToMs(expiresIn)

    if (expiresIn > 0) {
      const timer = window.setTimeout(() => this.remove(params), expiresIn)

      this.removalTimers.push({
        params,
        timer,
      })
    }
  }

  public get(params: ActiveVisit): ActivelyPrefetching | PrefetchedResponse | null {
    return this.findCached(params) || this.findInFlight(params)
  }

  public cancelUse() {
    if (this.currentCancellationToken) {
      this.currentCancellationToken.cancel()
    }
  }

  public use(
    prefetched: PrefetchedResponse | ActivelyPrefetching,
    params: ActiveVisit,
    cancellationToken: PrefetchCancellationToken,
  ) {
    this.currentCancellationToken = cancellationToken
    return prefetched.response.then((response) => {
      if (cancellationToken.isCancelled) {
        return
      }

      response.mergeParams({ ...params, onPrefetched: () => {} })

      // If this was a one-time cache, remove it
      // (generally a prefetch="click" request with no specified cache value)
      this.removeSingleUseItems(params)

      return response.handle()
    })
  }

  protected removeSingleUseItems(params: ActiveVisit) {
    this.cached = this.cached.filter((prefetched) => {
      if (!this.paramsAreEqual(prefetched.params, params)) {
        return true
      }

      return !prefetched.singleUse
    })
  }

  public findCached(params: ActiveVisit): PrefetchedResponse | null {
    return (
      this.cached.find((prefetched) => {
        return this.paramsAreEqual(prefetched.params, params)
      }) || null
    )
  }

  public findInFlight(params: ActiveVisit): ActivelyPrefetching | null {
    return (
      this.activeRequests.find((prefetched) => {
        return this.paramsAreEqual(prefetched.params, params)
      }) || null
    )
  }

  protected paramsAreEqual(params1: ActiveVisit, params2: ActiveVisit): boolean {
    return objectsAreEqual<ActiveVisit>(params1, params2, [
      'showProgress',
      'replace',
      'prefetch',
      'onBefore',
      'onStart',
      'onProgress',
      'onFinish',
      'onCancel',
      'onSuccess',
      'onError',
      'onPrefetched',
      'onCancelToken',
      'onPrefetching',
      'async',
    ])
  }
}

export const prefetchedRequests = new PrefetchedRequests()
