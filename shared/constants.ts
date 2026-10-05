export const SETTING_ENABLE_PLUGIN = 'enable-plugin'
export const SETTING_STRIPE_API_KEY = 'stripe-api-key'
export const SETTING_STRIPE_CUSTOMER_PORTAL_URL = 'stripe-customer-portal-url'
export const SETTING_STRIPE_COUPON_ID = 'stripe-coupon-id'
export const SETTING_STRIPE_PRODUCT_ID = 'stripe-product-id'
export const SETTING_STRIPE_WEBHOOK_SECRET = 'stripe-webhook-secret'
export const SETTING_REPLACEMENT_VIDEO = 'replacement-video-url'
export const SETTING_WHITELIST_USER_AGENT = 'whitelist-user-agent'
export const SETTING_PRICE_SORT_ORDER = 'price-sort-order'
export const UNSUBSCRIBE_FORM_EMBED_CODE = 'unsubscribe-form-embed-code'
export const VIDEO_FIELD_IS_PREMIUM_CONTENT = 'is-premium-content'

export const PRICE_SORT_LOWEST_FIRST = 'lowest-first'
export const PRICE_SORT_HIGHEST_FIRST = 'highest-first'

export const SETTING_STRIPE_COUPON_ID_PRICE_PREFIX = 'stripe-coupon-id-price-'
export const SETTING_STRIPE_TRIAL_DAYS_PRICE_PREFIX = 'stripe-trial-days-price-'

// Per-price coupon override value meaning "no coupon at all", as opposed to
// '' which means "inherit the default coupon setting"
export const PRICE_COUPON_NONE = 'none'

export const getPriceCouponSettingName = (priceId: string): string =>
  SETTING_STRIPE_COUPON_ID_PRICE_PREFIX + priceId

export const getPriceTrialDaysSettingName = (priceId: string): string =>
  SETTING_STRIPE_TRIAL_DAYS_PRICE_PREFIX + priceId
