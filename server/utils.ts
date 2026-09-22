import { PeerTubeHelpers, PluginSettingsManager } from '@peertube/peertube-types'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import Stripe from 'stripe'
import { PluginUserInfo } from './types'
import {
  PRICE_COUPON_NONE,
  PRICE_SORT_HIGHEST_FIRST,
  PRICE_SORT_LOWEST_FIRST,
  SETTING_STRIPE_COUPON_ID,
  SETTING_STRIPE_PRODUCT_ID,
  getPriceCouponSettingName,
  getPriceTrialDaysSettingName
} from '../shared/constants'

export const ONE_DAY = 60 * 60 * 24 * 1000


/**
 * Keep backward compatibility for API upgrade
 * https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
 */
export const getCurrentPeriodEnd = async (
  settingsManager: PluginSettingsManager,
  subscription: Stripe.Subscription & { current_period_end?: number }
) => {
  const productId = await settingsManager.getSetting(SETTING_STRIPE_PRODUCT_ID) as string
  const subscriptionItem = subscription.items.data.find(i =>
    i.price.product === productId
  )
  const periodEnd = subscription?.current_period_end || subscriptionItem?.current_period_end

  return periodEnd as number
}

/**
 * Create instance unique field names to make it possible to have the same Stripe account
 * conneted with multiple instances.
 */
export const getStripeCustomerMetadataFieldNames = (peertubeHelpers: PeerTubeHelpers):
  { userId: string, deletedAt: string } => {
  const prefix = peertubeHelpers.config.getWebserverUrl()

  return {
    deletedAt: `${prefix}-deletedAt`,
    userId: `${prefix}-userId`
  }
}

export const getStripeProducts = async (stripeApiKey: string): Promise<Stripe.Product[]> => {
  const stripe = new Stripe(stripeApiKey)

  const products = await stripe.products.list()

  return products.data
}

export const getStripeCoupons = async (stripeApiKey: string): Promise<Stripe.Coupon[]> => {
  const stripe = new Stripe(stripeApiKey)

  const coupons = await stripe.coupons.list()

  return coupons.data
}

const INTERVAL_DAYS: { [interval: string]: number } = { day: 1, week: 7, month: 30, year: 365 }

const getBillingPeriodDays = (price: Stripe.Price): number =>
  (INTERVAL_DAYS[price.recurring?.interval ?? 'year'] ?? 365) * (price.recurring?.interval_count ?? 1)

export type PriceSortOrder = typeof PRICE_SORT_LOWEST_FIRST | typeof PRICE_SORT_HIGHEST_FIRST

/**
 * Sort prices for display (configurable via the price-sort-order setting):
 * cheapest or most expensive first. The direction only applies to the amount
 * — ties always break on shortest billing period and finally price id, so
 * every instance and view renders the same deterministic order. Prices
 * without a unit amount (e.g. tiered) always sort last.
 */
export const sortPricesForDisplay = <T extends Stripe.Price> (
  prices: T[],
  order: PriceSortOrder = PRICE_SORT_LOWEST_FIRST
): T[] => {
  const direction = order === PRICE_SORT_HIGHEST_FIRST ? -1 : 1

  return [...prices].sort((a, b) => {
    if ((a.unit_amount == null) !== (b.unit_amount == null)) {
      return a.unit_amount == null ? 1 : -1
    }

    return (direction * ((a.unit_amount ?? 0) - (b.unit_amount ?? 0))) ||
      (getBillingPeriodDays(a) - getBillingPeriodDays(b)) ||
      a.id.localeCompare(b.id)
  })
}

export const getStripePrices = async (stripeApiKey: string, productId: string): Promise<Stripe.Price[]> => {
  const stripe = new Stripe(stripeApiKey)

  const prices = await stripe.prices.list({
    active: true,
    product: productId,
    type: 'recurring',
    limit: 12
  })

  return sortPricesForDisplay(prices.data)
}

/**
 * Resolve which coupon or free trial applies to a price. The per-price coupon
 * setting overrides the default coupon setting ('' = inherit the default,
 * PRICE_COUPON_NONE = explicitly no coupon). The free trial only applies when
 * no coupon does.
 */
