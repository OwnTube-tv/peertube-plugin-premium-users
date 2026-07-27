import { MyUser } from '@peertube/peertube-types'
import packageJson from '../package.json'
import { Subscription } from '../server/types'
import { Price } from '../shared/types'

export class Api {
  getAuthHeader: () => { Authorization: string } | undefined
  pluginBasePath = `/plugins/${packageJson.name.replace('peertube-plugin-', '')}/router`

  constructor (getAuthHeader?: () => { Authorization: string } | undefined) {
    this.getAuthHeader = getAuthHeader ? getAuthHeader : () => undefined
  }

  private async get<P>(path: string): Promise<P> {
    return fetch(path, {
      method: 'GET',
      headers: this.getAuthHeader()
    }).then(async res => res.json())
  }

  private async patch (path: string, body: any): Promise<void> {
    await fetch(path, {
      method: 'PATCH',
      headers: {
        ...this.getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }

  private async post (path: string, body?: any): Promise<any> {
    return fetch(path, {
      method: 'POST',
      headers: {
        ...this.getAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
      .then(async res => res.json())
  }

  async getMe (): Promise<MyUser> {
    return this.get<MyUser>('/api/v1/users/me')
  }

  async getPrices (): Promise<Price[]> {
    return this.get(this.pluginBasePath + '/price')
  }

  async getSubscription (): Promise<Subscription> {
    return this.get(this.pluginBasePath + '/subscription')
  }

  async updateSubscription (body: { cancelAtPeriodEnd: boolean }): Promise<void> {
    return this.patch(this.pluginBasePath + '/subscription', body)
  }

  async createCheckout (
    { allowPromotionCodes, priceId }: { allowPromotionCodes?: boolean, priceId: string }
  ): Promise<{ checkoutUrl: string}> {
    return this.post(this.pluginBasePath + '/checkout', {
      allowPromotionCodes,
      priceId
    })
  }
}
