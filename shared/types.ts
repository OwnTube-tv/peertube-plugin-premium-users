import Stripe from 'stripe'

export interface Price extends Stripe.Price {
  coupon?: Stripe.Coupon
  trialDays?: number
}
