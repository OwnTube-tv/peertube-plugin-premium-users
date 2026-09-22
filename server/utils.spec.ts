import 'mocha'
import { deepEqual, equal, ok } from 'assert'
import { PeerTubeHelpers, PluginSettingsManager } from '@peertube/peertube-types'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
  buildRouteHandlerWrapper,
  isPremiumUser,
  ONE_DAY,
  shouldHideAccountDescription,
  USER_ROLE_ADMINISTRATOR,
  USER_ROLE_MODERATOR,
  resolvePriceSettings,
  sortPricesForDisplay
} from './utils.js'
import Stripe from 'stripe'
import {
  PRICE_COUPON_NONE,
  SETTING_STRIPE_COUPON_ID,
  getPriceCouponSettingName,
  getPriceTrialDaysSettingName
} from '../shared/constants.js'

describe('utils', () => {
  describe('shouldHideAccountDescription', () => {
    const premium = { paidUntil: new Date(Date.now() + ONE_DAY * 7).toISOString() }
    const expired = { paidUntil: new Date(Date.now() - ONE_DAY * 7).toISOString() }
    const USER = 2

    it('never hides the description of a remote account', () => {
      equal(shouldHideAccountDescription({ isLocalAccount: false }), false)
      equal(shouldHideAccountDescription({ isLocalAccount: false, userRole: USER, userInfo: expired }), false)
    })

    it('never hides the description of an administrator', () => {
      equal(shouldHideAccountDescription({ isLocalAccount: true, userRole: USER_ROLE_ADMINISTRATOR }), false)
    })

    it('never hides the description of a moderator', () => {
      equal(
        shouldHideAccountDescription({ isLocalAccount: true, userRole: USER_ROLE_MODERATOR, userInfo: expired }),
        false
      )
    })

    it('hides the description of a user without a subscription', () => {
      equal(shouldHideAccountDescription({ isLocalAccount: true, userRole: USER }), true)
    })

    it('hides the description of a user whose subscription expired', () => {
      equal(shouldHideAccountDescription({ isLocalAccount: true, userRole: USER, userInfo: expired }), true)
    })

    it('shows the description of a premium user', () => {
      equal(shouldHideAccountDescription({ isLocalAccount: true, userRole: USER, userInfo: premium }), false)
    })

    it('hides the description when the role is unknown', () => {
      equal(shouldHideAccountDescription({ isLocalAccount: true }), true)
    })
  })

  describe('isPremiumUser', () => {
    it('return true if isPaidUntil is in one week', () => {
      const now = new Date().getTime()
      const userInfo = {
        paidUntil: new Date(now + ONE_DAY * 7).toISOString()
      }
      equal(isPremiumUser(userInfo), true);
    })

    it('return true if isPaidUntil is tomorrow', () => {
      const now = new Date().getTime()
      const userInfo = {
        paidUntil: new Date(now + ONE_DAY).toISOString()
      }
      equal(isPremiumUser(userInfo), true);
    })

    it('return true if isPaidUntil is in one hour', () => {
      const now = new Date().getTime()
      const userInfo = {
        paidUntil: new Date(now + 3600 * 1000).toISOString()
      }
      equal(isPremiumUser(userInfo), true);
    })

    it('return true if isPaidUntil is now', () => {
      const now = new Date().getTime()
      const userInfo = {
        paidUntil: new Date(now).toISOString()
      }
      equal(isPremiumUser(userInfo), true);
    })

    it('return true if isPaidUntil is yesterday', () => {
      const now = new Date().getTime()
      const userInfo = {
        paidUntil: new Date(now - ONE_DAY + 1000 * 60).toISOString()
      }
      equal(isPremiumUser(userInfo), true);
    })
  })

  describe('resolvePriceSettings', () => {
    const PRICE_ID = 'price_123'

    const fakeSettingsManager = (values: { [name: string]: string }): PluginSettingsManager => ({
      getSetting: async (name: string) => values[name]
    }) as unknown as PluginSettingsManager

    it('returns nothing when no coupon nor trial is configured', async () => {
      deepEqual(await resolvePriceSettings(fakeSettingsManager({}), PRICE_ID), {})
    })

    it('inherits the default coupon when there is no per-price override', async () => {
      const settings = fakeSettingsManager({
        [SETTING_STRIPE_COUPON_ID]: 'coupon_default'
      })
      deepEqual(await resolvePriceSettings(settings, PRICE_ID), { couponId: 'coupon_default' })
    })

    it('lets the per-price coupon override the default', async () => {
      const settings = fakeSettingsManager({
        [SETTING_STRIPE_COUPON_ID]: 'coupon_default',
        [getPriceCouponSettingName(PRICE_ID)]: 'coupon_override'
      })
      deepEqual(await resolvePriceSettings(settings, PRICE_ID), { couponId: 'coupon_override' })
    })

    it('disables coupons entirely with the none override', async () => {
      const settings = fakeSettingsManager({
        [SETTING_STRIPE_COUPON_ID]: 'coupon_default',
        [getPriceCouponSettingName(PRICE_ID)]: PRICE_COUPON_NONE
      })
      deepEqual(await resolvePriceSettings(settings, PRICE_ID), {})
    })

    it('offers the free trial when the none override is combined with trial days', async () => {
      const settings = fakeSettingsManager({
        [SETTING_STRIPE_COUPON_ID]: 'coupon_default',
        [getPriceCouponSettingName(PRICE_ID)]: PRICE_COUPON_NONE,
        [getPriceTrialDaysSettingName(PRICE_ID)]: '14'
      })
      deepEqual(await resolvePriceSettings(settings, PRICE_ID), { trialDays: 14 })
    })

    it('lets an applying coupon win over the trial', async () => {
      const settings = fakeSettingsManager({
        [SETTING_STRIPE_COUPON_ID]: 'coupon_default',
        [getPriceTrialDaysSettingName(PRICE_ID)]: '14'
      })
      deepEqual(await resolvePriceSettings(settings, PRICE_ID), { couponId: 'coupon_default' })
    })

    it('ignores invalid trial day values', async () => {
      for (const bogus of ['abc', '-5', '0', '', '14.5', '14days', '1e3']) {
        const settings = fakeSettingsManager({
          [getPriceTrialDaysSettingName(PRICE_ID)]: bogus
        })
        deepEqual(await resolvePriceSettings(settings, PRICE_ID), {}, `trial days value: "${bogus}"`)
      }
    })
  })

  describe('sortPricesForDisplay', () => {
    const price = (id: string, unitAmount: number | null, interval: string, intervalCount = 1): Stripe.Price => ({
      id,
      unit_amount: unitAmount,
      recurring: { interval, interval_count: intervalCount }
    }) as unknown as Stripe.Price

    it('sorts cheapest price first', () => {
      const sorted = sortPricesForDisplay([price('year', 154800, 'year'), price('month', 12900, 'month')])
      deepEqual(sorted.map(p => p.id), ['month', 'year'])
    })

    it('breaks amount ties on the shortest billing period', () => {
      const sorted = sortPricesForDisplay([price('year', 1000, 'year'), price('month', 1000, 'month')])
      deepEqual(sorted.map(p => p.id), ['month', 'year'])
    })

    it('sorts prices without a unit amount last', () => {
      const sorted = sortPricesForDisplay([price('tiered', null, 'month'), price('month', 12900, 'month')])
      deepEqual(sorted.map(p => p.id), ['month', 'tiered'])
    })

    it('is deterministic for identical amounts and periods', () => {
      const sorted = sortPricesForDisplay([price('b', 1000, 'month'), price('a', 1000, 'month')])
      deepEqual(sorted.map(p => p.id), ['a', 'b'])
    })

    it('sorts highest price first when configured', () => {
      const sorted = sortPricesForDisplay(
        [price('month', 12900, 'month'), price('year', 154800, 'year')],
        'highest-first'
      )
      deepEqual(sorted.map(p => p.id), ['year', 'month'])
    })

    it('sorts prices without a unit amount last also when highest first', () => {
      const sorted = sortPricesForDisplay(
        [price('tiered', null, 'month'), price('month', 12900, 'month')],
        'highest-first'
      )
      deepEqual(sorted.map(p => p.id), ['month', 'tiered'])
    })

    it('always breaks amount ties on the shortest billing period, also when highest first', () => {
      const sorted = sortPricesForDisplay(
        [price('year', 1000, 'year'), price('month', 1000, 'month')],
        'highest-first'
      )
      deepEqual(sorted.map(p => p.id), ['month', 'year'])
    })
  })

  describe('buildRouteHandlerWrapper', () => {
    const noopLogger = { error () {} } as unknown as PeerTubeHelpers['logger']
    const wrap = buildRouteHandlerWrapper(noopLogger)

    const fakeRes = () => {
      const res: any = { headersSent: false, statusCode: undefined, body: undefined }
      res.status = (code: number) => { res.statusCode = code; return res }
      res.json = (body: any) => { res.body = body; res.headersSent = true; return res }
      return res as Response & { statusCode?: number }
    }

    it('passes through a handler that responds normally', async () => {
      const res = fakeRes()
      const handler: RequestHandler = (_req, r) => { r.status(200).json({ ok: true }) }
      await wrap(handler)({} as Request, res, (() => {}) as NextFunction)
      equal(res.statusCode, 200)
    })

    it('responds 500 when the handler rejects asynchronously', async () => {
      const res = fakeRes()
      const handler: RequestHandler = async () => { throw new Error('async boom') }
      await wrap(handler)({} as Request, res, (() => {}) as NextFunction)
      equal(res.statusCode, 500)
    })

    it('responds 500 when the handler throws synchronously', async () => {
      const res = fakeRes()
      const handler: RequestHandler = () => { throw new Error('sync boom') }
      await wrap(handler)({} as Request, res, (() => {}) as NextFunction)
      equal(res.statusCode, 500)
    })

    it('does not respond again if the handler already sent a response before throwing', async () => {
      const res = fakeRes()
      const handler: RequestHandler = (_req, r) => {
        r.status(200).json({ ok: true })
        throw new Error('boom after responding')
      }
      await wrap(handler)({} as Request, res, (() => {}) as NextFunction)
      equal(res.statusCode, 200)
    })

    it('never rejects, so the error cannot reach the process', async () => {
      const res = fakeRes()
      const handler: RequestHandler = async () => { throw new Error('async boom') }
      let rejected = false
      await wrap(handler)({} as Request, res, (() => {}) as NextFunction)
        .catch(() => { rejected = true })
      ok(!rejected)
    })
  })
})
