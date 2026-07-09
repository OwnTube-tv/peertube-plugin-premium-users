import { exec, spawn } from 'node:child_process';
import util from 'util'
import { readFile } from 'fs/promises'
import Stripe from 'stripe'
import {
  SETTING_ENABLE_PLUGIN,
  SETTING_REPLACEMENT_VIDEO,
  SETTING_STRIPE_API_KEY,
  SETTING_STRIPE_COUPON_ID,
  SETTING_STRIPE_PRODUCT_ID,
  SETTING_STRIPE_WEBHOOK_SECRET,
  VIDEO_FIELD_IS_PREMIUM_CONTENT
} from '../shared/constants';
import winston from 'winston';
const execAsync = util.promisify(exec);

type usedStripeResources = keyof Pick<Stripe, 'products' | 'coupons'>

interface RegisteredSettingsResponse { registeredSettings: { name: string, options: { value: string }[] }[] }
interface Video { id: number, shortUUID: string }
interface CustomEnv {
  PEERTUBE_WEBSERVER_HOSTNAME: string,
  PEERTUBE_WEBSERVER_PORT: string,
  PT_INITIAL_ROOT_PASSWORD: string,
  STRIPE_API_KEY: string
}

const { PEERTUBE_WEBSERVER_HOSTNAME,
  PEERTUBE_WEBSERVER_PORT,
  PT_INITIAL_ROOT_PASSWORD,
  STRIPE_API_KEY
} = (process.env as unknown) as CustomEnv

const PRODUCT_NAME = 'peertube_plugin_premium_users-auto_test-product'
const COUPON_NAME = 'peertube_premium_users-auto_test-coupon'
const PEERTUBE_URL = `http://${PEERTUBE_WEBSERVER_HOSTNAME}:${PEERTUBE_WEBSERVER_PORT}`

const createdStripeResources: { [P in usedStripeResources]: string[] } = {
  coupons: [],
  products: []
}
const createdVideos: string[] = []
let ptAccessToken: string
let stripe: Stripe

const logger = winston.createLogger({
  levels: winston.config.syslog.levels,
  transports: [
    new winston.transports.Console({ level: 'info' }),
    new winston.transports.File({
      filename: '/app.log',
      level: 'info'
    })
  ]
});

const startStripeListen = () => new Promise<string>((resolve, reject) => {
  logger.info('Run stripe listen...')
  const ls = spawn('stripe', [
    'listen',
    '--forward-to',
    `${PEERTUBE_URL}/plugins/premium-users/router/stripe-webhook`,
    '--api-key',
    STRIPE_API_KEY
  ]);

  ls.stdout.on('data', (data) => {
    logger.debug(`stdout: ${data}`);
  });

  ls.stderr.on('data', (data: Buffer) => {
    const strData = data.toString()
    if (strData.indexOf('Ready!') > -1) {
      const whSec = strData.split(' ').find(s => s.substring(0, 6) === 'whsec_')

      if (!whSec) {
        throw Error('Couldn\'t find any webhook secret from Stripe CLI output.')
      }

      resolve(whSec)
    }
    logger.error(`stderr: ${data}`);
  });

  ls.on('close', (code) => {
    logger.info(`child process exited with code ${code}`);
  });

  setTimeout(() => reject(new Error(`stripe listen command timed out.`)), 10000)
})

const createStripeProduct = async () => {
  const searchResult = await stripe.products.search({
    query: `name:"${PRODUCT_NAME}"`
  })

  if (searchResult.data.length > 0) {
    logger.info('Found already created product, will not create a new.')
    return
  }

  logger.info(`Create product ${PRODUCT_NAME}`)

  const product = await stripe.products.create({
    name: PRODUCT_NAME
  })

  createdStripeResources.products.push(product.id)

  await stripe.prices.create({
    unit_amount: 10000,
    currency: 'SEK',
    recurring: {
      interval: 'year'
    },
    product: product.id
  })

  await stripe.prices.create({
    unit_amount: 1000,
    currency: 'SEK',
    recurring: {
      interval: 'month'
    },
    product: product.id
  })
}

