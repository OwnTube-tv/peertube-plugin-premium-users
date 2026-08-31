import { RegisterClientRouteOptions } from '@peertube/peertube-types'
import { RegisterClientHelpers, RegisterClientOptions } from '@peertube/peertube-types/client';
import { UiBuilder } from './ui/ui-builder'
import { SETTING_ENABLE_PLUGIN } from '../shared/constants'
import { trackGAAction } from './utils'
import { getFormattedPaymentAlternatives } from './ui/utils';
import { Api } from './api';

export async function register ({
  peertubeHelpers,
  registerClientRoute,
  registerHook
}: RegisterClientOptions & {
  peertubeHelpers: RegisterClientHelpers & {
    getUser: any
  }
  registerClientRoute: (options: RegisterClientRouteOptions & {
    menuItem?: {
      label: string
    }
    title: string
    parentRoute?: string
  }) => any
}): Promise<void> {
  registerHook({
    target: 'filter:left-menu.links.create.result',
    handler: async (items: Array<{ key: string, links: any[] }>) => {
      const settings = await peertubeHelpers.getSettings()

      if (!settings[SETTING_ENABLE_PLUGIN]) {
        return items
      }

      const user = peertubeHelpers.getUser()
      const premiumLink = peertubeHelpers.isLoggedIn() ? '/my-account/p/premium' : '/p/premium'
      const premiumLabel = await peertubeHelpers.translate(user?.isPremium ? 'Premium account' : 'Become premium')

      return items.map((subMenu) => {
        if (subMenu.key === 'quick-access') {
          return {
            ...subMenu,
            links: [
              ...subMenu.links,
              {
                path: premiumLink,
                icon: user?.isPremium ? 'premium' : undefined,
                label: premiumLabel,
                shortLabel: premiumLabel,
                isPrimaryButton: !user?.isPremium,
              },
            ]
          }
        }

        return subMenu
      })
    }
  })

  registerHook({
    target: 'action:router.navigation-end',
    handler: async ({ path }: { path: string }) => {
      if (['/my-account/settings', '/my-account'].includes(path)) {
        const user = peertubeHelpers.getUser()
        const t = peertubeHelpers.translate

        if (user.isPremium) return

        const textareaElem = document.querySelector('#plugin-selector-profile-form-description-field-group textarea')

        if (!textareaElem) {
          console.warn('Couldn\'t find textarea.')
          return
        }

        textareaElem.setAttribute('disabled', 'true')
        textareaElem.setAttribute('placeholder', await t('Profile description is only available for premium users.'))
      }
    }
  })

  registerHook({
    target: 'filter:internal.common.svg-icons.get-content.result',
    handler: (result: string, icon: { name: string }) => {
      if (icon.name === 'premium') {
        /* eslint-disable max-len */
        return `
          <svg
            fill="gray"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
            viewBox="0 0 45.402 45.402"
            xml:space="preserve">
            <g>
              <path d="M41.267,18.557H26.832V4.134C26.832,1.851,24.99,0,22.707,0c-2.283,0-4.124,1.851-4.124,4.135v14.432H4.141
           c-2.283,0-4.139,1.851-4.138,4.135c-0.001,1.141,0.46,2.187,1.207,2.934c0.748,0.749,1.78,1.222,2.92,1.222h14.453V41.27
           c0,1.142,0.453,2.176,1.201,2.922c0.748,0.748,1.777,1.211,2.919,1.211c2.282,0,4.129-1.851,4.129-4.133V26.857h14.435
           c2.283,0,4.134-1.867,4.133-4.15C45.399,20.425,43.548,18.557,41.267,18.557z"/>
           </g>
         </svg>`
        /* eslint-enable max-len */
      }

      return result
    }
  })

  const handleRegisterRedirect = (origin: string): Function => (): void => {
    const redirect = new URLSearchParams(window.location.search).get('redirect')

    if (redirect) {
      registerHook({
        target: 'action:auth-user.logged-in',
        handler: () => {
          trackGAAction('tutorial_complete', {
            event_label: origin
          })

          window.location.href = redirect
        }
      })
    }
  }

  registerHook({
    target: 'action:login.init',
    handler: handleRegisterRedirect('login')
  })

  registerHook({
    target: 'action:signup.register.init',
    handler: handleRegisterRedirect('signup')
  })

  registerClientRoute({
    route: '/premium',
    title: await peertubeHelpers.translate('Become premium'),
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    onMount: async ({ rootEl }) => {
      if (peertubeHelpers.isLoggedIn()) {
        window.location.href = '/my-account/p/premium'
        return
      }

      trackGAAction('tutorial_begin')
      const restApi = new Api()

      const prices = await restApi.getPrices()
      const uiBuilder = new UiBuilder(rootEl)
      const pricingColumns = await Promise.all(
        prices.map((price) =>
          getFormattedPaymentAlternatives({ price, uiBuilder, translate: peertubeHelpers.translate })
        )
      )

      const instanceBanner = (await peertubeHelpers.getServerConfig()).instance.banners
        .sort((a, b) => a.width - b.width).find(b => b.width <= 800)

      const wrapper = uiBuilder.div(
        [
          instanceBanner?.fileUrl ? uiBuilder.img(instanceBanner.fileUrl, 'instance-logo') : null,
          uiBuilder.h2(await peertubeHelpers.translate('Become a premium user')),
          uiBuilder.p(await peertubeHelpers.translate(
            'Get access to premium videos and helps us to continue our work.'
          )),
          uiBuilder.div(
            pricingColumns.map((c) => uiBuilder.div([c], 'col-12 col-sm-6 d-flex')),
            'prices-alternatives row my-5 mx-auto'
          ),
          uiBuilder.div([
            uiBuilder.a(await peertubeHelpers.translate('Create an account'), {
              class: 'primary-button peertube-button-link button-md mb-2',
              href: '/signup?redirect=/my-account/p/premium',
              'data-testid': 'premium_users-button-create_account'
            }),
            uiBuilder.p(await peertubeHelpers.translate('or'), 'mb-0'),
            uiBuilder.a(await peertubeHelpers.translate('Login'), {
              class: 'secondary-button peertube-button-link mt-2 button-md',
              href: '/login?redirect=/my-account/p/premium'
            })
          ], 'action-buttons d-flex justify-content-center flex-column mb-4 mx-sm-auto')
        ].filter(r => !!r),
        'plugin-premium-users become-premium margin-content pt-4 text-center mx-auto px-4 px-md-0'
      )

      rootEl.appendChild(wrapper)
    }
  })
}
