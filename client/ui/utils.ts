import { Price } from '../../shared/types'
import { formatAmount, getDiscountedPrice } from '../utils'
import { UiBuilder } from './ui-builder'

const getDiscount = (price: Price): string => price.coupon?.percent_off
  ? `${price.coupon.percent_off} %`
  : formatAmount(price.coupon?.amount_off ?? 0, price.currency)

const getDiscountLengthDesc = async (price: Price, translate: any): Promise<string> => {
  if (price.recurring?.interval === 'month') {
    return (await translate('discount the first MONTHS_COUNT months.'))
      .replace('MONTHS_COUNT', String(price.coupon?.duration_in_months))
  } else if (price.recurring?.interval === 'year') {
    return translate('discount for a whole year.')
  }

  return ''
}

const getAmountToSave = (price: Price): number => {
  let amountToSave = 0

  if (price.recurring?.interval === 'month') {
    if (price.unit_amount && price.coupon?.amount_off && price.coupon?.duration_in_months) {
      amountToSave = (price.coupon.amount_off * price.coupon?.duration_in_months) / 100
    }

    if (price.unit_amount && price.coupon?.percent_off && price.coupon?.duration_in_months) {
      amountToSave = (
        (price.unit_amount * (price.coupon.percent_off / 100)) *
          price.coupon?.duration_in_months
      ) / 100
    }
  } else if (price.recurring?.interval === 'year') {
    if (price.unit_amount && price.coupon?.amount_off) {
      amountToSave = (price.coupon.amount_off * 12) / 100
    }

    if (price.unit_amount && price.coupon?.percent_off) {
      amountToSave = (
        (price.unit_amount * (price.coupon.percent_off / 100))
      ) / 100
    }
  }

  return amountToSave
}

const getFormattedPrice = async (price: Price, translate: (str: string) => Promise<string>): Promise<string> => {
  const discountedPrice = getDiscountedPrice(price)
  let label

  if (discountedPrice !== null) {
    label = `
        <span class="original-price">
        ${formatAmount(price.unit_amount as number / 100, price.currency)}</span>
        ${formatAmount(discountedPrice, price.currency)}`
  } else {
    label = formatAmount(price.unit_amount as number / 100, price.currency)
  }

  if (price.recurring?.interval) {
    label += ' / ' + await translate(price.recurring.interval)
  }

  return label
}

export const getFormattedPaymentAlternatives = async (
  {
    buttonOnClick,
    price,
    uiBuilder,
    translate
  }: {
    buttonOnClick?: (event: MouseEvent) => void,
    price: Price,
    uiBuilder: UiBuilder,
    translate: (str: string) => Promise<string>
  }): Promise<HTMLElement> => {
  const discountedPrice = getDiscountedPrice(price)
  const discountForHowLongDesc = await getDiscountLengthDesc(price, translate)
  const amountToSave = getAmountToSave(price)
  const discount = getDiscount(price)
  const formattedPrice = await getFormattedPrice(price, translate)
  const hasTrial = !price.coupon && !!price.trialDays
  const hasButton = !!buttonOnClick

  const button = uiBuilder.a(hasTrial ? await translate('Start free trial') : formattedPrice, {
    class: 'primary-button peertube-button-link mb-4',
    'data-testid': `premium_users-button-pay_` + price.recurring?.interval
  })

  if (hasButton) {
    button.addEventListener('click', buttonOnClick)
  }

  return uiBuilder.div([
    uiBuilder.p(
      await translate('Pay ' +
        (price.recurring?.interval === 'day' ? 'daily' : price.recurring?.interval as string + 'ly')
      ),
      'fw-bold'
    ),
    ...(discountedPrice === null
      ? []
      : [uiBuilder.ul([
        discount + ' ' + discountForHowLongDesc,
        (await translate('You\'ll save AMOUNT_TO_SAVE.'))
          .replace('AMOUNT_TO_SAVE', String(formatAmount(Math.round(amountToSave), price.currency)))
      ], 'text-start')]),
    ...(hasTrial
      ? [uiBuilder.ul([
        (await translate('First TRIAL_DAYS days free, then PRICE.'))
          .replace('TRIAL_DAYS', String(price.trialDays))
          .replace('PRICE', formattedPrice)
      ], 'text-start')]
      : []),
    ...(hasButton ? [button] : [
      uiBuilder.p(formattedPrice, 'mt-auto')
    ])
  ], 'd-flex flex-grow-1 flex-column')
}