const createStripeCoupon = async () => {
  const searchResult = await stripe.coupons.list()

  if (searchResult.data.find(c => c.name === COUPON_NAME)) {
    logger.info('Found already created coupon, will not create a new.')
    return
  }
  logger.info(`Create Stripe coupon ${COUPON_NAME}`)

  const coupon = await stripe.coupons.create({
    name: COUPON_NAME,
    percent_off: 20,
    duration: 'repeating',
    duration_in_months: 3
  })

  createdStripeResources.coupons.push(coupon.id)
}

const setup = async () => {
  logger.info('Extract plugin...')
  await execAsync(
    'tar xvf peertube-plugin-premium-users-*.tgz --one-top-level=/peertube-plugin-premium-users --strip-components=1',
    { cwd: '..' }
  )

  const ptCommands = [
    `npx peertube-cli auth add -u "${PEERTUBE_URL}" -U "root" --password "${PT_INITIAL_ROOT_PASSWORD}"`,
    'npx peertube-cli plugins install --path /peertube-plugin-premium-users',
    `npx peertube-cli get-access-token --url ${PEERTUBE_URL} --username root --password "${PT_INITIAL_ROOT_PASSWORD}"`
  ]

  for (let i = 0; i < ptCommands.length; i++) {
    logger.info(`Execute ${ptCommands[i]}...`)
    const { stdout, stderr } = await execAsync(ptCommands[i])

    if (stderr) {
      logger.error(`Failed to execute command: ${stderr}`)
      throw Error(stderr)
    }

    if (i === (ptCommands.length - 1)) {
      ptAccessToken = stdout
    }
  }

  logger.info('Initiating stripe client...')
  stripe = new Stripe(STRIPE_API_KEY)
}

const ptFetch = async (path: string, { headers, ...options }: RequestInit = {}) => {
  const opts = {
    headers: {
      Authorization: 'Bearer ' + ptAccessToken,
      ...headers
    },
    ...options
  }

  const resp = await fetch(PEERTUBE_URL + '/api/v1' + path, opts)

  if (!resp.ok) {
    logger.error(`Failed to call ${path}:` + JSON.stringify({ opts, status: resp.status }, null, 2))
    throw Error(`Failed to call ${path}:` + JSON.stringify({ opts, status: resp.status }, null, 2))
  }

  try {
    return await resp.json()
  } catch (ignoreErr) {
    logger.info((opts.method || 'GET') + ' ' + path + ': Couldn\'t parse JSON response')
  }

  return
}

const uploadVideo = async (name: string, videoPath: string, privacy: number) => {
  const { videoChannels: [videoChannel] } = await ptFetch('/users/me') as { videoChannels: { id: number }[]}

  const videoFile = await readFile(videoPath)
  const formData = new FormData()
  formData.append('channelId', videoChannel.id.toString())
  formData.append('name', name)
  formData.append('privacy', privacy.toString()) // 1 = Published, 2 = Unlisted
  formData.append('waitTranscoding', 'true')
  formData.append('videofile', new File([videoFile], videoPath.split('/').pop() as string))

  const { video } = await ptFetch('/videos/upload', {
    body: formData,
    method: 'post',
  }) as { video: Video }

  return video
}

