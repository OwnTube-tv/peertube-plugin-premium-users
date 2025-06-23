import type {
  MUserDefault,
  PeerTubeHelpers,
  PluginSettingsManager
} from '@peertube/peertube-types'
import express from 'express'
import { Storage } from '../storage'
import { SETTING_STRIPE_API_KEY } from '../../shared/constants'
import Stripe from 'stripe'
import { Subscription } from '../types'
import { getCurrentPeriodEnd, getCustomerSubscriptions } from '../utils'

const convertStripeDateToString = (date: number): string =>
  new Date(date * 1000).toISOString()

export class SubscriptionRoute {
  peertubeHelpers: PeerTubeHelpers
  settingsManager: PluginSettingsManager
  storage: Storage
  stripe: Stripe | null = null

  constructor (
    peertubeHelpers: PeerTubeHelpers,
    settingsManager: PluginSettingsManager,
    storage: Storage
  ) {
    this.peertubeHelpers = peertubeHelpers
    this.settingsManager = settingsManager

    this.storage = storage
  }

  private async getStripe (): Promise<Stripe> {
    if (this.stripe) {
      return this.stripe
    }

    const stripeApiKey = await this.settingsManager.getSetting(SETTING_STRIPE_API_KEY) as string
    this.stripe = new Stripe(stripeApiKey)

    return this.stripe
  }

  private async getStripeSubscription (res: express.Response, customerId: string): Promise<Stripe.Subscription | void> {
    let customer
    const stripe = await this.getStripe()

    try {
      customer = await stripe.customers.retrieve(customerId, {
        expand: ['subscriptions']
      })
    } catch (err: any) {
      this.peertubeHelpers.logger.error('Couldn\'t retrieve customer', { err })

      res.status(err.statusCode).json({
        message: err.raw?.message
      })
      return
    }

    if (customer.deleted === true || !customer.subscriptions?.data.length) {
      res.status(404).json({})
      return
    }

    const { activeSubscriptions, inactiveSubscriptions } = await getCustomerSubscriptions(
      customer,
      this.settingsManager,
      this.peertubeHelpers
    )

    if (activeSubscriptions.length > 0) {
      return activeSubscriptions[0]
    }

    return inactiveSubscriptions[0]
  }

  get = async (req: express.Request, res: express.Response): Promise<void> => {
    const stripe = await this.getStripe()
    const user = await this.peertubeHelpers.user.getAuthUser(res) as MUserDefault | undefined

    if (!user) {
      res.status(401).json({})
      return
    }

    const userInfo = await this.storage.getUserInfo(user.id)

    if (!userInfo?.customerId) {
      res.status(404).json({})
      return
    }

    let invoices

    const subscription = await this.getStripeSubscription(res, userInfo.customerId)

    if (!subscription) {
      this.peertubeHelpers.logger.info(`No subscription found for user ${String(user.id)}`)
      return
    }

    try {
      invoices = await stripe.invoices.list({
        customer: userInfo.customerId,
        limit: 12
      })
    } catch (err: any) {
      this.peertubeHelpers.logger.error('Couldn\'t retrieve invoices', { err })

      res.status(err.statusCode).json({
        message: err.raw?.message
      })
      return
    }

    const currentPeriodEnd = await getCurrentPeriodEnd(this.settingsManager, subscription)
    const sub: Subscription = {
      cancelAt: subscription?.cancel_at ? convertStripeDateToString(subscription.cancel_at) : null,
      cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? null,
      canceledAt: subscription?.canceled_at ? convertStripeDateToString(subscription.canceled_at) : null,
      currentPeriodEnd: currentPeriodEnd
        ? convertStripeDateToString(currentPeriodEnd)
        : null,
      status: subscription?.status ?? null,
      startDate: subscription?.start_date ? convertStripeDateToString(subscription.start_date) : null,
      invoices: invoices.data.map((invoice) => ({
        amountTotal: invoice.amount_paid,
        created: convertStripeDateToString(invoice.created),
        currency: invoice.currency,
        status: invoice.status,
        periodStart: convertStripeDateToString(invoice.period_start),
        periodEnd: convertStripeDateToString(invoice.period_end)
      }))
    }

    res.json(sub)
  }

  patch = async (req: express.Request, res: express.Response): Promise<void> => {
    const user = await this.peertubeHelpers.user.getAuthUser(res) as MUserDefault | undefined

    if (!user) {
      res.status(401).json({})
      return
    }

    const userInfo = await this.storage.getUserInfo(user.id)

    const stripe = await this.getStripe()

    if (!userInfo?.customerId) {
      res.status(404).json({ message: 'No customerId found for user.' })
      return
    }

    const subscription = await this.getStripeSubscription(res, userInfo.customerId)

    if (!subscription) {
      this.peertubeHelpers.logger.info(`No subscription found for user ${String(user.id)}`)
      return
    }

    this.peertubeHelpers.logger.debug('Will update stripe subscription', { body: req.body })

    try {
      await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: req.body.cancelAtPeriodEnd
      })
    } catch (err: any) {
      if (err.statusCode === 404) {
        this.peertubeHelpers.logger.warn('Subscription already deleted for user ' + String(user.id), { err })
        res.status(404).json({})
        return
      }

      this.peertubeHelpers.logger.error('Failed to retrieve subscription for user ' + String(user.id), { err })

      res.status(500).json()
      return
    }

    res.status(204).json()
  }
}
