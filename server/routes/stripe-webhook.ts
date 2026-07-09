import type { PeerTubeHelpers, PluginSettingsManager } from '@peertube/peertube-types'

import express from 'express'
import Stripe from 'stripe'
import winston from 'winston'
import {
  SETTING_STRIPE_API_KEY,
  SETTING_STRIPE_PRODUCT_ID,
  SETTING_STRIPE_WEBHOOK_SECRET
} from '../../shared/constants'
import { Storage } from '../storage'
import { getCurrentPeriodEnd, getStripeCustomerMetadataFieldNames } from '../utils'

declare global {
  namespace Express {
    export interface Request {
      rawBody: Buffer
    }
  }
}

export class StripeWebhook {
  logger: winston.Logger
  peertubeHelpers: PeerTubeHelpers
  settingsManager: PluginSettingsManager
  storage: Storage
  stripe: Stripe | null = null

  constructor (
    peertubeHelpers: PeerTubeHelpers,
    storage: Storage,
    settingsManager: PluginSettingsManager
  ) {
    this.logger = peertubeHelpers.logger
    this.peertubeHelpers = peertubeHelpers
    this.settingsManager = settingsManager

    this.storage = storage
  }

  routeHandler = async (req: express.Request, res: express.Response): Promise<void> => {
    const stripeApiKey = await this.settingsManager.getSetting(SETTING_STRIPE_API_KEY) as string

    if (!stripeApiKey) {
      this.logger.error('Can\'t handle Stripe webhook since there\'s no Stripe API key configured.')
      res.status(500).json({})
      return
    }

    if (!this.stripe) {
      this.stripe = new Stripe(stripeApiKey)
    }
    const stripe = this.stripe
    const webhookSecret = await this.settingsManager.getSetting(SETTING_STRIPE_WEBHOOK_SECRET) as string

    if (!webhookSecret) {
      this.logger.error('Can\'t parse Stripe webhook since there\'s no webhook secret configured.')
      res.status(500).json({})
      return
    }

    const sig = req.headers['stripe-signature']

    let event: Stripe.Event

    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig as string, webhookSecret)
    } catch (err: any) {
      this.logger.error(`❌ Error message: ${(err as Error).message}`)
      res.status(400).send(`Webhook Error: ${(err as Error).message}`)
      return
    }

    this.logger.debug('✅ Success: ' + event.id)

    const session = event.data.object

    this.logger.debug(`Received event ${event.type}`, event)
    this.logger.debug('Raw session: ', session)

    /**
     * TODO: Store the event in Redis to handle it later
     * https://docs.stripe.com/webhooks#acknowledge-events-immediately
     */

    // eslint-disable-next-line max-len
    // https://docs.stripe.com/billing/subscriptions/build-subscriptions?platform=web&ui=stripe-hosted#provision-and-monitor

    if (!this.isSessionOfInterest(session, event.type)) {
      res.status(200).end()

      this.logger.debug(`Received web hook event ${event.type}, exiting.`)

      return
    }

    let subscription: Stripe.Subscription

    if (this.isSessionSubscription(session, event.type)) {
      subscription = session
    } else {
      if (!('subscription' in session)) {
        res.status(200).end()
        this.logger.debug(`Received web hook event ${event.type} without subscription, exiting.`)

        return
      }

      subscription = await stripe.subscriptions
        .retrieve(session.subscription as string)
    }

    const productId = await this.settingsManager.getSetting(SETTING_STRIPE_PRODUCT_ID) as string
    const hasProductInSubcscription = subscription.items.data.some(i =>
      i.price.product === productId
    )

    if (!hasProductInSubcscription) {
      this.logger.debug('Subscription doesn\'t include product with id ' + productId)
      res.status(200).end()

      return
    }

    try {
      await this.normalizeUser(session)
    } catch (err: any) {
      this.logger.info(`Couldn't find any user based on session or email`, { err })

      res.status(200).end()
      return
    }

    if (event.type === 'checkout.session.completed' && (session as Stripe.Checkout.Session).mode === 'subscription') {
      await this.updateUserFromCheckout(session as Stripe.Checkout.Session, subscription)
    }

    if (event.type === 'invoice.paid') {
      await this.updateUserFromInvoice(session as unknown as Stripe.Invoice, subscription)
    }

    if (event.type === 'invoice.payment_failed') {
      await this.updateUserFromFailedPayment(session as unknown as Stripe.Invoice)
    }

    if (event.type === 'customer.subscription.created') {
      await this.updateUserFromSubscriptionCreated(session as Stripe.Subscription)
    }

    res.status(200).end()
  }

  private isSessionOfInterest (session: any, eventType: Stripe.Event.Type):
    session is (Stripe.Checkout.Session | Stripe.Invoice | Stripe.Subscription)
  {
    return [
      'checkout.session.completed',
      'invoice.paid',
      'invoice.payment_failed',
      'customer.subscription.created'
    ]
      .includes(eventType)
  }

  private isSessionSubscription (sess: any, eventType: Stripe.Event.Type): sess is Stripe.Subscription {
    return eventType === 'customer.subscription.created'
  }

  private async getStripe (): Promise<Stripe> {
    if (this.stripe) {
      return this.stripe
    }

    const stripeApiKey = await this.settingsManager.getSetting(SETTING_STRIPE_API_KEY) as string
    this.stripe = new Stripe(stripeApiKey)

    return this.stripe
  }

  private readonly normalizeUser =
    async (session: Stripe.Checkout.Session | Stripe.Invoice | Stripe.Subscription): Promise<void> => {
      const stripe = await this.getStripe()
      const customer = await stripe.customers.retrieve(session.customer as string)

      if (customer.deleted) {
        throw Error(`Customer ${session.customer as string} is deleted.`)
      }

      const metadataFieldName = getStripeCustomerMetadataFieldNames(this.peertubeHelpers).userId
      const userId = customer.metadata[metadataFieldName]

      if (userId !== null && !isNaN(+userId)) {
        return
      }

      if (!customer.email) {
        throw Error(`customer.metadata.${metadataFieldName} is not a number and customer has no provided email.`)
      }

      const id = await this.storage.getUserIdFromEmail(customer.email)

      if (id) {
        this.logger.info(`Adding user id ${id} to stripe customer ${customer.id}.`)
        await stripe.customers.update(customer.id, {
          metadata: {
            [metadataFieldName]: id
          }
        })
        return
      }

      throw Error(`customer.metadata.${metadataFieldName} user with email ${customer.email} doesn't exist.`)
    }

  private readonly getUserIdFromSession =
    async (session: Stripe.Checkout.Session | Stripe.Invoice | Stripe.Subscription): Promise<number> => {
      const stripe = await this.getStripe()
      const customer = await stripe.customers.retrieve(session.customer as string)

      if (customer.deleted) {
        throw Error(`Customer ${session.customer as string} is deleted`)
      }

      const metadataFieldName = getStripeCustomerMetadataFieldNames(this.peertubeHelpers).userId
      const userId = customer.metadata[metadataFieldName]

      if (userId === null) {
        throw Error(`customer.metadata.${metadataFieldName} is null.`)
      }

      const parsedId = +userId

      if (isNaN(parsedId)) {
        throw Error(`customer.metadata.${metadataFieldName} is not a number: ' + userI`)
      }

      return parsedId
    }

  private readonly updateUserFromFailedPayment = async (session: Stripe.Invoice): Promise<void> => {
    const userId = await this.getUserIdFromSession(session)
    const userInfo = await this.storage.getUserInfo(userId) ?? {}

    userInfo.hasPaymentFailed = true

    await this.storage.storeUserInfo(userId, userInfo)
  }

  private readonly updateUserFromInvoice =
    async (session: Stripe.Invoice, subscription: Stripe.Subscription): Promise<void> => {
      const userId = await this.getUserIdFromSession(session)
      const userInfo = await this.storage.getUserInfo(userId) ?? {}

      userInfo.paidUntil = new Date(await getCurrentPeriodEnd(this.settingsManager, subscription) * 1000).toISOString()
      userInfo.hasPaymentFailed = false

      await this.storage.storeUserInfo(userId, userInfo)
    }

  private readonly updateUserFromCheckout =
    async (session: Stripe.Checkout.Session, subscription: Stripe.Subscription): Promise<void> => {
      const userId = await this.getUserIdFromSession(session)
      const userInfo = await this.storage.getUserInfo(userId) ?? {}

      userInfo.paidUntil = new Date(await getCurrentPeriodEnd(this.settingsManager, subscription) * 1000).toISOString()
      userInfo.customerId = session.customer as string
      userInfo.subscriptionId = session.subscription as string
      userInfo.hasPaymentFailed = false

      await this.storage.storeUserInfo(userId, userInfo)
    }

  private readonly updateUserFromSubscriptionCreated =
    async (subscription: Stripe.Subscription): Promise<void> => {
      const userId = await this.getUserIdFromSession(subscription)
      const userInfo = await this.storage.getUserInfo(userId) ?? {}

      userInfo.paidUntil = new Date(await getCurrentPeriodEnd(this.settingsManager, subscription) * 1000).toISOString()
      userInfo.customerId = subscription.customer as string
      userInfo.subscriptionId = subscription.id as string
      userInfo.hasPaymentFailed = false

      await this.storage.storeUserInfo(userId, userInfo)
    }
}
