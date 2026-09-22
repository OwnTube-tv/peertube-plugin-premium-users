import sequelize, { QueryTypes } from 'sequelize'
import { PluginUserInfo } from './types'

export class Storage {
  sequelLight: Pick<sequelize.Sequelize, 'query'>

  tables = {
    premiumUsers: '"premiumUsers_premiumUsers"',
    premiumVideos: '"premiumUsers_premiumVideos"'
  }

  constructor (
    sequelLight: Pick<sequelize.Sequelize, 'query'>
  ) {
    this.sequelLight = sequelLight
  }


  init = async (): Promise<void> => {
    await this.sequelLight.query(`CREATE TABLE IF NOT EXISTS ${this.tables.premiumUsers} (
      "userId" integer NOT NUll,
      "paidUntil" varchar(256),
      "hasPaymentFailed" boolean NOT NULL DEFAULT false,
      "subscriptionId" varchar(256),
      "customerId" varchar(256),
      PRIMARY KEY ("userId")
    )`)

    const fKeyName = 'userId_user_fkey'

    const existingFkeys = await this.sequelLight.query(`
      SELECT 1 AS "fkeyCount" FROM information_schema.table_constraints
      WHERE constraint_name='${fKeyName}' AND table_name=${this.tables.premiumUsers.replaceAll('"', '\'')};
    `, {
      type: QueryTypes.SELECT
    })

    if (existingFkeys?.length === 0) {
      await this.sequelLight.query(`
        ALTER TABLE ${this.tables.premiumUsers}
        ADD CONSTRAINT
          "${fKeyName}" FOREIGN KEY ("userId")
          REFERENCES public.user(id) ON DELETE CASCADE
      `)
    }

    await this.sequelLight.query(`CREATE TABLE IF NOT EXISTS ${this.tables.premiumVideos} (
      "videoUuid" varchar(256) NOT NUll,
      PRIMARY KEY ("videoUuid")
    )`)
  }

  addPremiumVideo = async (uuid: string): Promise<void> => {
    await this.sequelLight.query(
      `INSERT INTO ${this.tables.premiumVideos} ("videoUuid") VALUES(?) ON CONFLICT DO NOTHING`,
      {
        replacements: [uuid]
      })
  }

  removePremiumVideo = async (uuid: string): Promise<void> => {
    await this.sequelLight.query(`DELETE FROM ${this.tables.premiumVideos} WHERE "videoUuid" = ?`, {
      replacements: [uuid]
    })
  }

  isPremiumVideo = async (uuid: string): Promise<boolean> => {
    const [result] = await this.sequelLight.query(
      `SELECT "videoUuid" FROM ${this.tables.premiumVideos} WHERE "videoUuid" = ?`,
      {
        replacements: [uuid],
        type: sequelize.QueryTypes.SELECT
      }
    )

    return Boolean(result)
  }

  getUserIdByEmail = async (email: string): Promise<number | undefined> => {
    const [{ id } = {}] = await this.sequelLight.query(`SELECT id FROM public.user WHERE email = ?`, {
      type: sequelize.QueryTypes.SELECT,
      replacements: [email]
    }) as { id: number }[]

    return id
  }

  getUserRole = async (userId: number): Promise<number | undefined> => {
    const [{ role } = {}] = await this.sequelLight.query(`SELECT role FROM public.user WHERE id = ?`, {
      type: sequelize.QueryTypes.SELECT,
      replacements: [userId]
    }) as { role: number }[]

    return role
  }

  getUserInfo = async (userId?: number): Promise<PluginUserInfo | undefined> => {
    if (!userId) return

    const [userInfo] = await this.sequelLight.query(`SELECT * FROM ${this.tables.premiumUsers} WHERE "userId" = ?`, {
      type: sequelize.QueryTypes.SELECT,
      replacements: [userId]
    })

    return userInfo as PluginUserInfo
  }

  storeUserInfo = async (userId: number, userInfo: PluginUserInfo): Promise<void> => {
    await this.sequelLight.query(`
      INSERT INTO ${this.tables.premiumUsers} (
        "userId",
        "paidUntil",
        "hasPaymentFailed",
        "subscriptionId",
        "customerId"
      ) VALUES (:userId, :paidUntil, :hasPaymentFailed, :subscriptionId, :customerId)
      ON CONFLICT("userId")
      DO UPDATE SET
        "paidUntil" = :paidUntil,
        "hasPaymentFailed" = :hasPaymentFailed,
        "subscriptionId" = :subscriptionId,
        "customerId" = :customerId
    `, {
      replacements: {
        userId,
        paidUntil: userInfo.paidUntil ?? null,
        hasPaymentFailed: userInfo.hasPaymentFailed ?? false,
        subscriptionId: userInfo.subscriptionId ?? null,
        customerId: userInfo.customerId ?? null
      }
    })
  }
}
