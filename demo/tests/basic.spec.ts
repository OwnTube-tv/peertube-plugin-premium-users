import { test, expect, Page } from '@playwright/test';
import Stripe from 'stripe'
import { VIDEO_FIELD_IS_PREMIUM_CONTENT } from '../../shared/constants'

const PAGE_URL = 'http://localhost:9000'

/**
 * Assert the plugin's protection contract for the premium video on the
 * current watch page, via the video API — deterministic and independent of
 * whether the browser can actually decode the HLS stream:
 *
 * - non-premium viewers get the replacement video's streaming playlists
 * - premium viewers get the video's own streaming playlists
 * - downloads are disabled and torrent URLs stripped for everyone
 */
const expectVideoStream = async (page: Page, { premium, token }: { premium: boolean, token?: string }) => {
  await page.waitForURL(/\/w\//, { timeout: 5_000 })
  const shortUUID = page.url().match(/\/w\/([^/?#]+)/)?.[1] as string
  expect(shortUUID).toBeTruthy()

  const response = await page.request.get(`${PAGE_URL}/api/v1/videos/${shortUUID}`, {
    headers: token ? { Authorization: 'Bearer ' + token } : {}
  })
  expect(response.ok()).toBe(true)

  const video = await response.json()
  expect(video.pluginData?.[VIDEO_FIELD_IS_PREMIUM_CONTENT]).toBe('true')
  expect(video.streamingPlaylists.length).toBeGreaterThan(0)

  for (const playlist of video.streamingPlaylists) {
    if (premium) {
      expect(playlist.playlistUrl).toContain(video.uuid)
    } else {
      expect(playlist.playlistUrl).not.toContain(video.uuid)
    }

    for (const file of playlist.files ?? []) {
      expect(file.torrentUrl).toBeFalsy()
    }
  }

  expect(video.downloadEnabled).toBe(false)
}

const disableModals = async (page: Page) => {
  return page.route('**/api/v1/users/me', async route => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...body,
        noAccountSetupWarningModal: true,
        noInstanceConfigWarningModal: true,
        noWelcomeModal: true
      }),
      headers: response.headers()
    })
  })
}

const login = async (page: Page, username: string, password: string) => {
  await page.goto(PAGE_URL + '/login')
  await page.getByLabel(/username/i).fill(username)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /login/i }).click()
}

