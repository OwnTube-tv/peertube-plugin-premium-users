import { RegisterClientHelpers } from '@peertube/peertube-types/client'
import { UiBuilder } from '../ui/ui-builder'
import { Api } from '../api'
import { getDiscountedPrice, trackGAAction } from '../utils'
import { getFormattedPaymentAlternatives } from '../ui/utils'

export const renderNonPremiumPage = async ({
  peertubeHelpers,
  rootEl
}: {
  peertubeHelpers: RegisterClientHelpers
  rootEl: HTMLElement
}): Promise<void> => {
  const restApi = new Api(peertubeHelpers.getAuthHeader)
  const { translate } = peertubeHelpers
  const uiBuilder = new UiBuilder(rootEl)
  const prices = await restApi.getPrices()

  trackGAAction('view_item_list', {
    items: prices.map((price) => ({
      item_id: price.product as string,
      item_name: 'Premium subscription',
      item_variant: price.recurring?.interval,
      price: price.unit_amount ?? 0,
      discount: price.unit_amount ? price.unit_amount - (getDiscountedPrice(price) ?? 0) : 0,
      coupon: price.coupon?.name ?? undefined,
      quantity: 1
    }))
  })

  const columns = await Promise.all(prices.map(async (price) => {
    const discountedPrice = getDiscountedPrice(price)

    const buttonOnClick = (event: MouseEvent) => {
      const thisElem = event.target as HTMLElement
      thisElem.setAttribute('disabled', 'disabled')
      trackGAAction('add_to_cart', {
        value: discountedPrice === null ? (price.unit_amount ?? 0) / 100 : discountedPrice,
        currency: price.currency,
        items: [
          {
            item_id: price.product as string,
            item_name: 'Premium subscription',
            item_variant: price.recurring?.interval,
            price: price.unit_amount ?? 0,
            discount: price.unit_amount ? price.unit_amount - (discountedPrice ?? 0) : 0,
            coupon: price.coupon?.name ?? undefined,
            quantity: 1
          }
        ]
      })

      restApi.createCheckout({
        allowPromotionCodes: !!(new URLSearchParams(window.location.search).get('allowPromotionCodes')),
        priceId: price.id
      })
        .then(({ checkoutUrl }: { checkoutUrl: string }) => {
          window.location.href = checkoutUrl
        })
        .catch(async err => {
          peertubeHelpers.showModal({
            title: await translate('Something went wrong'),
            content: await translate(
              'Couldn\'t create subcsription due to technical issues. Please try again later.'
            ),
            close: true
          })

          console.error('Couldn\'t create checkout', { err })
        })
        .finally(() => {
          thisElem.removeAttribute('disabled')
        })
    }

    return getFormattedPaymentAlternatives({ buttonOnClick, price, uiBuilder, translate })
  }))

  rootEl.appendChild(
    uiBuilder.renderRow(
      [uiBuilder.h2(await translate('Become premium'))],
      [
        uiBuilder.p(
          await translate(
            'As a premium user you\'ll get access to premium videos and helps us to continue our work.'
          )
        )
      ]
    )
  )

  rootEl.appendChild(
    uiBuilder.renderRow(
      [],
      [uiBuilder.div(
        columns.map((c) => uiBuilder.div([c], 'col-12 col-sm-6 d-flex')), 'row'
      )]
    )
  )
}