export const resolvePriceSettings = async (
  settingsManager: PluginSettingsManager,
  priceId: string
): Promise<{ couponId?: string, trialDays?: number }> => {
  const [couponOverride, defaultCouponId, trialDaysRaw] = await Promise.all([
    settingsManager.getSetting(getPriceCouponSettingName(priceId)),
    settingsManager.getSetting(SETTING_STRIPE_COUPON_ID),
    settingsManager.getSetting(getPriceTrialDaysSettingName(priceId))
  ]) as [string | undefined, string | undefined, string | undefined]

  if (couponOverride !== PRICE_COUPON_NONE) {
    const couponId = couponOverride || defaultCouponId

    if (couponId) {
      return { couponId }
    }
  }

  // Strictly positive integers only — parseInt would silently truncate
  // values like "14.5" or "14days"
  const trimmed = String(trialDaysRaw ?? '').trim()

  if (/^\d+$/.test(trimmed)) {
    const trialDays = parseInt(trimmed, 10)

    if (trialDays > 0) {
      return { trialDays }
    }
  }

  return {}
}

export const isPremiumUser = (userInfo: PluginUserInfo | undefined): boolean => {
  if (!userInfo?.paidUntil) {
    return false
  }

  return (+new Date(userInfo.paidUntil) - +new Date()) > -ONE_DAY
}

// Mirrors UserRole of @peertube/peertube-models. @peertube/peertube-types is types-only, so no runtime import
export const USER_ROLE_ADMINISTRATOR = 0
export const USER_ROLE_MODERATOR = 1

/**
 * Whether the description of an account has to be hidden from the API.
 *
 * Remote accounts have no local user and are never touched, administrators and moderators are exempt,
 * everyone else needs an active premium subscription to show a description.
 */
export const shouldHideAccountDescription = (options: {
  isLocalAccount: boolean
  userRole?: number
  userInfo?: PluginUserInfo
}): boolean => {
  const { isLocalAccount, userRole, userInfo } = options

  if (!isLocalAccount) return false
  if (userRole === USER_ROLE_ADMINISTRATOR || userRole === USER_ROLE_MODERATOR) return false

  return !isPremiumUser(userInfo)
}

export const getCustomerSubscriptions = async (
  customer: Stripe.Customer,
  settingsManager: PluginSettingsManager,
  peertubeHelpers: PeerTubeHelpers
) => {
  const subscriptionProductId = await settingsManager.getSetting(SETTING_STRIPE_PRODUCT_ID)

  // Sort to have newest subscription first
  const subscriptions = customer.subscriptions?.data
    .filter((sub) => sub.items.data.length === 1 && sub.items.data[0].plan.product === subscriptionProductId)
    .sort((a, b) => b.created > a.created ? 1 : -1) ?? []

  if (subscriptions.length && subscriptions.length > 1) {
    peertubeHelpers.logger.info(
      `Customer ${String(customer.id)} has multiple subscriptions:
        ${String(subscriptions.length)}`
    )
  }

  const activeSubscriptions = subscriptions.filter((s) => ['trialing', 'active'].includes(s.status)) ?? []

  if (activeSubscriptions.length > 1) {
    peertubeHelpers.logger.warn(
      `Customer ${String(customer.id)} has multiple active subscriptions:
        ${String(activeSubscriptions.length)}`
    )
  }

  return {
    activeSubscriptions,
    inactiveSubscriptions: subscriptions
  }
}
/**
 * Wrap a route handler so that no error can escape it and reach PeerTube's
 * process-level `unhandledRejection` handler, which calls `process.exit(1)`
 * and takes the whole instance down. Awaiting the handler funnels both
 * synchronous throws and async rejections into a single catch that logs the
 * error and responds 500 (a retriable signal to callers such as Stripe),
 * keeping the host alive.
 */
export const buildRouteHandlerWrapper = (logger: PeerTubeHelpers['logger']) =>
  (handler: RequestHandler) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await handler(req, res, next)
      } catch (err) {
        logger.error('Unhandled error in a premium-users route handler.', { err })

        if (!res.headersSent) {
          res.status(500).json({})
        }
      }
    }