// The access token shows up in localStorage right after login has succeeded.
const waitUntilUsersIsAuthenticated = async (page: Page): Promise<string> => {
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    const { origins } = await page.request.storageState()
    const { localStorage } = origins.find(o => o.origin.match(new RegExp(PAGE_URL))) || {}
    const token = localStorage?.find(s => s.name === 'access_token')?.value

    if (token) {
      return token
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error('No access_token appeared in localStorage within 5s — login failed?')
}

// Premium status arrives via the Stripe webhook roundtrip, which takes a few
// seconds through `stripe listen`.
const waitUntilUserIsPremium = async (page: Page) => {
  const token = await waitUntilUsersIsAuthenticated(page)
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const response = await page.request.get(`${PAGE_URL}/plugins/premium-users/router/subscription`, {
      headers: {
        Authorization: 'Bearer ' + token
      }
    })

    if (response.ok()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error('The /subscription endpoint never returned HTTP 200 within 15s — webhook not processed?')
}

test.describe('anonymous user', () => {
  test('loads replacement video', async ({ page }) => {
    await page.goto(PAGE_URL);

    await page.getByText('Premium video').click()

    await expectVideoStream(page, { premium: false })
  })
})

// Sign up a new account via the plugin's "Become premium" page and land on
// the premium payment alternatives page.
const signupViaBecomePremium = async (
  page: Page,
  { name, email, password }: { name: string, email: string, password: string }
): Promise<void> => {
  await page.goto(PAGE_URL)

  // The plugin registers its client route asynchronously; clicking the menu
  // item before that leaves the SPA on the home page, so retry until the
  // premium page has loaded.
  await expect(async () => {
    await page.getByText('Become premium').click()
    await page.waitForURL(/\/p\/premium/, { timeout: 2000 })
  }).toPass()

  await page.getByTestId('premium_users-button-create_account').click()

  await page.waitForURL(/signup/i)

  await page.getByRole('button', { name: 'Create an account' }).click()

  await page.getByText(/I am at least/i).click()
  await page.getByText(/go to the next step/i).click()

  await page.getByLabel(/public name/i).fill(name)
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)

  await page.getByText(/go to the next step/i).click()

  await page.getByText(/I don't want to create a channel/i).click()
  await page.waitForURL(/premium/i)
}

// Fill in and submit the Stripe Checkout page with the standard test card,
// then wait for the premium confirmation back on the instance.
const completeStripeCheckout = async (page: Page, cardholderName: string): Promise<void> => {
  // Stripe Checkout renders differently depending on the visitor's region:
  // either a payment method accordion precedes the card fields (e.g. Card +
  // Klarna for Swedish visitors), or the card fields are visible directly.
  const cardNumber = page.getByLabel(/card number/i)
  const cardAccordion = page.getByTestId('card-accordion-item-button')
  await cardNumber.or(cardAccordion).first().waitFor({ state: 'attached' })

  if (await cardNumber.count() === 0) {
    // The accordion button never passes actionability checks, so dispatch
    // the click programmatically.
    await cardAccordion.dispatchEvent('click')
  }

  await cardNumber.fill('4242 4242 4242 4242')
  await page.getByLabel(/expiration/i).fill('05/32')
  await page.getByPlaceholder(/cvc/i).fill('123')
  await page.getByPlaceholder(/full name/i).fill(cardholderName)

  // "Save my information" is sometimes pre-checked and then demands a phone
  // number (whose country-code select also shadows the billing country
  // field) — opt out before touching the country selector.
  const saveInfo = page.getByRole('checkbox', { name: /save my information/i })
  if (await saveInfo.count() > 0 && await saveInfo.isChecked()) {
    await saveInfo.dispatchEvent('click')
  }

  await page.getByLabel(/country or region/i).selectOption('Sweden')
  await page.getByTestId('hosted-payment-submit-button').click()

  // Stripe processes the payment (or, for trials, a setup intent) before
  // redirecting back — legitimately slower than a page navigation
  await page.waitForURL(/premium/i, { timeout: 20_000 })
  // Premium status lands via the Stripe webhook roundtrip — also
  // legitimately slower than a few seconds
  await page.getByText(/you're a premium/i).waitFor({ timeout: 20_000 })
}

test.describe('authenticated user', () => {
  test.describe.configure({ mode: 'serial' });
  test.describe.configure({ timeout: 60000 }) // Increase timeout to handle Stripe checkout

  const TEST_ID = Math.round(Date.now() / 1000)
  const NAME = 'John Premium ' + TEST_ID
  const EMAIL = `john${TEST_ID}@premi.um`
  const PASSWORD = 'testtest'

  test.beforeEach(async ({ page }) => {
    await disableModals(page)
  })

  test('becomes a premium user', async ({ page }) => {
    await signupViaBecomePremium(page, { name: NAME, email: EMAIL, password: PASSWORD })

    await page.getByTestId('premium_users-button-pay_month').click()

    await completeStripeCheckout(page, 'John Premium')
  })

  test('loads premium video', async ({ page }) => {
    await login(page, EMAIL, PASSWORD)

    const token = await waitUntilUsersIsAuthenticated(page)

    await page.getByRole('navigation').getByText('Home').click()

    await page.getByText(/premium video/i).click()

    await expectVideoStream(page, { premium: true, token })
  })
})

test.describe('trial user', () => {
  test.describe.configure({ mode: 'serial' });
  test.describe.configure({ timeout: 60000 }) // Increase timeout to handle Stripe checkout

  const stripe = new Stripe(process.env.STRIPE_API_KEY as string)
  const TEST_ID = Math.round(Date.now() / 1000)
  const NAME = 'Tina Trial ' + TEST_ID
  const EMAIL = `trial${TEST_ID}@premi.um`
  const PASSWORD = 'testtest'

  test.beforeEach(async ({ page }) => {
    await disableModals(page)
  })

  test('starts a free trial on the yearly price', async ({ page }) => {
    await signupViaBecomePremium(page, { name: NAME, email: EMAIL, password: PASSWORD })

    // The demo configures the yearly price with a 14 day free trial and no
    // coupon — the offer is presented instead of a discount
    await page.getByText(/first 14 days free/i).waitFor()

    await page.getByTestId('premium_users-button-pay_year').click()

    await completeStripeCheckout(page, 'Tina Trial')

    // Premium right away, backed by a trialing subscription with no charge
    const token = await waitUntilUsersIsAuthenticated(page)
    const subscriptionRes = await page.request.get(`${PAGE_URL}/plugins/premium-users/router/subscription`, {
      headers: { Authorization: 'Bearer ' + token }
    })
    expect(subscriptionRes.ok()).toBe(true)
    expect((await subscriptionRes.json()).status).toBe('trialing')

    const { data: [customer] } = await stripe.customers.list({ email: EMAIL, expand: ['data.subscriptions'] })
    expect(customer, 'Customer exists in Stripe').toBeTruthy()
    expect(customer.subscriptions?.data[0]?.status).toBe('trialing')
  })

  test('loads premium video during the trial', async ({ page }) => {
    await login(page, EMAIL, PASSWORD)

    const token = await waitUntilUsersIsAuthenticated(page)

    await page.getByRole('navigation').getByText('Home').click()

    await page.getByText(/premium video/i).click()

    await expectVideoStream(page, { premium: true, token })
  })
})

test.describe('add premium user via Stripe', () => {
  test.describe.configure({ mode: 'serial' });
  const stripe = new Stripe(process.env.STRIPE_API_KEY as string)
  const TEST_ID = Math.round(Date.now() / 1000)
  const EMAIL = `external${TEST_ID}@premi.um`
  const PASSWORD = 'testtest'

  test.beforeEach(async ({ page }) => {
    await disableModals(page)
  })

  test('setup user and add subscription in Stripe', async ({ page }) => {
    await login(page, 'root', process.env.PT_INITIAL_ROOT_PASSWORD as string)

    await page.getByRole('navigation').getByText(/overview/i).click()
    await page.getByText(/create user/i).click()

    await page.getByLabel(/username/i).fill('external_premium' + TEST_ID)
    await page.getByLabel(/channel name/i).fill('external_premium_channel' + TEST_ID)
    await page.getByLabel(/email/i).fill(EMAIL)
    await page.getByLabel(/password/i).fill(PASSWORD)
    await page.getByText(/create user/i).click()

    // Pin the subscription to the plugin's test product — the sandbox is
    // shared, so picking the first recurring price in the account could grab
    // an unrelated product.
    const { data: [product] } = await stripe.products.search({
      query: 'name:"peertube_plugin_premium_users-auto_test-product"'
    })
    expect(product, 'Plugin test product exists in Stripe (created by prepare-plugin)').toBeTruthy()

    const prices = await stripe.prices.list({ product: product.id, type: 'recurring' })
    expect(prices.data.length, 'Plugin test product has at least one recurring price').toBeGreaterThan(0)

    const customer = await stripe.customers.create({ email: EMAIL })
    await stripe.subscriptions.create({
      customer: customer.id,
      billing_cycle_anchor: Math.round((Date.now() / 1000) + (3600 * 24 * 5)),
      proration_behavior: 'none',
      items: [
        {
          price: prices.data[0].id
        }
      ]
    })
  })

  test('user should be premium when added via Stripe', async ({ page }) => {
    await login(page, EMAIL, PASSWORD)

    await waitUntilUserIsPremium(page)
    await page.goto(PAGE_URL + '/my-account/p/premium')

    await page.getByText(/you're a premium/i).waitFor()

    const token = await waitUntilUsersIsAuthenticated(page)

    await page.getByRole('navigation').getByText(/Home/i).click()
    await page.getByText('Premium video').click()

    await expectVideoStream(page, { premium: true, token })
  })

  test('Stripe subscription should be canceled when Peertube account is deleted', async ({ page }) => {
    await login(page, 'root', process.env.PT_INITIAL_ROOT_PASSWORD as string)
    await waitUntilUsersIsAuthenticated(page)

    await page.goto(PAGE_URL + '/a/external_premium' + TEST_ID + '/video-channels')
    await page.getByLabel('Open actions').click()
    await page.getByText('Delete user').click()
    await page.getByText('Confirm').click()

    const deadline = Date.now() + 10_000

    while (true) {
      const { data: [customer] } = await stripe.customers.list({
        email: EMAIL,
        expand: ['data.subscriptions'],
      })

      expect(customer, 'Deleted user exists in Stripe').toBeTruthy()

      const canceled = customer.subscriptions?.data.length === 0 &&
        Object.keys(customer.metadata).some(key => key.match(/deletedAt/i))

      if (canceled) {
        break
      }

      if (Date.now() > deadline) {
        throw new Error('Stripe subscription was not canceled within 10s of account deletion')
      }

      await new Promise(resolve => setTimeout(resolve, 500))
    }
  })
})