const configurePlugin = async (webhookSecret: string, replacementVideo: Video): Promise<void> => {
  const pluginSettings = {
    [SETTING_ENABLE_PLUGIN]: true,
    [SETTING_STRIPE_API_KEY]: STRIPE_API_KEY,
    [SETTING_STRIPE_WEBHOOK_SECRET]: webhookSecret,
    [SETTING_STRIPE_PRODUCT_ID]: createdStripeResources.products[0],
    [SETTING_REPLACEMENT_VIDEO]: PEERTUBE_URL + '/w/' + replacementVideo.shortUUID
  }

  logger.info('Configure plugin settings...')

  await ptFetch('/plugins/peertube-plugin-premium-users/settings', {
    headers: {
      'Content-Type': 'application/json'
    },
    method: 'PUT',
    body: JSON.stringify({
      settings: pluginSettings
    })
  })

  const { registeredSettings } =
    await ptFetch('/plugins/peertube-plugin-premium-users/registered-settings') as RegisteredSettingsResponse

  const options = registeredSettings
    .filter((s) => [SETTING_STRIPE_COUPON_ID, SETTING_STRIPE_PRODUCT_ID].includes(s.name))
    .reduce((acc, val) => ({
      ...acc,
      [val.name]: val.options
    }), {}) as { [key: string]: { value: string }[] }

  await ptFetch('/plugins/peertube-plugin-premium-users/settings', {
    headers: {
      'Content-Type': 'application/json'
    },
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        ...pluginSettings,
        [SETTING_STRIPE_COUPON_ID]: options[SETTING_STRIPE_COUPON_ID][1]?.value,
        [SETTING_STRIPE_PRODUCT_ID]: options[SETTING_STRIPE_PRODUCT_ID][0]?.value
      }
    })
  })
}

const run = async () => {
  logger.info('Upload videos...')
  const replacementVideo = await uploadVideo('Replacement video', './fixtures/replacement-video.mp4', 2)
  createdVideos.push(replacementVideo.shortUUID)
  const premiumVideo = await uploadVideo('Premium video', './fixtures/premium-video.mp4', 1)
  createdVideos.push(premiumVideo.shortUUID)

  const webhookSecret = await startStripeListen()

  await createStripeProduct()
  await createStripeCoupon()

  await configurePlugin(webhookSecret, replacementVideo)

  logger.info('Waiting for transcoding...')


  let videosTranscoded = false

  while (!videosTranscoded) {
    try {
      const finished = (await Promise.all([
        ptFetch('/videos/' + replacementVideo.shortUUID),
        ptFetch('/videos/' + premiumVideo.shortUUID),
      ]) as { state: { id: number } }[]).filter((result) => result.state.id === 1)

      videosTranscoded = finished.length > 1
    } catch (err) {
      logger.error('Failed to check transcoding status, retrying...', { err })
    }

    if (!videosTranscoded) {
      await new Promise(resolve => {
        setTimeout(resolve, 1000)
      })
    }
  }

  const video = await ptFetch('/videos/' + premiumVideo.shortUUID) as any
  const formData = new FormData()

  formData.set('name', video.name)
  formData.set('channelId', video.channel.id)
  formData.set(`pluginData[${VIDEO_FIELD_IS_PREMIUM_CONTENT}]`, 'true')

  await ptFetch('/videos/' + premiumVideo.id, {
    method: 'PUT',
    body: formData
  })

  logger.info('Premium video available at ' + PEERTUBE_URL + '/w/' + premiumVideo.shortUUID)
  logger.info('PREP_READY')
}

const cleanup = async () => {
  const types = (Object.keys(createdStripeResources) as Array<usedStripeResources>)
    .filter((t) => createdStripeResources[t].length > 0)

  for (let i = 0; i < types.length; i++) {
    const t = types[i]

    for (let j = 0; j < createdStripeResources[t].length; j++) {
      await stripe[t].del(createdStripeResources[t][j])
    }
  }

  for (let i = 0; i < createdVideos.length; i++) {
    await ptFetch('/videos/' + createdVideos[i], {
      method: 'DELETE'
    })
  }
}

(async () => {
  try {
    await setup()
    await run()
  } catch (err) {
    logger.error('Failed', { err })

    try {
      await cleanup()
    } catch (cleanupErr) {
      logger.error('Cleanup failed', { err: cleanupErr })
    }

    process.exit(1)
  }
})().catch(err => logger.error(err))

process.on('SIGINT', () => {
  cleanup().catch((err) => logger.error(err))
})