import { RegisterClientHelpers } from '@peertube/peertube-types/client'
import { Subscription, SubscriptionInvoice } from '../../server/types'
import { SETTING_STRIPE_CUSTOMER_PORTAL_URL, UNSUBSCRIBE_FORM_EMBED_CODE } from '../../shared/constants'
import { Api } from '../api'
import { UiBuilder } from '../ui/ui-builder'

const formatDate = (date: string | number): string => {
  const d = new Date(date)

  return d.toLocaleDateString('sv-SE')
}

export const renderPremiumPage = async ({
  peertubeHelpers,
  rootEl,
  subscription
}: {
  peertubeHelpers: RegisterClientHelpers
  rootEl: HTMLElement
  subscription: Subscription
}): Promise<void> => {
  const { translate } = peertubeHelpers
  const restApi = new Api(peertubeHelpers.getAuthHeader)
  const uiBuilder = new UiBuilder(rootEl)

  const paymentStatus = []
  let subscriptionDesc
  let cancelButtonText

  if (subscription.cancelAtPeriodEnd) {
    subscriptionDesc = await translate(
      'Subscription will not be renewed and will end at '
    ) +
    formatDate(subscription.cancelAt as string) + '.'
    cancelButtonText = await translate('Resume subscription')
  } else {
    subscriptionDesc = await translate('Subscription will be renewed at ') +
    formatDate((subscription.currentPeriodEnd as string)) +
    '.'
    cancelButtonText = await translate('Cancel subscription')
  }

  const cancelButton = uiBuilder.a(cancelButtonText, {
    class: 'grey-button peertube-button-link'
  })

  cancelButton.addEventListener('click', (): void => {
    cancelButton.setAttribute('disabled', 'disabled')
    /**
     * TODO: Add loader
     */

    restApi.updateSubscription({
      cancelAtPeriodEnd: !subscription.cancelAtPeriodEnd
    })
      .then(async () => {
        const settings = await peertubeHelpers.getSettings()
        const embedCode = settings[UNSUBSCRIBE_FORM_EMBED_CODE]

        if (!subscription.cancelAtPeriodEnd && embedCode) {
          const formElem = document.createElement('div')
          formElem.innerHTML = embedCode.toString()
          rootEl.prepend(uiBuilder.renderRow([uiBuilder.h2(await translate('Why did you unsubscribe?'))], [formElem]))

          return
        }

        /**
         * TODO: Repaint instead of page reload
         */
        window.location.reload()
      })
      .catch(async (err: any) => {
        peertubeHelpers.showModal({
          title: await translate('Something went wrong'),
          content: await translate(
            'Couldn\'t cancel subcsription due to technical issues. Please try again later.'
          ),
          close: true
        })
        console.error('Couldn\'t cancel subscription', { err })
      })
  })

  const settings = await peertubeHelpers.getSettings()
  const manageButton = uiBuilder.a(await translate('Manage subscription'), {
    class: 'grey-button peertube-button-link',
    href: settings[SETTING_STRIPE_CUSTOMER_PORTAL_URL] as string,
    target: '_blank'
  })

  paymentStatus.push(
    uiBuilder.p(
      await translate('You\'re a premium user.') + ' ' + subscriptionDesc
    ),
    manageButton,
    cancelButton
  )

  rootEl.appendChild(
    uiBuilder.renderRow(
      [uiBuilder.h2(await translate('Status'))],
      paymentStatus
    )
  )

  const renderInvoiceList = async (payments: SubscriptionInvoice[]): Promise<HTMLElement[]> =>
    Promise.all(payments.map(async (payment) =>
      uiBuilder.div([
        uiBuilder.renderRow(
          [uiBuilder.p(formatDate(payment.created), 'mb-2 fw-bold')]
        ),
        uiBuilder.renderRow(
          [uiBuilder.p(await translate('Sum'))],
          [uiBuilder.p(`${(payment.amountTotal ?? 0) / 100} ${payment.currency.toUpperCase()}`)]
        ),
        uiBuilder.renderRow(
          [uiBuilder.p(await translate('Status'))],
          [uiBuilder.p(await translate(payment.status ?? 'Canceled'))]
        )
      ])
    ))

  rootEl.appendChild(uiBuilder.renderRow(
    [uiBuilder.h2(await translate('Payment history'))],
    await renderInvoiceList(subscription.invoices ?? [])
  ))
}
