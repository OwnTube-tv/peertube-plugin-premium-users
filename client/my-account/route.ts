import { RegisterClientHelpers } from '@peertube/peertube-types/client'
import { Api } from '../api'
import { renderPremiumPage } from './premium-user'
import { renderNonPremiumPage } from './non-premium-user'
import { trackGAAction } from '../utils'
import { MyUser } from '@peertube/peertube-types'

export const buildOnMount = (peertubeHelpers: RegisterClientHelpers) =>
  async ({ rootEl }: { rootEl: HTMLElement }): Promise<void> => {
    const { translate } = peertubeHelpers
    const restApi = new Api(peertubeHelpers.getAuthHeader)
    rootEl.className = 'plugin-premium-users my-account'

    const searchParams = new URLSearchParams(window.location.search)

    if (searchParams.get('checkout_status') === 'success') {
      trackGAAction('purchase')

      peertubeHelpers.showModal({
        title: await translate('Payment succeeded'),
        cancel: {
          value: await translate('Close')
        },
        content: await translate(
          'Your payment succeeded and will be registered shortly. It may take a while depending on your payment method.'
        ),
        close: true
      })
    }

    const subscription = await restApi.getSubscription()
    const user = await peertubeHelpers.getUser() as MyUser & { isPremium: boolean }

    if (user.isPremium) {
      await renderPremiumPage({ peertubeHelpers, rootEl, subscription })
    } else {
      await renderNonPremiumPage({ peertubeHelpers, rootEl })
    }
  }
